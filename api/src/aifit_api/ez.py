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


def binding_for(principal_id: str) -> dict:
    registry_path = os.getenv("EZ_BINDINGS_FILE", "")
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


async def verified_binding(principal_id: str) -> dict:
    """Resolve the private binding and prove it still belongs to this owner."""
    binding = binding_for(principal_id)
    if binding.get("ownerId") != principal_id:
        raise HTTPException(503, "Chat binding does not match this account.")
    registration = await call(binding, "GET", "/v1/registration")
    binding_id = registration.get("bindingId")
    if registration.get("ownerId") != principal_id or not isinstance(binding_id, str) or not binding_id:
        raise HTTPException(503, "Chat binding does not match this account.")
    return {**binding, "bindingId": binding_id}
