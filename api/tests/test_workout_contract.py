import asyncio

import pytest

from aifit_api import auth
from aifit_api.workouts import (
    BlueprintInput,
    ExerciseDefinitionInput,
    GenerateInput,
    Quantity,
    Target,
    WorkoutOverrideInput,
    _decision_index,
    exercise_load_key,
)


def exercise_definition() -> ExerciseDefinitionInput:
    return ExerciseDefinitionInput(
        exercise_id="ex_chest_supported_row_machine",
        name="Chest-supported machine row",
        movement_pattern="horizontal_pull",
        primary_muscles=["latissimus_dorsi"],
        secondary_muscles=["rhomboids"],
        equipment_kind="machine",
        laterality="bilateral",
        load_basis="machine_stack",
        metrics=["reps"],
        instructions_md="Keep the chest supported.",
    )


def blueprint() -> dict:
    return {
        "schema_version": 1,
        "timezone": "Asia/Dubai",
        "start_date": "2026-09-21",
        "end_date": "2026-09-21",
        "hard_constraints": {"forbidden_exercise_ids": [], "notes_md": ""},
        "days": [{
            "day_id": "day_upper_a",
            "date": "2026-09-21",
            "kind": "training",
            "title": "Upper A",
            "intent_md": "Pull emphasis.",
            "segments": [{
                "segment_id": "seg_main",
                "order": 1,
                "kind": "straight_sets",
                "title": "Pull Main",
                "rounds": 3,
                "rest_after_round_seconds": 90,
                "slots": [{
                    "slot_id": "slot_pull",
                    "order": 1,
                    "role": "horizontal_pull",
                    "selection_count": 1,
                    "candidates": [{
                        "candidate_id": "cand_row",
                        "exercise_id": "ex_chest_supported_row_machine",
                        "exercise_revision": "rev_0123456789abcdef0123456789abcdef",
                        "priority": 1,
                        "rationale_md": "Stable row.",
                        "equipment_profile_id": "eqp_row_machine",
                        "prescription": {
                            "metric": "reps",
                            "target": {"reps": {"min": 8, "max": 12}, "load": {"value": 40, "unit": "kg"}, "rpe": {"min": 7, "max": 8}},
                            "rest_seconds": 90,
                            "tempo": {"eccentric_seconds": 3, "pause_seconds": 1, "concentric_seconds": 1},
                        },
                        "progression": {"kind": "none"},
                    }, {
                        "candidate_id": "cand_row_cable",
                        "exercise_id": "ex_chest_supported_row_cable",
                        "exercise_revision": "rev_abcdef0123456789abcdef0123456789",
                        "priority": 2,
                        "rationale_md": "Cable alternative when the machine is occupied.",
                        "equipment_profile_id": "eqp_row_cable",
                        "prescription": {
                            "metric": "reps",
                            "target": {"reps": {"min": 8, "max": 12}, "load": {"value": 30, "unit": "kg"}, "rpe": {"min": 7, "max": 8}},
                            "rest_seconds": 90,
                            "tempo": {"eccentric_seconds": 3, "pause_seconds": 1, "concentric_seconds": 1},
                        },
                        "progression": {"kind": "none"},
                    }],
                }],
            }],
        }],
    }


def test_end_state_exercise_and_blueprint_are_typed():
    definition = exercise_definition()
    parsed = BlueprintInput(**blueprint())
    assert parsed.days[0].segments[0].slots[0].candidates[0].exercise_id == definition.exercise_id


def test_targets_reject_legacy_string_quantities():
    with pytest.raises(ValueError):
        Quantity(value="40", unit="kg")
    with pytest.raises(ValueError):
        Target(reps={"min": "8", "max": 12})


def test_blueprint_rejects_a_candidate_that_is_also_hard_forbidden():
    value = blueprint()
    value["hard_constraints"]["forbidden_exercise_ids"] = ["ex_chest_supported_row_machine"]
    with pytest.raises(ValueError):
        BlueprintInput(**value)


