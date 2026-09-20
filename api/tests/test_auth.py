import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import HTTPException

from aifit_api import auth


def _token(claims: dict, key) -> str:
    return jwt.encode(claims, key, algorithm="ES256")


@pytest.fixture
def privy_key(monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    monkeypatch.setattr(auth, "PRIVY_APP_ID", "test-app")
    monkeypatch.setattr(auth, "PRIVY_APP_SECRET", "test-secret")
    async def verification_key() -> str:
        return pem
    monkeypatch.setattr(auth, "_verification_key", verification_key)
    return key


def _claims(**overrides) -> dict:
    now = int(time.time())
    return {
        "sub": "did:privy:owner",
        "email": "owner@example.com",
        "iss": "privy.io",
        "aud": "test-app",
        "iat": now,
        "exp": now + 60,
        **overrides,
    }


@pytest.mark.asyncio
async def test_privy_token_returns_real_subject(privy_key):
    identity = await auth.require_identity(f"Bearer {_token(_claims(), privy_key)}")
    assert identity.subject == "did:privy:owner"


@pytest.mark.asyncio
async def test_non_privy_subject_is_rejected(privy_key):
    token = _token(_claims(sub="dev:aifit-local"), privy_key)
    with pytest.raises(HTTPException) as error:
        await auth.require_identity(f"Bearer {token}")
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_wrong_audience_is_rejected(privy_key):
    token = _token(_claims(aud="another-app"), privy_key)
    with pytest.raises(HTTPException) as error:
        await auth.require_identity(f"Bearer {token}")
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_missing_bearer_is_rejected():
    with pytest.raises(HTTPException) as error:
        await auth.require_identity(None)
    assert error.value.status_code == 401


@pytest.mark.parametrize("request_id", [
    "job_1",
    "blueprint-2026-09-21-a",
    "override-2026-09-21-b",
    "swap-2026-09-21-c",
])
def test_agent_write_accepts_unique_per_write_request_ids(request_id):
    capability = auth.AgentCapability(
        "acc_1", "tenant_1", "job_1",
        frozenset({"blueprints:write", "workouts:override", "workouts:swap"}),
    )

    assert auth.require_agent_request(capability, request_id) is None


def test_agent_write_rejects_missing_run_scope():
    capability = auth.AgentCapability(
        "acc_1", "tenant_1", "",
        frozenset({"blueprints:write"}),
    )

    with pytest.raises(HTTPException) as error:
        auth.require_agent_request(capability, "blueprint-2026-09-21-a")
    assert error.value.status_code == 403


def test_capability_secret_falls_back_to_ephemeral_process_secret(monkeypatch):
    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", "")
    monkeypatch.setattr(auth, "_ephemeral_warned", True)

    first = auth._agent_capability_secret()
    assert len(first) >= 32
    assert auth._agent_capability_secret() == first
