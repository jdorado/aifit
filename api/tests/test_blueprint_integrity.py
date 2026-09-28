from copy import deepcopy

import pytest

from aifit_api.workouts import (
    BlueprintInput, ExerciseAddInput, GenerateInput, SwapInput, WorkoutDomainError, WorkoutService,
)
from test_workout_contract import blueprint
from test_workout_partial_progress import log_set_at
from test_workout_transactions import FakeDatabase


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["draft_blueprint", "solidify_blueprint"])
async def test_publication_rejects_ambiguous_aliases_and_cross_tenant_revisions(operation):
    db = FakeDatabase()
    service = WorkoutService(db)
    first, second = db.documents["exercises"]
    first["name"] = "Supported Step-Up With Hip Flexion"
    second["name"] = "supported step up with hip flexion"
    with pytest.raises(WorkoutDomainError) as error:
        await getattr(service, operation)("acc_one", BlueprintInput(**blueprint()), None, "aliases", {})
    assert error.value.code == "blueprint_duplicate_exercise_name"
    assert db.documents["blueprints"] == db.documents["program_state"] == []

    # An exercise with the requested ID/revision in another account is not a match.
    db.documents["exercises"][1]["account_id"] = "acc_other"
    with pytest.raises(WorkoutDomainError) as error:
        await getattr(service, operation)("acc_one", BlueprintInput(**blueprint()), None, "foreign", {})
    assert error.value.code == "blueprint_exercise_missing"
    assert db.documents["blueprints"] == db.documents["program_state"] == []

    plan = blueprint()
    slot = plan["days"][0]["segments"][0]["slots"][0]
    slot["selection_count"] = 2
    with pytest.raises(ValueError, match="separate slots"):
        BlueprintInput(**plan)
    slot["selection_count"] = 1
    slot["candidates"] = slot["candidates"][:1]
    # One justified movement is valid; inventing an alternative is not required.
    assert (await getattr(service, operation)("acc_one", BlueprintInput(**plan), None, "narrow", {}))["status"] == "saved"


@pytest.mark.asyncio
async def test_alternative_dose_survives_generation_add_and_partial_swap():
    async def fixture(prefer_alternative=False):
        db = FakeDatabase()
        service = WorkoutService(db)
        plan = blueprint()
        primary, alternative = plan["days"][0]["segments"][0]["slots"][0]["candidates"]
        alternative["prescription"].update(
            set_count=2,
            target={"reps": {"min": 8, "max": 8}},
            round_targets=[{"reps": {"min": reps, "max": reps}} for reps in (8, 10)],
        )
        if prefer_alternative:
            primary["priority"], alternative["priority"] = 2, 1
        await service.solidify_blueprint("acc_one", BlueprintInput(**plan), None, "publish", {})
        workout = (await service.generate("acc_one", GenerateInput(date="2026-09-21", request_id="generate")))["workout"]
        return service, workout

    _, generated = await fixture(prefer_alternative=True)
    item = generated["segments"][0]["items"][0]
    assert len(item["sets"]) == item["progression_context"]["expected_sets"] == 2
    assert [row["target"]["reps"]["min"] for row in item["sets"]] == [8, 10]
    assert all(row["target"].get("load") is None for row in item["sets"])

    service, workout = await fixture()
    workout, _ = await log_set_at(service, workout, 0, "log")
    original_segments = deepcopy(workout["segments"])
    repertoire = await service.exercise_repertoire("acc_one", workout["workout_id"])
    candidate = next(row for row in repertoire["candidates"] if not row["already_added"])
    assert candidate["sets"] == 2
    added = (await service.add_exercise("acc_one", workout["workout_id"], ExerciseAddInput(
        expected_revision=workout["revision"], request_id="add", blueprint_id=repertoire["blueprint_id"],
        expected_blueprint_revision=repertoire["blueprint_revision"],
        **{key: candidate[key] for key in ("day_id", "slot_id", "candidate_id")},
    )))["workout"]
    assert added["segments"][:-1] == original_segments
    assert len(added["segments"][-1]["items"][0]["sets"]) == added["segments"][-1]["rounds"] == 2

    # Both an untouched 3-set item and its 2-set remainder get the alternative's
    # own two targets. A logged original set retains every byte and its identity.
    for partial in (False, True):
        service, workout = await fixture()
        if partial:
            workout, _ = await log_set_at(service, workout, 0, "log")
        item = workout["segments"][0]["items"][0]
        original_logged = [deepcopy(row) for row in item["sets"] if row["actual"] is not None]
        choices = await service.swap_candidates("acc_one", workout["workout_id"], item["exercise_instance_id"])
        assert choices["candidates"][0]["sets"] == 2
        saved = (await service.swap("acc_one", workout["workout_id"], item["exercise_instance_id"], SwapInput(
            expected_revision=workout["revision"], expected_blueprint_revision=choices["blueprint_revision"],
            target_candidate_id="cand_row_cable", reason="Choose two-set alternative", request_id="swap",
        )))["workout"]
        sets = [row for segment in saved["segments"] for exercise in segment["items"] for row in exercise["sets"]]
        assert [row for row in sets if row["actual"] is not None] == original_logged
        remaining = [row for row in sets if row["actual"] is None]
        assert [row["target"]["reps"]["min"] for row in remaining] == [8, 10]
        assert all(row["target"].get("load") is None for row in remaining)

    invalid = blueprint()
    candidate = invalid["days"][0]["segments"][0]["slots"][0]["candidates"][0]
    candidate["prescription"].update(set_count=2, round_targets=[candidate["prescription"]["target"]] * 3)
    with pytest.raises(ValueError, match="set_count"):
        BlueprintInput(**invalid)
