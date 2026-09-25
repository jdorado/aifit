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
    async def telegram_binding(account_id, *, telegram=False):
        assert account_id == "acc_1"
        assert telegram is True
        return {"bindingId": "binding_1"}

    monkeypatch.setattr(main, "verified_binding", telegram_binding)
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
async def test_saved_telegram_link_survives_disabled_polling(monkeypatch):
    monkeypatch.setattr(main, "account_for", lambda _identity: value({"account_id": "acc_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda _account_id, **_kwargs: value({"bindingId": "binding_1"}))

    async def degraded(*_args):
        return {"connected": True, "ready": False}

    monkeypatch.setattr(main, "ez_call", degraded)
    assert await main.get_telegram_connection(IDENTITY) == {"state": "connected"}


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 404, 503])
async def test_telegram_read_failure_never_asks_for_a_new_bot(monkeypatch, status):
    monkeypatch.setattr(main, "account_for", lambda _identity: value({"account_id": "acc_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda _account_id, **_kwargs: value({
        "bindingId": "binding_1",
        "telegramProvisioning": {"command": "/private/provision", "configFile": "/private/config"},
    }))

    async def degraded(*_args):
        raise HTTPException(status, "Ez is unavailable.")

    monkeypatch.setattr(main, "ez_call", degraded)
    with pytest.raises(HTTPException) as error:
        await main.get_telegram_connection(IDENTITY)
    assert error.value.status_code == status


@pytest.mark.asyncio
async def test_unavailable_telegram_is_not_reported_as_a_disconnected_account(monkeypatch):
    monkeypatch.setattr(main, "account_for", lambda _identity: value({"account_id": "acc_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda _account_id, **_kwargs: value({"bindingId": "binding_1"}))

    async def unavailable(*_args):
        raise HTTPException(400, "Telegram connection is unavailable")

    monkeypatch.setattr(main, "ez_call", unavailable)
    with pytest.raises(HTTPException) as error:
        await main.create_telegram_connection(IDENTITY)
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_bot_token_is_provisioned_only_to_the_bound_ez_agent(monkeypatch):
    binding = {"bindingId": "binding_1", "telegramProvisioning": {"command": "/private/provision", "configFile": "/private/config"}}
    monkeypatch.setattr(main, "account_for", lambda _identity: value({"account_id": "acc_1"}))
    async def telegram_binding(account_id, *, telegram=False):
        assert account_id == "acc_1"
        assert telegram is True
        return binding

    monkeypatch.setattr(main, "verified_binding", telegram_binding)
    provisioned = []

    async def provision(bound, bot_token):
        provisioned.append((bound, bot_token))

    async def ez_call(bound, method, path):
        assert bound is binding
        assert (method, path) == ("POST", "/v1/telegram/link")
        return {
            "connected": False,
            "url": "https://t.me/aifit_agent?start=" + "a" * 43,
            "expiresAt": "2026-09-18T12:00:00Z",
        }

    monkeypatch.setattr(main, "provision_telegram", provision)
    monkeypatch.setattr(main, "ez_call", ez_call)
    body = main.TelegramBotInput(bot_token="123456:" + "a" * 20)
    assert await main.configure_telegram_bot(body, IDENTITY) == {
        "state": "link",
        "connect_url": "https://t.me/aifit_agent?start=" + "a" * 43,
        "expires_at": "2026-09-18T12:00:00Z",
    }
    assert provisioned == [(binding, body.bot_token)]


@pytest.mark.parametrize("ready", [None, "false", 0])
def test_saved_telegram_link_still_rejects_invalid_readiness(ready):
    with pytest.raises(HTTPException) as error:
        main.public_telegram_connection({"connected": True, "ready": ready})
    assert error.value.status_code == 502
