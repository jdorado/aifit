import pytest
from pydantic import ValidationError

from aifit_api.workouts import (
    BlueprintInput,
    ExerciseNoteInput,
    GenerateInput,
    SetActual,
    SetLogInput,
    SwapInput,
    WorkoutDomainError,
    WorkoutNotesInput,
    WorkoutOverrideInput,
    WorkoutService,
)

from test_workout_contract import blueprint
from test_workout_partial_progress import override_segments
from test_workout_transactions import FakeDatabase


ACTOR = {"kind": "browser", "account_id": "acc_one"}


async def generated_day(database) -> tuple[WorkoutService, dict]:
    service = WorkoutService(database)
    await service.solidify_blueprint(
        "acc_one", BlueprintInput(**blueprint()), None, "solidify-notes-001", {"kind": "agent", "job_id": "job_one"},
    )
    response = await service.generate("acc_one", GenerateInput(date="2026-09-21", request_id="generate-notes-001"))
    return service, response["workout"]


def day_note(workout: dict, notes: str, request_id: str) -> WorkoutNotesInput:
    return WorkoutNotesInput(notes=notes, expected_revision=workout["revision"], request_id=request_id)


def feedback(workout: dict, note: str, preset, request_id: str) -> ExerciseNoteInput:
    return ExerciseNoteInput(note=note, preset=preset, expected_revision=workout["revision"], request_id=request_id)


@pytest.mark.asyncio
async def test_materialized_workout_defaults_notes_to_empty():
    database = FakeDatabase()
    service, workout = await generated_day(database)

    assert workout["notes"] == ""
    assert (await service.workout("acc_one", workout["workout_id"]))["notes"] == ""


@pytest.mark.asyncio
async def test_day_note_write_bumps_revision_and_reads_back():
    database = FakeDatabase()
    service, workout = await generated_day(database)

    response = await service.update_notes("acc_one", workout["workout_id"], day_note(workout, "Felt strong today.", "notes-001"))

    assert response["effect"] == "notes_updated"
    assert response["resource"] == "workout"
    assert response["resource_id"] == workout["workout_id"]
    assert response["request_id"] == "notes-001"
    assert response["revision"] != workout["revision"]
    assert response["workout"]["notes"] == "Felt strong today."
    readback = await service.workout("acc_one", workout["workout_id"])
    assert readback["notes"] == "Felt strong today."
    assert readback["revision"] == response["revision"]


@pytest.mark.asyncio
async def test_day_note_rejects_a_stale_revision_without_writing():
    database = FakeDatabase()
    service, workout = await generated_day(database)

    with pytest.raises(WorkoutDomainError) as error:
        await service.update_notes(
            "acc_one", workout["workout_id"],
            WorkoutNotesInput(notes="Too late.", expected_revision="rev_ffffffffffffffffffffffffffffffff", request_id="notes-stale-001"),
        )

    assert error.value.code == "stale_revision"
    assert error.value.status_code == 409
    assert (await service.workout("acc_one", workout["workout_id"]))["notes"] == ""
    assert not any(row["request_id"] == "notes-stale-001" for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_day_note_replay_is_idempotent():
    database = FakeDatabase()
    service, workout = await generated_day(database)

    first = await service.update_notes("acc_one", workout["workout_id"], day_note(workout, "Same note.", "notes-replay-001"))
    second = await service.update_notes("acc_one", workout["workout_id"], day_note(workout, "Same note.", "notes-replay-001"))

    assert second == first
    stored = database.documents["workouts"][0]
    assert stored["notes"] == "Same note."
    assert stored["revision"] == first["revision"]
    assert len(database.documents["mutation_receipts"]) == 3


@pytest.mark.asyncio
async def test_day_note_rejects_a_reused_request_id_with_different_content():
    database = FakeDatabase()
    service, workout = await generated_day(database)

    await service.update_notes("acc_one", workout["workout_id"], day_note(workout, "First note.", "notes-conflict-001"))

    with pytest.raises(WorkoutDomainError) as error:
        await service.update_notes("acc_one", workout["workout_id"], day_note(workout, "Different note.", "notes-conflict-001"))

    assert error.value.code == "idempotency_conflict"
    assert (await service.workout("acc_one", workout["workout_id"]))["notes"] == "First note."


@pytest.mark.asyncio
async def test_day_note_rejects_an_unknown_workout():
    database = FakeDatabase()
    service = WorkoutService(database)

    with pytest.raises(WorkoutDomainError) as error:
        await service.update_notes(
            "acc_one", "wrk_ffffffffffffffffffffffffffffffff",
            WorkoutNotesInput(notes="Nowhere.", expected_revision="rev_ffffffffffffffffffffffffffffffff", request_id="notes-missing-001"),
        )

    assert error.value.code == "workout_not_found"
    assert error.value.status_code == 404


def test_day_note_length_is_bounded():
    with pytest.raises(ValidationError):
        WorkoutNotesInput(notes="x" * 4_001, expected_revision="rev_ffffffffffffffffffffffffffffffff", request_id="notes-too-long-001")
    assert WorkoutNotesInput(notes="x" * 4_000, expected_revision="rev_ffffffffffffffffffffffffffffffff", request_id="notes-max-001").notes


@pytest.mark.asyncio
async def test_exercise_feedback_write_stores_note_and_preset():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]

    response = await service.update_exercise_notes(
        "acc_one", workout["workout_id"], instance_id, feedback(workout, "Elbow pain on the last set.", "pain", "feedback-001"),
    )

    assert response["effect"] == "feedback_updated"
    assert response["revision"] != workout["revision"]
    item = response["workout"]["segments"][0]["items"][0]
    assert item["notes"]["note"] == "Elbow pain on the last set."
    assert item["notes"]["preset"] == "pain"
    assert item["notes"]["updated_at"]
    readback = await service.workout("acc_one", workout["workout_id"])
    assert readback["segments"][0]["items"][0]["notes"] == item["notes"]


