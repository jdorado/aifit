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
async def test_enqueue_sends_untouched_text_and_slim_scope_only(monkeypatch, identity):
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "agent_run_context", lambda _account, _job: {"plugins": {"aifit": {"cap": "c"}}})
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
    body = main.ChatInput(user_id=identity.subject, request_id=request_id, message="echo test",
                          reference_date="2026-09-20", exercise_id="wex_1",
                          expected_revision="rev_0123456789abcdef0123456789abcdef")
    result = await main.enqueue_chat(body, identity)

    assert len(submitted) == 1
    admission = submitted[0]
    assert admission["requestId"] == str(request_id)
    assert admission["text"] == "echo test"
    assert "[Selected day" not in admission["text"]
    assert admission["context"]["referenceDate"] == "2026-09-20"
    assert admission["context"]["exerciseId"] == "wex_1"
    assert admission["context"]["expectedRevision"] == "rev_0123456789abcdef0123456789abcdef"
    assert "aifit" not in admission["context"]
    assert admission["context"]["plugins"] == {"aifit": {"cap": "c"}}
    assert result["job_id"] == "run_1"
    assert result["request_id"] == str(request_id)
    assert [message["id"] for message in result["messages"]] == ["msg_1", "msg_2"]


@pytest.mark.asyncio
async def test_enqueue_forwards_canonical_workout_and_instance_refs(monkeypatch, identity):
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    submitted = []

    async def ez_call(_binding, method, path, body=None):
        submitted.append((method, path, body))
        if method == "POST":
            return {"id": "run_1"}
        return {"id": "run_1", "status": "completed", "messages": [{"id": "msg_1", "text": "ok"}]}

    monkeypatch.setattr(main, "ez_call", ez_call)
    await main.enqueue_chat(main.ChatInput(
        user_id=identity.subject, request_id=uuid4(), message="explain form",
        scope="owner-minichat", scope_id="coach:session:wex_1",
        workout_id="wrk_0123456789abcdef0123456789abcdef",
        exercise_instance_id="wex_0123456789abcdef0123456789abcdef",
    ), identity)
    admission = submitted[0][2]
    assert admission["scope"] == "owner-minichat"
    assert admission["context"]["workoutId"] == "wrk_0123456789abcdef0123456789abcdef"
    assert admission["context"]["exerciseInstanceId"] == "wex_0123456789abcdef0123456789abcdef"


@pytest.mark.asyncio
async def test_enqueue_propagates_ez_request_key_conflict(monkeypatch, identity):
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))

    async def ez_call(_binding, method, _path, body=None):
        raise HTTPException(409, "The request key already has different content.")

    monkeypatch.setattr(main, "ez_call", ez_call)
    with pytest.raises(HTTPException) as error:
        await main.enqueue_chat(main.ChatInput(user_id=identity.subject, request_id=uuid4(), message="hi"), identity)
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


def test_snapshot_maps_preset_without_a_turn_store():
    snapshot = {"status": "completed", "messages": [{"id": "message_1", "text": "done"}],
                "preset": {"id": "preset_1", "name": "Grok 4.6 High", "cli": "grok", "model": "grok-4.6", "effort": "high"}}
    assert main.public_turn_from_snapshot("run_1", "request_1", snapshot)["preset"] == snapshot["preset"]


@pytest.mark.asyncio
async def test_clear_chat_is_a_single_thin_new_session(monkeypatch, identity):
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
    assert result["active_session_id"] == "22222222-2222-2222-2222-222222222222"


