from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4
import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from aifit_api import main
from aifit_api import ez
from aifit_api import model_policy
from aifit_api.auth import Identity

DEEPSEEK = {"cli": "codex", "model": "deepseek/deepseek-v4.1-flash", "effort": "max"}
LUNA = {"cli": "codex", "model": "gpt-5.6-luna", "effort": "max"}
JUAN = "did:privy:owner"


def configure_policy(tmp_path, monkeypatch, privileged=None):
    path = tmp_path / "model-policy.json"
    path.write_text(json.dumps({
        "privileged_subjects": [JUAN],
        "default": [DEEPSEEK],
        "privileged": privileged or [DEEPSEEK, LUNA],
    }))
    monkeypatch.setenv("AIFIT_MODEL_POLICY_FILE", str(path))
    model_policy.configured_model_policy.cache_clear()


class Turns:
    def __init__(self):
        self.rows = {}

    async def find_one_and_update(self, query, update, **_kwargs):
        key = query["_id"]
        if key not in self.rows:
            self.rows[key] = {"_id": key, **deepcopy(update["$setOnInsert"])}
        return deepcopy(self.rows[key])

    async def find_one(self, query):
        row = self.rows.get(query["_id"])
        return deepcopy(row) if row else None

    async def update_one(self, query, update):
        row = self.rows[query["_id"]]
        expected = query.get("status", {}).get("$nin")
        if expected is None or row["status"] not in expected:
            row.update(deepcopy(update["$set"]))

    async def delete_many(self, query):
        self.rows = {
            key: row for key, row in self.rows.items()
            if any(row.get(field) != value for field, value in query.items())
        }


@pytest.fixture(autouse=True)
def clear_policy_cache(monkeypatch):
    monkeypatch.delenv("AIFIT_MODEL_POLICY_FILE", raising=False)
    model_policy.configured_model_policy.cache_clear()
    yield
    model_policy.configured_model_policy.cache_clear()


@pytest.fixture
def identity():
    return Identity(subject="did:privy:test", email="test@example.com")


@pytest.mark.asyncio
async def test_retry_reuses_request_and_one_ez_run(monkeypatch, identity):
    turns = Turns()
    monkeypatch.setattr(main, "db", SimpleNamespace(chat_turns=turns))
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    submitted = []

    async def ez_call(_binding, method, path, body=None):
        if method == "POST":
            submitted.append(body)
            return {"id": "run_1"}
        return {"id": "run_1", "status": "completed", "messages": [
            {"id": "msg_1", "text": "First"}, {"id": "msg_2", "text": "Second"},
        ]}

    monkeypatch.setattr(main, "ez_call", ez_call)
    request_id = uuid4()
    body = main.ChatInput(user_id=identity.subject, request_id=request_id, message="echo test")
    first = await main.enqueue_chat(body, identity)
    second = await main.enqueue_chat(body, identity)

    assert len(submitted) == 1
    assert submitted[0]["requestId"] == str(request_id)
    assert first == second
    assert [message["id"] for message in first["messages"]] == ["msg_1", "msg_2"]


@pytest.mark.asyncio
async def test_request_id_rejects_changed_content(monkeypatch, identity):
    turns = Turns()
    monkeypatch.setattr(main, "db", SimpleNamespace(chat_turns=turns))
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))

    async def ez_call(_binding, method, _path, body=None):
        return {"id": "run_1"} if method == "POST" else {"status": "queued", "messages": []}

    monkeypatch.setattr(main, "ez_call", ez_call)
    request_id = uuid4()
    await main.enqueue_chat(main.ChatInput(user_id=identity.subject, request_id=request_id, message="original"), identity)
    with pytest.raises(HTTPException) as error:
        await main.enqueue_chat(main.ChatInput(user_id=identity.subject, request_id=request_id, message="changed"), identity)
    assert error.value.status_code == 409


def test_browser_cannot_forward_arbitrary_context_or_model():
    with pytest.raises(ValidationError):
        main.ChatInput(user_id="owner", request_id=uuid4(), message="hello", context="{}")
    with pytest.raises(ValidationError):
        main.ChatInput(user_id="owner", request_id=uuid4(), message="hello", model="fake")


