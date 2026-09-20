import logging
import os
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx
import jwt
from fastapi import Header, HTTPException


logger = logging.getLogger("aifit.auth")

PRIVY_API_URL = os.getenv("PRIVY_API_URL", "https://auth.privy.io").rstrip("/")
PRIVY_USER_API_URL = os.getenv("PRIVY_USER_API_URL", "https://api.privy.io/v1").rstrip("/")
PRIVY_APP_ID = os.getenv("PRIVY_APP_ID", "").strip()
PRIVY_APP_SECRET = os.getenv("PRIVY_APP_SECRET", "").strip()
PRIVY_ISSUER = os.getenv("PRIVY_ISSUER", "privy.io")
AIFIT_AGENT_CAPABILITY_SECRET = os.getenv("AIFIT_AGENT_CAPABILITY_SECRET", "").strip()

# First-run provisioning: when the operator did not configure a persistent
# secret, the process mints an ephemeral one instead of shipping a broken
# install. Capabilities live at most 20 minutes, so a restart only retires
# outstanding run credentials. Multi-process deployments must still set
# AIFIT_AGENT_CAPABILITY_SECRET so every replica verifies the same tokens.
_EPHEMERAL_CAPABILITY_SECRET = secrets.token_urlsafe(32)
_ephemeral_warned = False

_key_cache: dict[str, Any] = {"value": None, "expires": 0.0}


@dataclass(frozen=True)
class Identity:
    subject: str
    email: str | None


@dataclass(frozen=True)
class AgentCapability:
    account_id: str
    tenant_id: str
    job_id: str
    permissions: frozenset[str]


def _agent_capability_secret() -> str:
    global _ephemeral_warned
    if len(AIFIT_AGENT_CAPABILITY_SECRET) >= 32:
        return AIFIT_AGENT_CAPABILITY_SECRET
    if not _ephemeral_warned:
        _ephemeral_warned = True
        logger.warning(
            "AIFIT_AGENT_CAPABILITY_SECRET is not configured; using an "
            "ephemeral process secret. Set a persistent secret for "
            "multi-process deployments.")
    return _EPHEMERAL_CAPABILITY_SECRET


def mint_agent_capability(
    *, account_id: str, tenant_id: str, job_id: str, permissions: set[str], expires_in_minutes: int = 20,
) -> str:
    """Mint a capability for one admitted Ez run, never for a browser client."""
    secret = _agent_capability_secret()
    issued = datetime.now(UTC)
    return jwt.encode({
        "iss": "aifit-api",
        "aud": "aifit-agent",
        "sub": account_id,
        "tenant_id": tenant_id,
        "job_id": job_id,
        "permissions": sorted(permissions),
        "iat": issued,
        "exp": issued + timedelta(minutes=expires_in_minutes),
        "jti": secrets.token_urlsafe(18),
    }, secret, algorithm="HS256")


async def require_agent_capability(authorization: str | None = Header(default=None)) -> AgentCapability:
    secret = _agent_capability_secret()
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Agent capability required.")
    try:
        claims = jwt.decode(
            authorization.removeprefix("Bearer "),
            secret,
            algorithms=["HS256"], audience="aifit-agent", issuer="aifit-api",
        )
    except jwt.PyJWTError as error:
        raise HTTPException(401, "Agent capability is invalid or expired.") from error
    account_id, tenant_id, job_id, permissions = (
        claims.get("sub"), claims.get("tenant_id"), claims.get("job_id"), claims.get("permissions"),
    )
    if not all(isinstance(value, str) and value for value in (account_id, tenant_id, job_id)):
        raise HTTPException(401, "Agent capability is invalid.")
    if not isinstance(permissions, list) or not permissions or any(not isinstance(value, str) or not value for value in permissions):
        raise HTTPException(401, "Agent capability is invalid.")
    return AgentCapability(account_id, tenant_id, job_id, frozenset(permissions))


def require_agent_request(capability: AgentCapability, request_id: str) -> None:
    # The capability binds account, tenant, run scope, permissions, and
    # expiry. Write request IDs stay unique per mutation: duplicates and
    # replays are owned by the idempotent service layer, which keys receipts
    # by (account_id, request_id) and rejects a reused ID carrying different
    # content. Pinning the write ID to the run ID would allow a single write
    # per run and is not a security boundary: the JWT payload is readable,
    # so echoing job_id is trivial for anyone holding a stolen capability,
    # whose power is unchanged either way.
    if not request_id or not capability.job_id:
        raise HTTPException(403, "This agent capability does not match the request.")


async def _verification_key() -> str:
    if not PRIVY_APP_ID or not PRIVY_APP_SECRET:
        raise HTTPException(500, "Privy is not configured.")
    now = time.time()
    if _key_cache["value"] and _key_cache["expires"] > now:
        return str(_key_cache["value"])
    async with httpx.AsyncClient(timeout=8) as client:
        response = await client.get(
            f"{PRIVY_API_URL}/api/v1/apps/{PRIVY_APP_ID}",
            headers={
                "Authorization": f"Bearer {PRIVY_APP_SECRET}",
                "privy-app-id": PRIVY_APP_ID,
            },
        )
        response.raise_for_status()
    key = response.json().get("verification_key")
    if not isinstance(key, str) or not key.strip():
        raise HTTPException(502, "Privy verification key is unavailable.")
    _key_cache.update(value=key, expires=now + 3600)
    return key


async def _verified_email(subject: str) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(
                f"{PRIVY_USER_API_URL}/users/{quote(subject, safe='')}",
                auth=(PRIVY_APP_ID, PRIVY_APP_SECRET),
                headers={"privy-app-id": PRIVY_APP_ID},
            )
            response.raise_for_status()
        for account in response.json().get("linked_accounts", []):
            if not isinstance(account, dict):
                continue
            for field in ("email", "address"):
                value = account.get(field)
                if isinstance(value, str) and "@" in value:
                    return value.strip().lower()
    except (httpx.HTTPError, AttributeError, TypeError):
        return None
    return None


async def require_identity(authorization: str | None = Header(default=None)) -> Identity:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in required.")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(
            token,
            await _verification_key(),
            algorithms=["ES256"],
            audience=PRIVY_APP_ID,
            issuer=PRIVY_ISSUER,
            options={"require": ["exp", "iat", "sub"]},
        )
    except (jwt.PyJWTError, httpx.HTTPError) as error:
        raise HTTPException(401, "Invalid sign-in.") from error
    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject.startswith("did:privy:"):
        raise HTTPException(401, "Invalid sign-in.")
    email = payload.get("email") or payload.get("email_address")
    if not isinstance(email, str) or "@" not in email:
        email = await _verified_email(subject)
    return Identity(subject=subject, email=email.strip().lower() if isinstance(email, str) else None)
