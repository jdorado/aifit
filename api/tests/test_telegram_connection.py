import pytest
from fastapi import HTTPException

from aifit_api import main
from aifit_api.auth import Identity


IDENTITY = Identity(subject="did:privy:owner", email="owner@example.com")


async def value(result):
    return result


@pytest.mark.asyncio
async def test_telegram_connection_is_projected_from_the_bound_ez_agent(monkeypatch):
    monkeypatch.setattr(main, "account_for", lambda _identity: value({"account_id": "acc_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda _account_id: value({"bindingId": "binding_1"}))
    calls = []

    async def ez_call(binding, method, path):
        calls.append((binding, method, path))
        if method == "GET":
            return {"connected": False, "ready": True}
        return {
            "connected": False,
            "url": "https://t.me/aifit_agent?start=" + "a" * 43,
            "expiresAt": "2026-09-18T12:00:00Z",
        }

    monkeypatch.setattr(main, "ez_call", ez_call)
    assert await main.get_telegram_connection(IDENTITY) == {"state": "ready"}
    assert await main.create_telegram_connection(IDENTITY) == {
        "state": "link",
        "connect_url": "https://t.me/aifit_agent?start=" + "a" * 43,
        "expires_at": "2026-09-18T12:00:00Z",
    }
    assert calls == [
        ({"bindingId": "binding_1"}, "GET", "/v1/telegram"),
        ({"bindingId": "binding_1"}, "POST", "/v1/telegram/link"),
    ]


def test_telegram_connection_rejects_a_non_ez_launch_url():
    with pytest.raises(HTTPException) as error:
        main.public_telegram_connection({
            "connected": False,
            "url": "https://example.com/?start=" + "a" * 43,
            "expiresAt": "2026-09-18T12:00:00Z",
        }, needs_link=True)
    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_degraded_telegram_receipt_is_reported_as_a_bad_gateway(monkeypatch):
    monkeypatch.setattr(main, "account_for", lambda _identity: value({"account_id": "acc_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda _account_id: value({"bindingId": "binding_1"}))

    async def degraded(*_args):
        return {"connected": True, "ready": False}

    monkeypatch.setattr(main, "ez_call", degraded)
    with pytest.raises(HTTPException) as error:
        await main.get_telegram_connection(IDENTITY)
    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_unavailable_telegram_is_not_reported_as_a_disconnected_account(monkeypatch):
    monkeypatch.setattr(main, "account_for", lambda _identity: value({"account_id": "acc_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda _account_id: value({"bindingId": "binding_1"}))

    async def unavailable(*_args):
        raise HTTPException(400, "Telegram connection is unavailable")

    monkeypatch.setattr(main, "ez_call", unavailable)
    with pytest.raises(HTTPException) as error:
        await main.create_telegram_connection(IDENTITY)
    assert error.value.status_code == 409
