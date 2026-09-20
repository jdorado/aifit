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
    monkeypatch.setattr(ez, "binding_for", lambda _principal_id: binding)

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
    monkeypatch.setattr(ez, "binding_for", lambda _principal_id: binding)

    async def registration(*_args):
        return {"ownerId": "acc_a", "bindingId": "binding_a"}

    monkeypatch.setattr(ez, "call", registration)

    assert await ez.verified_binding("acc_a") == {**binding, "bindingId": "binding_a"}
