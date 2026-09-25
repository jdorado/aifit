import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException


def _private_text(path_value: str) -> str:
    path = Path(path_value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("Secret path must be an absolute regular file")
    if path.stat().st_mode & 0o077:
        raise ValueError("Secret file must be owner-only")
    return path.read_text().strip()


def _absolute_regular_file(path_value: str) -> Path:
    path = Path(path_value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("Path must be an absolute regular file")
    return path


def binding_for(principal_id: str, *, telegram: bool = False) -> dict:
    registry_path = os.getenv("EZ_BINDINGS_FILE", "")
    if telegram:
        registry_path = os.getenv("EZ_TELEGRAM_BINDINGS_FILE", "").strip() or registry_path
    try:
        registry = json.loads(_private_text(registry_path))
        if registry.get("version") != 1 or not isinstance(registry.get("bindings"), list):
            raise ValueError("Invalid binding registry")
        binding = next(
            item for item in registry["bindings"]
            if item.get("principalId") == principal_id and not item.get("revoked")
        )
        parsed = urlparse(binding["url"])
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
            raise ValueError("Local development Ez endpoint required")
        if not Path(binding["tokenFile"]).is_absolute():
            raise ValueError("Absolute token file required")
        return binding
    except (OSError, ValueError, KeyError, StopIteration, TypeError) as error:
        raise HTTPException(503, "Chat is not connected for this account.") from error


async def call(binding: dict, method: str, path: str, body: dict | None = None) -> dict:
    try:
        token = _private_text(binding["tokenFile"])
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.request(
                method,
                binding["url"].rstrip("/") + path,
                headers={"Authorization": f"Bearer {token}"},
                json=body,
            )
        if response.status_code == 404:
            raise HTTPException(404, "Ez run not found.")
        if response.status_code == 409:
            raise HTTPException(409, "The request key already has different content.")
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict):
            raise ValueError("Ez response must be an object")
        return result
    except HTTPException:
        raise
    except (OSError, ValueError, httpx.HTTPError) as error:
        raise HTTPException(503, "Ez is unavailable.") from error


async def verified_binding(principal_id: str, *, telegram: bool = False) -> dict:
    """Resolve the private binding and prove it still belongs to this owner."""
    binding = binding_for(principal_id, telegram=telegram)
    if binding.get("ownerId") != principal_id:
        raise HTTPException(503, "Chat binding does not match this account.")
    registration = await call(binding, "GET", "/v1/registration")
    binding_id = registration.get("bindingId")
    if registration.get("ownerId") != principal_id or not isinstance(binding_id, str) or not binding_id:
        raise HTTPException(503, "Chat binding does not match this account.")
    return {**binding, "bindingId": binding_id}


async def speech(binding: dict, run_id: str, language: str = "en") -> bytes:
    """Render an existing Ez reply; text and provider credentials stay with Ez."""
    try:
        async with httpx.AsyncClient(timeout=75) as client:
            response = await client.post(
                binding["url"].rstrip("/") + f"/v1/runs/{run_id}/speech",
                headers={"Authorization": f"Bearer {_private_text(binding['tokenFile'])}"},
                json={"language": language},
            )
        if response.status_code == 404:
            raise HTTPException(503, "Audio coaching needs an Ez update.")
        if response.status_code == 503:
            try:
                speech_error = response.json()
            except ValueError:
                speech_error = {}
            if speech_error.get("code") == "speech_credits_depleted":
                raise HTTPException(503, {"code": "speech_credits_depleted", "message": "Gemini speech credits are depleted."})
            raise HTTPException(503, "Audio coaching is not configured yet.")
        response.raise_for_status()
        audio = response.content
        if (response.headers.get("content-type") != "audio/wav" or
                len(audio) < 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE"):
            raise ValueError("Invalid Ez speech response")
        return audio
    except (OSError, ValueError, httpx.HTTPError) as error:
        raise HTTPException(502, "Could not create coaching audio. Try again.") from error


def telegram_provisioning_configured(binding: dict) -> bool:
    try:
        setup = binding["telegramProvisioning"]
        if not isinstance(setup, dict) or set(setup) != {"command", "configFile"}:
            return False
        command = _absolute_regular_file(setup["command"])
        config = _absolute_regular_file(setup["configFile"])
        return bool(os.access(command, os.X_OK) and not (config.stat().st_mode & 0o077))
    except (KeyError, OSError, TypeError, ValueError):
        return False


async def provision_telegram(binding: dict, bot_token: str) -> None:
    if not telegram_provisioning_configured(binding):
        raise HTTPException(503, "Telegram setup is not available for this agent.")
    setup = binding["telegramProvisioning"]
    try:
        process = await asyncio.create_subprocess_exec(
            setup["command"], "--config", setup["configFile"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.communicate(bot_token.encode()), timeout=90)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise HTTPException(503, "Telegram setup timed out.")
        if process.returncode != 0:
            raise HTTPException(422, "Telegram could not verify that bot. Check its token and try again.")
    except HTTPException:
        raise
    except (OSError, TypeError) as error:
        raise HTTPException(503, "Telegram setup is unavailable for this agent.") from error
