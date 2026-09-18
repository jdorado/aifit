import json

import pytest
from fastapi import HTTPException

from aifit_api import model_policy


JUAN = "did:privy:owner"
OTHER = "did:privy:other"
DEEPSEEK = {"cli": "codex", "model": "deepseek/deepseek-v4.1-flash", "effort": "max"}
LUNA = {"cli": "codex", "model": "gpt-5.6-luna", "effort": "max"}


@pytest.fixture(autouse=True)
def clear_policy_cache(monkeypatch):
    monkeypatch.delenv("AIFIT_MODEL_POLICY_FILE", raising=False)
    model_policy.configured_model_policy.cache_clear()
    yield
    model_policy.configured_model_policy.cache_clear()


def configure(tmp_path, monkeypatch):
    path = tmp_path / "model-policy.json"
    path.write_text(json.dumps({
        "privileged_subjects": [JUAN, "did:privy:member_a", "did:privy:member_b"],
        "default": [DEEPSEEK],
        "privileged": [DEEPSEEK, LUNA],
    }))
    monkeypatch.setenv("AIFIT_MODEL_POLICY_FILE", str(path))


def control():
    return {
        "presets": [
            {"id": "deepseek", "name": "DeepSeek", **DEEPSEEK},
            {"id": "luna", "name": "Luna", **LUNA},
        ],
        "selected_id": "luna",
        "models": [
            {"cli": "codex", "model": DEEPSEEK["model"], "name": "DeepSeek", "efforts": ["low", "max"]},
            {"cli": "codex", "model": LUNA["model"], "name": "Luna", "efforts": ["medium", "max"]},
        ],
        "active_session_id": "session_1",
    }


def test_unconfigured_public_install_preserves_ez_catalog():
    value = control()
    assert model_policy.filter_control(value, OTHER) is value
    model_policy.require_allowed(OTHER, "anything", "anything", "anything")


def test_default_account_sees_only_openrouter_choice(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    filtered = model_policy.filter_control(control(), OTHER)
    assert filtered["presets"] == [{"id": "deepseek", "name": "DeepSeek", **DEEPSEEK}]
    assert filtered["models"] == [{
        "cli": "codex", "model": DEEPSEEK["model"], "name": "DeepSeek", "efforts": ["max"],
    }]
    assert filtered["selected_id"] == ""


def test_privileged_account_sees_curated_choices(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    filtered = model_policy.filter_control(control(), JUAN)
    assert [item["id"] for item in filtered["presets"]] == ["deepseek", "luna"]
    assert filtered["selected_id"] == "luna"


def test_policy_does_not_advertise_effort_missing_from_ez(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    value = control()
    value["models"][0]["efforts"] = ["low"]
    assert model_policy.filter_control(value, OTHER)["models"] == []


def test_disallowed_selection_is_rejected_before_ez(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as error:
        model_policy.require_allowed(OTHER, LUNA["cli"], LUNA["model"], LUNA["effort"])
    assert error.value.status_code == 403
    model_policy.require_allowed(OTHER, DEEPSEEK["cli"], DEEPSEEK["model"], DEEPSEEK["effort"])


def test_fallback_follows_policy_order(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    assert model_policy.fallback_choice(OTHER) == model_policy.ModelChoice(**DEEPSEEK)
    assert model_policy.fallback_choice(JUAN) == model_policy.ModelChoice(**DEEPSEEK)
    path = tmp_path / "model-policy.json"
    path.write_text(json.dumps({
        "privileged_subjects": [JUAN],
        "default": [DEEPSEEK],
        "privileged": [LUNA, DEEPSEEK],
    }))
    model_policy.configured_model_policy.cache_clear()
    assert model_policy.fallback_choice(JUAN) == model_policy.ModelChoice(**LUNA)
    assert model_policy.fallback_choice(OTHER) == model_policy.ModelChoice(**DEEPSEEK)


def test_fallback_accepts_preset_only_engine_choice(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    value = control()
    value["models"] = []
    assert model_policy.fallback_available(value, model_policy.fallback_choice(OTHER))


def test_malformed_config_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "model-policy.json"
    path.write_text("{}")
    monkeypatch.setenv("AIFIT_MODEL_POLICY_FILE", str(path))
    with pytest.raises(HTTPException) as error:
        model_policy.allowed_choices(OTHER)
    assert error.value.status_code == 503
