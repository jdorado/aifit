import pytest
import httpx
from fastapi import HTTPException

from aifit_api import main
from aifit_api import ez
from aifit_api.auth import Identity


@pytest.mark.asyncio
@pytest.mark.parametrize("link,run_link,allowed", [
    (None, None, True), ("coach-a", "coach-a", True),
    (None, "coach-a", False), ("coach-a", None, False), ("coach-a", "coach-b", False),
])
async def test_speech_is_scoped_to_the_authenticated_coach(monkeypatch, link, run_link, allowed):
    accounts, speech_calls = [], []

    async def account(identity, user_id, act_as):
        accounts.append(act_as)
        return {"account_id": "trainee"}

    async def binding(account_id):
        assert account_id == "trainee"
        return {"bindingId": "tenant"}

    async def snapshot(*args):
        return {"scope": main.chat_run_scope(main.MINI_CHAT_SCOPE, run_link)}

    async def speech(bound, job_id, language):
        speech_calls.append((bound, job_id, language))
        return b"audio"

    monkeypatch.setattr(main, "chat_account", account)
    monkeypatch.setattr(main, "verified_binding", binding)
    monkeypatch.setattr(main, "ez_call", snapshot)
    monkeypatch.setattr(main, "ez_speech", speech)
    job_id = "r_app_" + "a" * 64
    if allowed:
        response = await main.chat_speech(job_id, "owner", Identity(subject="owner", email=None), "es", link)
        assert response.body == b"audio"
        assert response.headers["cache-control"] == "no-store"
        assert len(speech_calls) == 1
        assert speech_calls[0][2] == "es"
        assert accounts == [link, link]
    else:
        with pytest.raises(HTTPException) as error:
            await main.chat_speech(job_id, "owner", Identity(subject="owner", email=None), "es", link)
        assert error.value.status_code == 404
        assert not speech_calls


@pytest.mark.asyncio
async def test_speech_reports_depleted_credits_and_forwards_language(monkeypatch):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(503, json={"code": "speech_credits_depleted"})

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(ez.httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs))
    monkeypatch.setattr(ez, "_private_text", lambda _: "test-token")

    with pytest.raises(HTTPException) as error:
        await ez.speech({"url": "http://127.0.0.1:8793", "tokenFile": "/unused"}, "r_app_fixture", "es")

    assert error.value.status_code == 503
    assert error.value.detail["code"] == "speech_credits_depleted"
    assert requests[0].content == b'{"language":"es"}'