@pytest.mark.asyncio
async def test_exercise_feedback_accepts_a_null_preset_and_an_edited_note():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]

    first = await service.update_exercise_notes(
        "acc_one", workout["workout_id"], instance_id, feedback(workout, "Felt easy.", "easy", "feedback-002"),
    )
    second = await service.update_exercise_notes(
        "acc_one", workout["workout_id"], instance_id, feedback(first["workout"], "Form broke on rep eight.", None, "feedback-003"),
    )

    notes = second["workout"]["segments"][0]["items"][0]["notes"]
    assert notes["note"] == "Form broke on rep eight."
    assert notes["preset"] is None


@pytest.mark.asyncio
async def test_exercise_feedback_rejects_a_stale_revision_without_writing():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.update_exercise_notes(
            "acc_one", workout["workout_id"], instance_id,
            ExerciseNoteInput(note="Too late.", preset="hard", expected_revision="rev_ffffffffffffffffffffffffffffffff", request_id="feedback-stale-001"),
        )

    assert error.value.code == "stale_revision"
    assert "notes" not in (await service.workout("acc_one", workout["workout_id"]))["segments"][0]["items"][0]
    assert not any(row["request_id"] == "feedback-stale-001" for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_exercise_feedback_replay_is_idempotent():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]

    first = await service.update_exercise_notes("acc_one", workout["workout_id"], instance_id, feedback(workout, "Hard today.", "hard", "feedback-replay-001"))
    second = await service.update_exercise_notes("acc_one", workout["workout_id"], instance_id, feedback(workout, "Hard today.", "hard", "feedback-replay-001"))

    assert second == first
    stored = database.documents["workouts"][0]
    assert stored["revision"] == first["revision"]
    assert stored["segments"][0]["items"][0]["notes"]["preset"] == "hard"
    assert len(database.documents["mutation_receipts"]) == 3


@pytest.mark.asyncio
async def test_exercise_feedback_rejects_an_unknown_exercise_instance():
    database = FakeDatabase()
    service, workout = await generated_day(database)

    with pytest.raises(WorkoutDomainError) as error:
        await service.update_exercise_notes(
            "acc_one", workout["workout_id"], "wex_ffffffffffffffffffffffffffffffff", feedback(workout, "Nowhere.", None, "feedback-missing-001"),
        )

    assert error.value.code == "exercise_instance_not_found"
    assert error.value.status_code == 404


def test_exercise_feedback_rejects_an_unknown_preset():
    with pytest.raises(ValidationError):
        ExerciseNoteInput(
            note="Invalid.", preset="sore", expected_revision="rev_ffffffffffffffffffffffffffffffff", request_id="feedback-bad-preset-001",
        )


@pytest.mark.asyncio
async def test_override_preserves_a_saved_day_note():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    saved = await service.update_notes("acc_one", workout["workout_id"], day_note(workout, "Travel day note.", "notes-override-001"))

    response = await service.override(
        "acc_one",
        WorkoutOverrideInput(
            date="2026-09-21",
            title="Travel gym",
            reason_md="The user asked for a different day.",
            segments=override_segments(),
            expected_revision=saved["revision"],
            request_id="override-notes-001",
        ),
        {"kind": "agent", "job_id": "job_one"},
    )

    assert response["workout"]["notes"] == "Travel day note."


@pytest.mark.asyncio
async def test_swap_clears_feedback_when_the_exercise_changes():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]
    saved = await service.update_exercise_notes(
        "acc_one", workout["workout_id"], instance_id, feedback(workout, "Pain here.", "pain", "feedback-swap-001"),
    )

    swapped = await service.swap(
        "acc_one", saved["workout"]["workout_id"], instance_id,
        SwapInput(expected_revision=saved["revision"], reason="The machine is occupied.", request_id="swap-notes-001"),
    )

    items = swapped["workout"]["segments"][0]["items"]
    assert len(items) == 1
    assert items[0]["exercise_instance_id"] == instance_id
    assert items[0]["exercise_snapshot"]["exercise_id"] == "ex_chest_supported_row_cable"
    assert "notes" not in items[0]


@pytest.mark.asyncio
async def test_partial_swap_keeps_feedback_on_the_logged_exercise():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]
    saved = await service.update_exercise_notes(
        "acc_one", workout["workout_id"], instance_id, feedback(workout, "Pain here.", "pain", "feedback-swap-002"),
    )
    set_id = saved["workout"]["segments"][0]["items"][0]["sets"][0]["set_id"]
    logged = await service.log_set(
        "acc_one", saved["workout"]["workout_id"], set_id,
        SetLogInput(actual=SetActual(status="completed", reps=10), expected_revision=saved["revision"], request_id="log-swap-notes-002"),
    )

    swapped = await service.swap(
        "acc_one", logged["workout"]["workout_id"], instance_id,
        SwapInput(expected_revision=logged["revision"], reason="The machine is occupied.", request_id="swap-notes-002"),
    )

    items = swapped["workout"]["segments"][0]["items"]
    assert [item["exercise_snapshot"]["exercise_id"] for item in items] == ["ex_chest_supported_row_machine", "ex_chest_supported_row_cable"]
    assert items[0]["notes"]["note"] == "Pain here."
    assert "notes" not in items[1]