def test_blueprint_requires_an_alternative_beyond_selection_count():
    value = blueprint()
    value["days"][0]["segments"][0]["slots"][0]["candidates"].pop()
    with pytest.raises(ValueError, match="alternative"):
        BlueprintInput(**value)


def test_agent_override_keeps_the_same_typed_segment_contract():
    value = blueprint()
    value["days"][0]["segments"][0]["slots"][0]["candidates"] = value["days"][0]["segments"][0]["slots"][0]["candidates"][:1]
    override = WorkoutOverrideInput(
        date="2026-09-21",
        title="Travel gym exception",
        reason_md="The user explicitly requested an alternate gym session.",
        segments=value["days"][0]["segments"],
        expected_revision=None,
        request_id="override-001",
    )
    assert override.segments[0].slots[0].candidates[0].prescription.target.reps.max == 12


def test_agent_override_rejects_an_unresolved_candidate_slot():
    with pytest.raises(ValueError, match="exactly one resolved candidate"):
        WorkoutOverrideInput(
            date="2026-09-21",
            title="Unresolved exception",
            reason_md="The agent must resolve the item before publishing an exception.",
            segments=blueprint()["days"][0]["segments"],
            request_id="override-unresolved-001",
        )


def test_agent_override_allows_a_day_outside_the_blueprint_period():
    value = blueprint()
    value["days"][0]["segments"][0]["slots"][0]["candidates"] = value["days"][0]["segments"][0]["slots"][0]["candidates"][:1]
    override = WorkoutOverrideInput(
        date="2026-10-04",
        title="New recovery day",
        reason_md="The user asked for a one-off day outside the published block.",
        segments=value["days"][0]["segments"],
        request_id="override-outside-period-001",
    )
    assert override.date == "2026-10-04"


def test_load_identity_ignores_display_revision_but_not_equipment_or_basis():
    base = {
        "exercise_id": "ex_chest_supported_row_machine",
        "exercise_revision": "rev_one",
        "equipment_profile_id": "eqp_row_machine",
        "load_basis": "machine_stack",
        "laterality": "bilateral",
    }
    assert exercise_load_key(base) == exercise_load_key({**base, "exercise_revision": "rev_two"})
    assert exercise_load_key(base) != exercise_load_key({**base, "equipment_profile_id": "eqp_another_machine"})
    assert exercise_load_key(base) != exercise_load_key({**base, "load_basis": "total"})


def test_jev_selection_is_bounded_and_retry_stable():
    candidates = [
        {"candidate_id": "cand_first", "priority": 1},
        {"candidate_id": "cand_second", "priority": 2},
        {"candidate_id": "cand_third", "priority": 3},
    ]
    first = _decision_index("stable-request", candidates, "jev")
    second = _decision_index("stable-request", candidates, "jev")
    assert first == second
    assert first[0] in {0, 1, 2}
    assert set(first[1]) == {"cand_first", "cand_second", "cand_third"}
    assert sum(first[1].values()) == pytest.approx(1)


def test_generation_source_is_limited_to_default_or_jev():
    assert GenerateInput(date="2026-09-21", request_id="generate-001").source == "default"
    assert GenerateInput(date="2026-09-21", source="jev", request_id="generate-002").source == "jev"
    with pytest.raises(ValueError):
        GenerateInput(date="2026-09-21", source="varied", request_id="generate-003")


def test_agent_capability_is_bound_to_one_account_and_permission_set(monkeypatch):
    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", "test-secret-with-at-least-thirty-two-bytes")
    token = auth.mint_agent_capability(
        account_id="acc_one", tenant_id="ten_one", job_id="job_one", permissions={"workouts:read"},
    )
    capability = asyncio.run(auth.require_agent_capability(f"Bearer {token}"))
    assert capability.account_id == "acc_one"
    assert capability.job_id == "job_one"
    assert capability.permissions == frozenset({"workouts:read"})