def test_model_controls_are_projected_from_ez_catalog():
    projected = main.public_model_control({
        "ai": {"selectedId": "preset_1", "presets": [
            {"id": "preset_1", "name": "Grok 4.6 High", "cli": "grok", "model": "grok-4.6", "effort": "high"},
        ]},
        "models": [{"cli": "grok", "model": "grok-4.6", "name": "Grok 4.6", "efforts": ["high", "medium"]}],
        "activeSessionId": "session_1",
        "private": "must not reach the browser",
    })

    assert projected == {
        "presets": [{"id": "preset_1", "name": "Grok 4.6 High", "cli": "grok", "model": "grok-4.6", "effort": "high"}],
        "selected_id": "preset_1",
        "models": [{"cli": "grok", "model": "grok-4.6", "name": "Grok 4.6", "efforts": ["high", "medium"]}],
        "active_session_id": "session_1",
    }


def test_turn_exposes_captured_ez_preset():
    turn = {"request_id": "request_1", "status": "completed", "messages": [{"id": "message_1", "text": "done"}],
            "preset": {"id": "preset_1", "name": "Grok 4.6 High", "cli": "grok", "model": "grok-4.6", "effort": "high"}}
    assert main.public_turn(turn)["preset"] == turn["preset"]


@pytest.mark.asyncio
async def test_new_chat_rotates_ez_before_clearing_account_history(monkeypatch, identity):
    turns = Turns()
    turns.rows = {
        "mine": {"_id": "mine", "tenant_id": "ten_1"},
        "other": {"_id": "other", "tenant_id": "ten_2"},
    }
    monkeypatch.setattr(main, "db", SimpleNamespace(chat_turns=turns))
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append((method, path, body))
        return {
            "ai": {"selectedId": "preset_1", "presets": [{
                "id": "preset_1", "name": "One", "cli": "codex", "model": "one", "effort": "medium",
            }]},
            "models": [{"cli": "codex", "model": "one", "name": "One", "efforts": ["medium"]}],
            "activeSessionId": "22222222-2222-2222-2222-222222222222",
        }

    monkeypatch.setattr(main, "ez_call", ez_call)
    monkeypatch.setattr(main, "filter_control", lambda value, _subject: value)
    result = await main.clear_chat(main.NewChatInput(
        user_id=identity.subject,
        expected_session="11111111-1111-1111-1111-111111111111",
    ), identity)

    assert calls == [("POST", "/v1/control", {
        "action": "new", "expectedSession": "11111111-1111-1111-1111-111111111111",
    })]
    assert set(turns.rows) == {"other"}
    assert result["active_session_id"] == "22222222-2222-2222-2222-222222222222"


@pytest.mark.asyncio
async def test_completed_turn_backfills_missing_execution_preset(monkeypatch):
    turns = Turns()
    turn = {
        "_id": "turn_1", "request_id": "request_1", "run_id": "run_1", "binding_id": "binding_1",
        "status": "completed", "messages": [{"id": "message_1", "text": "done"}],
    }
    turns.rows[turn["_id"]] = deepcopy(turn)
    monkeypatch.setattr(main, "db", SimpleNamespace(chat_turns=turns))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    preset = {"id": "deepseek", "name": "DeepSeek Max", "cli": "codex",
              "model": "deepseek/deepseek-v4.1-flash", "effort": "max"}
    result = await main.reconcile_turn(
        {"account_id": "acc_1"}, turn,
        {"status": "completed", "messages": turn["messages"], "preset": preset},
    )
    assert result["preset"] == preset


def ez_control(selected_id, presets, models, session="session_1"):
    return {
        "ai": {"selectedId": selected_id, "presets": presets},
        "models": models,
        "activeSessionId": session,
    }


GROK_PRESET = {"id": "grok", "name": "Grok", "cli": "grok", "model": "grok-4.6", "effort": "high"}
DEEPSEEK_PRESET = {"id": "deepseek", "name": "DeepSeek", **DEEPSEEK}
LUNA_PRESET = {"id": "luna", "name": "Luna", **LUNA}
CATALOG = [
    {"cli": "grok", "model": "grok-4.6", "name": "Grok 4.6", "efforts": ["high"]},
    {"cli": "codex", "model": DEEPSEEK["model"], "name": "DeepSeek", "efforts": ["max"]},
    {"cli": "codex", "model": LUNA["model"], "name": "Luna", "efforts": ["max"]},
]


