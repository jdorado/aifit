from copy import deepcopy

import pytest

from aifit_api.workouts import (
    BlueprintInput, ExerciseAddInput, GenerateInput, SwapInput, WorkoutDomainError, WorkoutOverrideInput, WorkoutService,
)
from test_workout_contract import blueprint
from test_workout_partial_progress import log_set_at
from test_workout_transactions import FakeDatabase


@pytest.mark.asyncio
async def test_override_and_legacy_slot_aliases_keep_the_canonical_alternatives():
    db = FakeDatabase()
    service = WorkoutService(db)
    plan = blueprint()
    await service.solidify_blueprint("acc_one", BlueprintInput(**plan), None, "publish", {})
    workout = (await service.generate("acc_one", GenerateInput(date="2026-09-21", request_id="generate")))["workout"]
    # Reproduce an old resolved-day override that renamed the slot and its
    # candidate while retaining the same canonical exercise.
    stored = db.documents["workouts"][0]["segments"][0]["items"][0]
    stored.update(slot_id="slot_override_alias", candidate_id="cand_override_alias")
    choices = await service.swap_candidates("acc_one", workout["workout_id"], stored["exercise_instance_id"])
    assert choices["slot_id"] == "slot_pull"
    assert [choice["candidate_id"] for choice in choices["candidates"]] == ["cand_row_cable"]

    workout, _ = await log_set_at(service, workout, 0, "log")
    logged = deepcopy(workout["segments"][0]["items"][0]["sets"][0])
    segment = deepcopy(plan["days"][0]["segments"][0])
    segment["rounds"] = 2
    slot = segment["slots"][0]
    slot.update(slot_id="slot_override_new", candidates=slot["candidates"][:1])
    slot["candidates"][0]["candidate_id"] = "cand_override_new"
    saved = (await service.override("acc_one", WorkoutOverrideInput(
        date="2026-09-21", title="Same movement, adjusted remainder", reason_md="Adjust remaining dose",
        expected_revision=workout["revision"], request_id="override", segments=[segment],
    ), {}))["workout"]
    assert saved["segments"][0]["items"][0]["sets"] == [logged]
    remaining = saved["segments"][-1]["items"][0]
    assert (remaining["slot_id"], remaining["candidate_id"]) == ("slot_pull", "cand_row")
    assert len(remaining["sets"]) == 2
    choices = await service.swap_candidates("acc_one", saved["workout_id"], remaining["exercise_instance_id"])
    assert [choice["candidate_id"] for choice in choices["candidates"]] == ["cand_row_cable"]

    # An unlinked exercise shared by multiple pools is ambiguous: do not
    # silently choose one role's alternatives. The declared slot resolves it.
    other = deepcopy(plan["days"][0]["segments"][0]["slots"][0])
    other["slot_id"] = "slot_other"
    plan["days"][0]["segments"][0]["slots"].append(other)
    unlinked = {**remaining, "slot_id": "slot_unknown", "candidate_id": "cand_unknown"}
    assert service._blueprint_slot(plan["days"][0], unlinked) is None
    assert service._blueprint_slot(plan["days"][0], remaining)["slot_id"] == "slot_pull"


@pytest.mark.asyncio
async def test_recovered_legacy_mixed_pool_keeps_the_current_movement_function():
    db = FakeDatabase()
    plan = blueprint()
    slot = plan["days"][0]["segments"][0]["slots"][0]
    different_role = deepcopy(slot["candidates"][1])
    different_role.update(candidate_id="cand_press", exercise_id="ex_triceps_pressdown")
    slot["candidates"].append(different_role)
    db.seed_blueprint_catalog(plan)
    next(row for row in db.documents["exercises"] if row["exercise_id"] == "ex_triceps_pressdown")["movement_pattern"] = "elbow_extension"
    service = WorkoutService(db)
    await service.solidify_blueprint("acc_one", BlueprintInput(**plan), None, "publish", {})
    workout = (await service.generate("acc_one", GenerateInput(date="2026-09-21", request_id="generate")))["workout"]
    # Simulate a previously published mixed-function pool and a renamed slot.
    db.documents["blueprints"][0]["days"][0]["segments"][0]["slots"][0]["selection_count"] = 2
    item = db.documents["workouts"][0]["segments"][0]["items"][0]
    item["slot_id"] = "slot_override_alias"
    choices = await service.swap_candidates("acc_one", workout["workout_id"], item["exercise_instance_id"])
    assert [choice["candidate_id"] for choice in choices["candidates"]] == ["cand_row_cable"]


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["default", "jev"])
async def test_shared_alternative_pools_reserve_narrow_slots_and_exclude_used_swaps(source):
    plan = blueprint()
    segment = plan["days"][0]["segments"][0]
    broad = segment["slots"][0]
    third = deepcopy(broad["candidates"][1])
    third.update(candidate_id="cand_row_dumbbell", exercise_id="ex_chest_supported_row_dumbbell", priority=3)
    broad["candidates"].append(third)
    narrow = deepcopy(broad)
    narrow.update(slot_id="slot_narrow", order=2, candidates=deepcopy(broad["candidates"][:1]))
    segment["slots"].append(narrow)
    db = FakeDatabase()
    db.seed_blueprint_catalog(plan)
    service = WorkoutService(db)
    await service.solidify_blueprint("acc_one", BlueprintInput(**plan), None, "publish", {})
    workout = (await service.generate("acc_one", GenerateInput(
        date="2026-09-21", source=source, request_id="generate",
    )))["workout"]
    first, second = workout["segments"][0]["items"]
    assert second["exercise_snapshot"]["exercise_id"] == "ex_chest_supported_row_machine"
    assert first["exercise_snapshot"]["exercise_id"] != second["exercise_snapshot"]["exercise_id"]
    choices = await service.swap_candidates("acc_one", workout["workout_id"], first["exercise_instance_id"])
    assert len(choices["candidates"]) == 1
    alternative = choices["candidates"][0]
    assert alternative["exercise_id"] not in {item["exercise_snapshot"]["exercise_id"] for item in (first, second)}
    saved = (await service.swap("acc_one", workout["workout_id"], first["exercise_instance_id"], SwapInput(
        expected_revision=workout["revision"], expected_blueprint_revision=choices["blueprint_revision"],
        target_candidate_id=alternative["candidate_id"], reason="Use the remaining alternative", request_id="swap",
    )))["workout"]
    assert saved["segments"][0]["items"][1] == second
    assert len({item["exercise_snapshot"]["exercise_id"] for item in saved["segments"][0]["items"]}) == 2

    # Overlapping pools are valid; two required slots with only one shared
    # movement are not. Ambiguous slot IDs remain invalid across segments.
    broad["candidates"] = broad["candidates"][:1]
    with pytest.raises(ValueError, match="without selecting an exercise twice"):
        BlueprintInput(**plan)
    other_segment = deepcopy(segment)
    other_segment.update(segment_id="seg_other", order=2)
    plan["days"][0]["segments"].append(other_segment)
    with pytest.raises(ValueError, match="unique IDs across segments"):
        BlueprintInput(**plan)


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
