import asyncio
import json

import httpx
import pytest

from aifit_api import telegram_admit


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://relay.test")


async def _find_account(principal):
    if principal == "acc_one":
        return {"account_id": "acc_one", "tenant_id": "ten_one"}
    return None


def _build_context(account, run_id):
    return {"plugins": {"aifit": {"api_base_url": "http://aifit-api:8100",
                                  "capability": f"cap-{account['account_id']}-{run_id}"}}}


BINDINGS = [{"principalId": "acc_one", "ownerId": "acc_one",
             "url": "http://relay.test", "tokenFile": "/tmp/test-token-does-not-matter"}]


def test_poll_skips_non_telegram_entries_and_unknown_accounts(tmp_path, monkeypatch):
    token_file = tmp_path / "token"
    token_file.write_text("secret-token")
    token_file.chmod(0o600)
    bindings = [dict(BINDINGS[0], tokenFile=str(token_file)),
                dict(BINDINGS[0], principalId="acc_missing", tokenFile=str(token_file))]
    seen = []

    async def handler(request):
        if request.method == "GET" and request.url.path == "/v1/runs":
            return httpx.Response(200, json={"runs": [
                {"id": "r_app_x", "scope": "chat", "status": "running"},
                {"id": "tg_1", "scope": "telegram", "status": "completed", "telegramUserId": 42},
            ]})
        return httpx.Response(404, json={"error": "nope"})

    async def attach_check():
        async with _client(handler) as client:
            stats = await telegram_admit.poll_once(
                client, bindings, _find_account, _build_context, set())
        return stats

    # Both bindings list the same run (per-binding sweep); acc_missing has
    # no account so nothing attaches, and the completed tg_1 is listed but
    # the relay itself would reject attaching a finished run.
    stats = asyncio.run(attach_check())
    assert stats["runs_seen"] == 2
    assert stats["admitted"] == 0


def test_poll_attaches_capability_context_with_run_scope(tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("secret-token")
    token_file.chmod(0o600)
    bindings = [dict(BINDINGS[0], tokenFile=str(token_file))]
    posted = []

    async def handler(request):
        if request.url.path == "/v1/runs":
            return httpx.Response(200, json={"runs": [
                {"id": "tg_9", "scope": "telegram", "status": "running", "telegramUserId": 42},
            ]})
        posted.append((str(request.url), json.loads(request.content)))
        return httpx.Response(200, json={"id": "tg_9", "scope": "telegram", "status": "running"})

    async def run():
        async with _client(handler) as client:
            admitted = set()
            first = await telegram_admit.poll_once(
                client, bindings, _find_account, _build_context, admitted)
            second = await telegram_admit.poll_once(
                client, bindings, _find_account, _build_context, admitted)
        return first, second

    first, second = asyncio.run(run())
    assert first["admitted"] == 1
    assert second["skipped"] == 1 and second["admitted"] == 0
    assert len(posted) == 1
    url, body = posted[0]
    assert url.endswith("/v1/runs/tg_9/application")
    assert body["scope"] == "telegram"
    plugin = body["context"]["plugins"]["aifit"]
    assert plugin["api_base_url"] == "http://aifit-api:8100"
    assert plugin["capability"] == "cap-acc_one-tg_9"


def test_poll_treats_conflict_as_already_admitted_and_tolerates_errors(tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("secret-token")
    token_file.chmod(0o600)
    bindings = [dict(BINDINGS[0], tokenFile=str(token_file))]

    async def conflict(request):
        if request.url.path == "/v1/runs":
            return httpx.Response(200, json={"runs": [
                {"id": "tg_7", "scope": "telegram", "status": "running"},
            ]})
        return httpx.Response(409, json={"error": "conflict"})

    async def broken(request):
        raise httpx.ConnectError("down")

    async def run():
        async with _client(conflict) as client:
            admitted = set()
            first = await telegram_admit.poll_once(
                client, bindings, _find_account, _build_context, admitted)
        async with _client(broken) as client:
            failed = await telegram_admit.poll_once(
                client, bindings, _find_account, _build_context, set())
        return first, failed

    first, failed = asyncio.run(run())
    assert first["skipped"] == 1 and first["errors"] == 0
    assert failed["errors"] == 1


def test_admit_disabled_by_default(monkeypatch):
    monkeypatch.delenv("AIFIT_TELEGRAM_ADMIT", raising=False)
    assert telegram_admit.admit_enabled() is False
    monkeypatch.setenv("AIFIT_TELEGRAM_ADMIT", "1")
    assert telegram_admit.admit_enabled() is True


def test_revoked_and_tokenless_bindings_are_ignored():
    assert asyncio.run(telegram_admit.poll_once(
        None, [{"principalId": "acc_one", "revoked": True}], _find_account,
        _build_context, set())) == {"runs_seen": 0, "admitted": 0, "skipped": 0, "errors": 0}