@pytest.mark.asyncio
async def test_chat_models_locks_disallowed_ez_selection(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append((method, path, body))
        if method == "GET":
            return ez_control("grok", [GROK_PRESET, DEEPSEEK_PRESET, LUNA_PRESET], CATALOG)
        assert body == {
            "action": "model", "expectedSession": "session_1",
            "cli": DEEPSEEK["cli"], "model": DEEPSEEK["model"], "effort": DEEPSEEK["effort"],
        }
        return ez_control("deepseek", [GROK_PRESET, DEEPSEEK_PRESET, LUNA_PRESET], CATALOG, "session_2")

    monkeypatch.setattr(main, "account_for", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.chat_models(identity)
    assert [item["cli"] for item in result["models"]] == ["codex"]
    assert result["selected_id"] == "deepseek"
    assert calls[0] == ("GET", "/v1/control", None)
    assert calls[1][0:2] == ("POST", "/v1/control")


@pytest.mark.asyncio
async def test_privileged_chat_models_lock_to_first_privileged_choice(tmp_path, monkeypatch):
    configure_policy(tmp_path, monkeypatch, privileged=[LUNA, DEEPSEEK])
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append(body)
        if method == "GET":
            return ez_control("grok", [GROK_PRESET, DEEPSEEK_PRESET, LUNA_PRESET], CATALOG)
        return ez_control("luna", [GROK_PRESET, DEEPSEEK_PRESET, LUNA_PRESET], CATALOG)

    monkeypatch.setattr(main, "account_for", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.chat_models(Identity(subject=JUAN, email="owner@example.com"))
    assert result["selected_id"] == "luna"
    assert calls[1]["model"] == LUNA["model"]


@pytest.mark.asyncio
async def test_new_chat_does_not_keep_a_disallowed_default(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    turns = Turns()
    turns.rows = {"mine": {"_id": "mine", "tenant_id": "ten_1"}}
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append(body)
        if body and body.get("action") == "new":
            return ez_control("grok", [GROK_PRESET, DEEPSEEK_PRESET], CATALOG[:2], "session_new")
        return ez_control("deepseek", [GROK_PRESET, DEEPSEEK_PRESET], CATALOG[:2], "session_locked")

    monkeypatch.setattr(main, "db", SimpleNamespace(chat_turns=turns))
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.clear_chat(main.NewChatInput(
        user_id=identity.subject,
        expected_session="session_old",
    ), identity)
    assert [body.get("action") for body in calls] == ["new", "model"]
    assert result["selected_id"] == "deepseek"
    assert turns.rows == {}


@pytest.mark.asyncio
async def test_enqueue_switches_off_a_disallowed_engine_before_follow_owner(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    turns = Turns()
    submitted = []

    async def ez_call(_binding, method, path, body=None):
        submitted.append((method, path, body))
        if path == "/v1/control":
            if method == "GET":
                return ez_control("grok", [GROK_PRESET, DEEPSEEK_PRESET], CATALOG[:2])
            return ez_control("deepseek", [GROK_PRESET, DEEPSEEK_PRESET], CATALOG[:2])
        if method == "POST":
            return {"id": "run_1"}
        return {"id": "run_1", "status": "completed", "messages": [{"id": "msg_1", "text": "ok"}]}

    monkeypatch.setattr(main, "db", SimpleNamespace(chat_turns=turns))
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.enqueue_chat(main.ChatInput(
        user_id=identity.subject, request_id=uuid4(), message="echo test",
    ), identity)
    assert submitted[0][0:2] == ("GET", "/v1/control")
    assert submitted[1][2]["action"] == "model"
    assert submitted[1][2]["model"] == DEEPSEEK["model"]
    assert submitted[2][1] == "/v1/runs"
    assert submitted[2][2]["followOwner"] is True
    assert result["messages"][0]["text"] == "ok"


@pytest.mark.asyncio
async def test_binding_verification_requires_owner_and_receipt(monkeypatch):
    monkeypatch.setattr(ez, "binding_for", lambda _owner: {"ownerId": "acc_1"})
    monkeypatch.setattr(ez, "call", lambda *_args: async_value({"ownerId": "another", "bindingId": "binding_1"}))
    with pytest.raises(HTTPException) as error:
        await ez.verified_binding("acc_1")
    assert error.value.status_code == 503


def async_value(value):
    async def result():
        return value
    return result()
