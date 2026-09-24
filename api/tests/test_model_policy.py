import json

import pytest
from fastapi import HTTPException

from aifit_api import model_policy


OWNER = "did:privy:owner"
OTHER = "did:privy:other"
MUSE = {"cli": "opencode", "model": "opencode-go/muse-spark-1.3-contributor", "effort": "xhigh"}
LUNA = {"cli": "codex", "model": "gpt-6-luna", "effort": "max"}


@pytest.fixture(autouse=True)
def clear_policy_cache(monkeypatch):
    monkeypatch.delenv("AIFIT_MODEL_POLICY_FILE", raising=False)
    model_policy.configured_model_policy.cache_clear()
    yield
    model_policy.configured_model_policy.cache_clear()


def configure(tmp_path, monkeypatch):
    path = tmp_path / "model-policy.json"
    path.write_text(json.dumps({
        "privileged_subjects": [OWNER, "did:privy:member_a", "did:privy:member_b"],
        "default": [MUSE],
        "privileged": [MUSE, LUNA],
    }))
    monkeypatch.setenv("AIFIT_MODEL_POLICY_FILE", str(path))


def control():
    return {
        "presets": [
            {"id": "muse", "name": "Muse", **MUSE},
            {"id": "luna", "name": "Luna", **LUNA},
        ],
        "selected_id": "luna",
        "models": [
            {"cli": "opencode", "model": MUSE["model"], "name": "Muse", "efforts": ["low", "xhigh"]},
            {"cli": "codex", "model": LUNA["model"], "name": "Luna", "efforts": ["medium", "max"]},
            {"cli": "opencode", "model": "opencode-go/gpt-6-luna", "name": "Luna via OpenCode", "efforts": ["max"]},
        ],
        "active_session_id": "session_1",
    }


def test_unconfigured_public_install_preserves_ez_catalog():
    value = control()
    assert model_policy.filter_control(value, OTHER) is value
    model_policy.require_allowed(OTHER, "anything", "anything", "anything")


def test_default_account_sees_only_curated_choice(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    filtered = model_policy.filter_control(control(), OTHER)
    assert filtered["presets"] == [{"id": "muse", "name": "Muse", **MUSE}]
    assert filtered["models"] == [{
        "cli": "opencode", "model": MUSE["model"], "name": "Muse", "efforts": ["xhigh"],
    }]
    assert filtered["selected_id"] == ""


def test_privileged_account_sees_curated_choices(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    filtered = model_policy.filter_control(control(), OWNER)
    assert [item["id"] for item in filtered["presets"]] == ["muse", "luna"]
    assert [(item["cli"], item["model"]) for item in filtered["models"]] == [
        (MUSE["cli"], MUSE["model"]), (LUNA["cli"], LUNA["model"]),
    ]
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
    model_policy.require_allowed(OTHER, MUSE["cli"], MUSE["model"], MUSE["effort"])
    with pytest.raises(HTTPException) as error:
        model_policy.require_allowed(OWNER, "opencode", "opencode-go/gpt-6-luna", "max")
    assert error.value.status_code == 403


def test_malformed_config_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "model-policy.json"
    path.write_text("{}")
    monkeypatch.setenv("AIFIT_MODEL_POLICY_FILE", str(path))
    with pytest.raises(HTTPException) as error:
        model_policy.allowed_choices(OTHER)
    assert error.value.status_code == 503
