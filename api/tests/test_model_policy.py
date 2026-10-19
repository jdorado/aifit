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


def test_purpose_label_preserves_authorization_and_native_efforts(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    path = tmp_path / "model-policy.json"
    policy = json.loads(path.read_text())
    policy["privileged"][1]["label"] = "Detailed planning"
    path.write_text(json.dumps(policy))
    filtered = model_policy.filter_control(control(), OWNER)
    assert filtered["models"][1]["labels"] == {"max": "Detailed planning"}
    model_policy.require_allowed(OWNER, LUNA["cli"], LUNA["model"], LUNA["effort"])
    assert all("labels" not in item for item in model_policy.filter_control(control(), OTHER)["models"])
    value = control()
    value["models"][1]["efforts"] = ["medium"]
    assert all(item["cli"] != "codex" for item in model_policy.filter_control(value, OWNER)["models"])


@pytest.mark.parametrize("selected_provider", [None, "openrouter", "openai", "unavailable"])
def test_purpose_label_is_not_repeated_across_providers_of_the_same_model(tmp_path, monkeypatch, selected_provider):
    configure(tmp_path, monkeypatch)
    path = tmp_path / "model-policy.json"
    policy = json.loads(path.read_text())
    policy["privileged"][1]["label"] = "Detailed planning"
    path.write_text(json.dumps(policy))
    value = control()
    if selected_provider is not None:
        value["presets"][1]["provider"] = selected_provider
    value["models"] += [
        {**value["models"][1], "provider": "openrouter"},
        {**value["models"][1], "provider": "openai"},
    ]
    filtered = model_policy.filter_control(value, OWNER)
    models = [item for item in filtered["models"] if item["cli"] == "codex"]
    representative = {None: 0, "openrouter": 1, "openai": 2, "unavailable": 0}[selected_provider]
    assert [item.get("labels") for item in models] == [
        {"max": "Detailed planning"} if index == representative else None for index in range(3)
    ]
    assert filtered["selected_id"] == "luna"
    assert filtered["presets"] == value["presets"]
    model_policy.require_allowed(OWNER, LUNA["cli"], LUNA["model"], LUNA["effort"])


def test_invalid_purpose_label_is_rejected(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    path = tmp_path / "model-policy.json"
    policy = json.loads(path.read_text())
    policy["privileged"][1]["label"] = " "
    path.write_text(json.dumps(policy))
    with pytest.raises(HTTPException) as error:
        model_policy.allowed_choices(OWNER)
    assert error.value.status_code == 503


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


AGY = {"cli": "agy", "model": "gemini-3.8-flash-medium", "effort": "medium", "label": "Antigravity test"}


def test_subject_addition_is_available_only_to_owner_without_changing_defaults(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch)
    path = tmp_path / "model-policy.json"
    policy = json.loads(path.read_text())
    policy["subject_choices"] = {OWNER: [AGY]}
    path.write_text(json.dumps(policy))
    model_policy.require_allowed(OWNER, AGY["cli"], AGY["model"], AGY["effort"])
    for subject in (OTHER, "did:privy:member_a", "did:privy:member_b"):
        with pytest.raises(HTTPException) as error:
            model_policy.require_allowed(subject, AGY["cli"], AGY["model"], AGY["effort"])
        assert error.value.status_code == 403
    value = control()
    value["models"].append({"cli": AGY["cli"], "model": AGY["model"], "name": "Gemini", "efforts": ["low", "medium", "high"]})
    filtered = model_policy.filter_control(value, OWNER)
    assert filtered["models"][-1]["efforts"] == ["medium"]
    assert filtered["models"][-1]["labels"] == {"medium": "Antigravity test"}
    assert filtered["selected_id"] == value["selected_id"]
    assert all(item["cli"] != "agy" for item in model_policy.filter_control(value, OTHER)["models"])
    for subject in (OWNER, "did:privy:member_a", "did:privy:member_b"):
        model_policy.require_allowed(subject, LUNA["cli"], LUNA["model"], LUNA["effort"])
    model_policy.require_allowed(OTHER, MUSE["cli"], MUSE["model"], MUSE["effort"])


@pytest.mark.parametrize("additions", [[], {"bad": [AGY]}, {"did:privy:": [AGY]}, {OWNER: []}, {OWNER: [AGY, AGY]}, {OWNER: [LUNA]}, {OWNER: [{**AGY, "effort": ""}]}])
def test_malformed_subject_additions_fail_closed(tmp_path, monkeypatch, additions):
    configure(tmp_path, monkeypatch)
    path = tmp_path / "model-policy.json"
    policy = json.loads(path.read_text())
    policy["subject_choices"] = additions
    path.write_text(json.dumps(policy))
    with pytest.raises(HTTPException) as error:
        model_policy.allowed_choices(OWNER)
    assert error.value.status_code == 503