def test_provider_is_projected_only_when_ez_supplies_it():
    projected = main.public_model_control({
        "ai": {"selectedId": "deepseek", "presets": [{**DEEPSEEK_PRESET, "provider": "openrouter"}]},
        "models": [{"cli": "codex", "provider": "openrouter", "model": DEEPSEEK["model"],
                    "name": "DeepSeek", "efforts": ["max"]}],
        "activeSessionId": "session_1",
    })

    assert projected["presets"][0]["cli"] == "codex"
    assert projected["presets"][0]["provider"] == "openrouter"
    assert projected["models"][0]["provider"] == "openrouter"

    without_provider = main.public_model_control({
        "ai": {"selectedId": "deepseek", "presets": [DEEPSEEK_PRESET]},
        "models": [{"cli": "codex", "model": DEEPSEEK["model"], "name": "DeepSeek", "efforts": ["max"]}],
        "activeSessionId": "session_1",
    })

    assert "provider" not in without_provider["presets"][0]
    assert "provider" not in without_provider["models"][0]


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
async def test_chat_models_filters_without_auto_select(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append((method, path, body))
        return ez_control("grok", [GROK_PRESET, DEEPSEEK_PRESET, LUNA_PRESET], CATALOG)

    monkeypatch.setattr(main, "account_for", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.chat_models(identity)
    assert [item["cli"] for item in result["models"]] == ["codex"]
    assert result["selected_id"] == ""
    assert calls == [("GET", "/v1/control", None)]


@pytest.mark.asyncio
async def test_model_selection_forwards_only_the_engine_declared_provider(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append((method, path, body))
        return ez_control("deepseek", [DEEPSEEK_PRESET], CATALOG[:2], "session_selected")

    monkeypatch.setattr(main, "account_for", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)

    await main.select_chat_model(main.ModelSelectionInput(
        expected_session="session_old", cli=DEEPSEEK["cli"], provider="openrouter",
        model=DEEPSEEK["model"], effort=DEEPSEEK["effort"],
    ), identity)
    assert calls == [("POST", "/v1/control", {
        "action": "model", "expectedSession": "session_old", "cli": "codex",
        "provider": "openrouter", "model": DEEPSEEK["model"], "effort": "max",
    })]

    calls.clear()
    await main.select_chat_model(main.ModelSelectionInput(
        expected_session="session_old", cli=DEEPSEEK["cli"], model=DEEPSEEK["model"], effort=DEEPSEEK["effort"],
    ), identity)
    assert calls == [("POST", "/v1/control", {
        "action": "model", "expectedSession": "session_old", "cli": "codex",
        "model": DEEPSEEK["model"], "effort": "max",
    })]


@pytest.mark.asyncio
async def test_privileged_chat_models_filter_without_auto_select(tmp_path, monkeypatch):
    configure_policy(tmp_path, monkeypatch, privileged=[LUNA, DEEPSEEK])
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append(body)
        return ez_control("grok", [GROK_PRESET, DEEPSEEK_PRESET, LUNA_PRESET], CATALOG)

    monkeypatch.setattr(main, "account_for", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.chat_models(Identity(subject=JUAN, email="owner@example.com"))
    assert result["selected_id"] == ""
    assert calls == [None]


@pytest.mark.asyncio
async def test_new_chat_returns_filtered_control_without_second_post(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append(body)
        return ez_control("deepseek", [GROK_PRESET, DEEPSEEK_PRESET], CATALOG[:2], "session_new")

    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.clear_chat(main.NewChatInput(
        user_id=identity.subject,
        expected_session="session_old",
    ), identity)
    assert [body.get("action") for body in calls] == ["new"]
    assert result["selected_id"] == "deepseek"


@pytest.mark.asyncio
async def test_enqueue_does_not_touch_model_control(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    submitted = []

    async def ez_call(_binding, method, path, body=None):
        submitted.append((method, path, body))
        if method == "POST":
            return {"id": "run_1"}
        return {"id": "run_1", "status": "completed", "messages": [{"id": "msg_1", "text": "ok"}]}

    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.enqueue_chat(main.ChatInput(
        user_id=identity.subject, request_id=uuid4(), message="echo test",
    ), identity)
    assert [item[1] for item in submitted] == ["/v1/runs", "/v1/runs/run_1"]
    assert submitted[0][2]["followOwner"] is True
    assert result["messages"][0]["text"] == "ok"


@pytest.mark.asyncio
async def test_chat_job_proxies_ez_run_by_id(monkeypatch, identity):
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))

    async def ez_call(_binding, method, path, body=None):
        assert path == "/v1/runs/run_1"
        return {"id": "run_1", "status": "completed", "messages": [{"id": "m1", "text": "hi"}]}

    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.chat_job("run_1", identity.subject, identity)
    assert result["job_id"] == "run_1"
    assert result["messages"][0]["text"] == "hi"


def test_validation_failures_keep_the_documented_error_contract(monkeypatch):
    from fastapi.testclient import TestClient

    from aifit_api import auth

    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", "test-secret-with-at-least-thirty-two-bytes")
    capability = auth.mint_agent_capability(
        account_id="acc_1", tenant_id="ten_1", job_id="job_1", permissions={"blueprints:write"},
    )
    response = TestClient(main.app).post(
        "/v1/agent/blueprints/solidify",
        headers={"Authorization": f"Bearer {capability}"},
        json={"schema_version": 1, "request_id": "validation-1"},
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "validation_error"
    assert isinstance(detail["message"], str) and detail["message"]
    assert detail["errors"] and detail["errors"][0]["loc"]


@pytest.mark.asyncio
async def test_binding_verification_requires_owner_and_receipt(monkeypatch):
    monkeypatch.setattr(ez, "binding_for", lambda _owner: {"ownerId": "acc_1"})
    monkeypatch.setattr(ez, "call", lambda *_args: async_value({"ownerId": "another", "bindingId": "binding_1"}))
    with pytest.raises(HTTPException) as error:
        await ez.verified_binding("acc_1")
    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_mini_chat_enqueue_uses_its_own_scope_without_follow_owner(monkeypatch, identity):
    monkeypatch.setattr(main, "owned_account", lambda *_args: async_value({
        "account_id": "acc_1", "tenant_id": "ten_1",
    }))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    submitted = []

    async def ez_call(_binding, method, path, body=None):
        submitted.append((method, path, body))
        if method == "POST":
            return {"id": "run_mini"}
        return {"id": "run_mini", "status": "completed", "messages": [{"id": "msg_1", "text": "ok"}]}

    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.enqueue_chat(main.ChatInput(
        user_id=identity.subject, request_id=uuid4(), message="swap this",
        scope="owner-minichat", scope_id="coach:session:wex_1",
    ), identity)
    assert [item[1] for item in submitted] == ["/v1/runs", "/v1/runs/run_mini"]
    admission = submitted[0][2]
    assert admission["scope"] == "owner-minichat"
    assert "followOwner" not in admission
    assert admission["text"] == "swap this"
    assert admission["context"]["scopeId"] == "coach:session:wex_1"
    assert result["job_id"] == "run_mini"


def test_unknown_chat_scope_is_rejected():
    with pytest.raises(ValidationError):
        main.ChatInput(user_id="owner", request_id=uuid4(), message="hi", scope="owner-other")
    with pytest.raises(ValidationError):
        main.ModelSelectionInput(expected_session="s", scope="owner-other", cli="codex")


@pytest.mark.asyncio
async def test_mini_chat_models_use_scope_control(monkeypatch, identity):
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append((method, path, body))
        return ez_control("deepseek", [DEEPSEEK_PRESET], CATALOG[:2], "session_mini")

    monkeypatch.setattr(main, "account_for", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    result = await main.chat_models(identity, scope="owner-minichat")
    assert calls == [("GET", "/v1/scope-control?scope=owner-minichat", None)]
    assert result["active_session_id"] == "session_mini"


@pytest.mark.asyncio
async def test_mini_chat_model_selection_uses_scope_control(tmp_path, monkeypatch, identity):
    configure_policy(tmp_path, monkeypatch)
    calls = []

    async def ez_call(_binding, method, path, body=None):
        calls.append((method, path, body))
        return ez_control("deepseek", [DEEPSEEK_PRESET], CATALOG[:2], "session_mini")

    monkeypatch.setattr(main, "account_for", lambda *_args: async_value({"account_id": "acc_1", "tenant_id": "ten_1"}))
    monkeypatch.setattr(main, "verified_binding", lambda *_args: async_value({"bindingId": "binding_1"}))
    monkeypatch.setattr(main, "ez_call", ez_call)
    await main.select_chat_model(main.ModelSelectionInput(
        expected_session="session_old", scope="owner-minichat",
        cli=DEEPSEEK["cli"], model=DEEPSEEK["model"], effort=DEEPSEEK["effort"],
    ), identity)
    assert calls == [("POST", "/v1/scope-control?scope=owner-minichat", {
        "action": "model", "expectedSession": "session_old", "cli": "codex",
        "model": DEEPSEEK["model"], "effort": "max",
    })]


def async_value(value):
    async def result():
        return value
    return result()
