import json

import pytest
from fastapi import HTTPException

from aifit_api import ez


@pytest.mark.asyncio
async def test_verified_binding_rejects_a_binding_owned_by_another_principal(monkeypatch):
    binding = {
        "principalId": "acc_a",
        "ownerId": "acc_b",
        "url": "http://127.0.0.1:8000",
        "tokenFile": "/path/outside/repository/acc_b/application-token",
    }
    calls = []
    monkeypatch.setattr(ez, "binding_for", lambda _principal_id, **_kwargs: binding)

    async def unexpected_call(*args):
        calls.append(args)
        return {"ownerId": "acc_b", "bindingId": "binding_b"}

    monkeypatch.setattr(ez, "call", unexpected_call)

    with pytest.raises(HTTPException) as error:
        await ez.verified_binding("acc_a")

    assert error.value.status_code == 503
    assert calls == []


@pytest.mark.asyncio
async def test_verified_binding_accepts_a_binding_and_registration_for_the_principal(monkeypatch):
    binding = {
        "principalId": "acc_a",
        "ownerId": "acc_a",
        "url": "http://127.0.0.1:8000",
        "tokenFile": "/path/outside/repository/acc_a/application-token",
    }
    monkeypatch.setattr(ez, "binding_for", lambda _principal_id, **_kwargs: binding)

    async def registration(*_args):
        return {"ownerId": "acc_a", "bindingId": "binding_a"}

    monkeypatch.setattr(ez, "call", registration)

    assert await ez.verified_binding("acc_a") == {**binding, "bindingId": "binding_a"}


def write_registry(path, *, port, owner="acc_a"):
    binding = {
        "principalId": "acc_a", "ownerId": owner,
        "url": f"http://127.0.0.1:{port}", "tokenFile": "/private/token",
    }
    path.write_text(json.dumps({"version": 1, "bindings": [binding]}))
    path.chmod(0o600)
    return binding


@pytest.mark.asyncio
async def test_telegram_uses_canonical_binding_while_web_chat_stays_local(tmp_path, monkeypatch):
    local_path, telegram_path = tmp_path / "local.json", tmp_path / "telegram.json"
    local = write_registry(local_path, port=8793)
    telegram = write_registry(telegram_path, port=18793)
    monkeypatch.setenv("EZ_BINDINGS_FILE", str(local_path))
    monkeypatch.setenv("EZ_TELEGRAM_BINDINGS_FILE", str(telegram_path))
    calls = []

    async def registration(binding, method, path):
        calls.append((binding, method, path))
        return {"ownerId": "acc_a", "bindingId": "binding_a"}

    monkeypatch.setattr(ez, "call", registration)
    assert await ez.verified_binding("acc_a") == {**local, "bindingId": "binding_a"}
    assert await ez.verified_binding("acc_a", telegram=True) == {**telegram, "bindingId": "binding_a"}
    assert calls == [(local, "GET", "/v1/registration"), (telegram, "GET", "/v1/registration")]


@pytest.mark.parametrize("override", [None, "", "  "])
def test_telegram_defaults_to_normal_binding(tmp_path, monkeypatch, override):
    path = tmp_path / "local.json"
    binding = write_registry(path, port=8793)
    monkeypatch.setenv("EZ_BINDINGS_FILE", str(path))
    monkeypatch.delenv("EZ_TELEGRAM_BINDINGS_FILE", raising=False)
    if override is not None:
        monkeypatch.setenv("EZ_TELEGRAM_BINDINGS_FILE", override)
    assert ez.binding_for("acc_a", telegram=True) == binding


@pytest.mark.asyncio
@pytest.mark.parametrize("wrong_owner", ["registry", "relay"])
async def test_telegram_override_still_requires_matching_owner(tmp_path, monkeypatch, wrong_owner):
    path = tmp_path / "telegram.json"
    write_registry(path, port=18793, owner="acc_b" if wrong_owner == "registry" else "acc_a")
    monkeypatch.setenv("EZ_TELEGRAM_BINDINGS_FILE", str(path))

    async def registration(*_args):
        assert wrong_owner == "relay"  # Reject bad local ownership before contacting the relay.
        return {"ownerId": "acc_b", "bindingId": "binding_b"}

    monkeypatch.setattr(ez, "call", registration)
    with pytest.raises(HTTPException) as error:
        await ez.verified_binding("acc_a", telegram=True)
    assert error.value.status_code == 503


def test_broken_telegram_override_does_not_fall_back_to_local_pairing(tmp_path, monkeypatch):
    local_path = tmp_path / "local.json"
    write_registry(local_path, port=8793)
    monkeypatch.setenv("EZ_BINDINGS_FILE", str(local_path))
    monkeypatch.setenv("EZ_TELEGRAM_BINDINGS_FILE", str(tmp_path / "missing.json"))
    with pytest.raises(HTTPException) as error:
        ez.binding_for("acc_a", telegram=True)
    assert error.value.status_code == 503
