"""Admit linked-owner Telegram turns so their relay runs carry the AIFit plugin context.

Web chat and mini-chat runs receive their scoped capability at admission
time inside the API. Telegram turns reach the relay directly, so without
this bridge their runs execute with no plugin context and every AIFit write
refuses with "no scoped application context".

The bridge polls each bound relay's application channel for Telegram-intake
runs and attaches the same run-scoped capability web chat would have
minted (same account, permissions, and expiry; job scope is the relay run
id). The relay enforces the rest: only shareTelegram bindings see Telegram
intake, only the linked owner's sender is admittable, finished runs are
rejected, and already-admitted context is never replaced. Plugin commands
resolve the context lazily per invocation, so attaching mid-run takes
effect for subsequent writes without restarting or duplicating the turn.

Runs entirely on server-owned data: relay bindings from EZ_BINDINGS_FILE,
accounts from the API database, capabilities minted with the configured
secret. Nothing is accepted from browsers, chats, or workspaces.
"""

import asyncio
import json
import logging
import os
from pathlib import Path

import httpx

logger = logging.getLogger("aifit.telegram_admit")

ADMIT_PERMISSIONS = frozenset({"blueprints:write", "workouts:swap", "workouts:override"})


def admit_enabled() -> bool:
    return os.getenv("AIFIT_TELEGRAM_ADMIT", "0").strip() == "1"


def poll_seconds(default: int = 15) -> int:
    try:
        return max(5, int(os.getenv("AIFIT_TELEGRAM_ADMIT_POLL_SECONDS", str(default))))
    except ValueError:
        return default


def _read_token(token_file: str) -> str:
    path = Path(token_file)
    if not path.is_absolute():
        raise ValueError("Absolute token file required")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Token file missing")
    if path.stat().st_mode & 0o077:
        raise ValueError("Token file must be owner-only")
    return path.read_text().strip()


def _bindings() -> list[dict]:
    registry_path = os.getenv("EZ_BINDINGS_FILE", "")
    try:
        registry = json.loads(Path(registry_path).read_text())
    except (OSError, ValueError):
        return []
    if registry.get("version") != 1 or not isinstance(registry.get("bindings"), list):
        return []
    return [item for item in registry["bindings"]
            if isinstance(item, dict) and not item.get("revoked")]


async def poll_once(
    client: httpx.AsyncClient,
    bindings: list[dict],
    find_account,
    build_context,
    admitted: set,
) -> dict:
    """One admission sweep. Returns counts; never raises."""
    stats = {"runs_seen": 0, "admitted": 0, "skipped": 0, "errors": 0}
    for binding in bindings:
        url = str(binding.get("url", "")).rstrip("/")
        token_file = binding.get("tokenFile", "")
        principal = binding.get("principalId") or binding.get("ownerId")
        if not url or not token_file or not principal:
            continue
        try:
            token = _read_token(token_file)
            response = await client.get(
                f"{url}/v1/runs", headers={"Authorization": f"Bearer {token}"})
        except (OSError, ValueError, httpx.HTTPError) as error:
            logger.warning("telegram admit list failed: %s", error)
            stats["errors"] += 1
            continue
        if response.status_code != 200:
            logger.warning("telegram admit list status %s: %s",
                           response.status_code, response.text[:300])
            stats["errors"] += 1
            continue
        try:
            entries = response.json().get("runs", [])
        except ValueError:
            stats["errors"] += 1
            continue
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("scope") != "telegram":
                continue
            run_id = entry.get("id")
            if not run_id or not isinstance(run_id, str):
                continue
            stats["runs_seen"] += 1
            if (principal, run_id) in admitted:
                stats["skipped"] += 1
                continue
            try:
                account = await find_account(principal)
                if not account:
                    continue
                context = build_context(account, run_id)
                if not context:
                    continue
                attach = await client.post(
                    f"{url}/v1/runs/{run_id}/application",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"scope": "telegram", "context": context},
                )
            except (OSError, ValueError, httpx.HTTPError) as error:
                logger.warning("telegram admit attach failed: %s", error)
                stats["errors"] += 1
                continue
            if attach.status_code in (200, 409):
                admitted.add((principal, run_id))
                if attach.status_code == 200:
                    stats["admitted"] += 1
                    logger.info("admitted telegram run %s", run_id)
                else:
                    stats["skipped"] += 1
            else:
                logger.warning("telegram admit attach status %s", attach.status_code)
                stats["errors"] += 1
    return stats


async def run_forever(stop: asyncio.Event) -> None:
    """Background admission loop. Exits on stop; never raises out."""
    from . import main as app_main

    admitted: set = set()
    while not stop.is_set():
        try:
            accounts = app_main.db.accounts

            async def find_account(principal: str):
                return await accounts.find_one({"account_id": principal})

            def build_context(account: dict, run_id: str):
                return app_main.agent_run_context(account, run_id)

            async with httpx.AsyncClient(timeout=15) as client:
                await poll_once(client, _bindings(), find_account, build_context, admitted)
        except Exception as error:  # never break the API process on bridge trouble
            logger.warning("telegram admit sweep failed: %s", error)
        try:
            await asyncio.wait_for(stop.wait(), timeout=poll_seconds())
        except asyncio.TimeoutError:
            continue
