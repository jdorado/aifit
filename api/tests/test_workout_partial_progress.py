import pytest

from aifit_api.workouts import (
    BlueprintInput,
    GenerateInput,
    SetActual,
    SetLogInput,
    SwapInput,
    WorkoutDomainError,
    WorkoutOverrideInput,
    WorkoutService,
)

from test_workout_contract import blueprint
from test_workout_transactions import FakeDatabase


ROW = "ex_chest_supported_row_machine"
CABLE = "ex_chest_supported_row_cable"


def override_segments() -> list[dict]:
    return [{
        "segment_id": "seg_main",
        "order": 1,
        "kind": "straight_sets",
        "rounds": 2,
        "rest_after_round_seconds": 60,
        "slots": [{
            "slot_id": "slot_press",
            "order": 1,
            "role": "horizontal_push",
            "selection_count": 1,
            "candidates": [{
                "candidate_id": "cand_press",
                "exercise_id": "ex_incline_press",
                "exercise_revision": "rev_11111111111111111111111111111111",
                "priority": 1,
                "rationale_md": "Resolved for today.",
                "prescription": {
                    "metric": "reps",
                    "target": {"reps": {"min": 8, "max": 10}, "load": {"value": 20, "unit": "kg"}},
                    "rest_seconds": 60,
                },
                "progression": {"kind": "none"},
            }],
        }],
    }]


async def generated_day(database) -> tuple[WorkoutService, dict]:
    service = WorkoutService(database)
    await service.solidify_blueprint(
        "acc_one", BlueprintInput(**blueprint()), None, "solidify-001", {"kind": "agent", "job_id": "job_one"},
    )
    response = await service.generate("acc_one", GenerateInput(date="2026-09-21", request_id="generate-001"))
    return service, response["workout"]


async def log_set_at(service: WorkoutService, workout: dict, index: int, request_id: str) -> tuple[dict, str]:
    set_id = workout["segments"][0]["items"][0]["sets"][index]["set_id"]
    response = await service.log_set(
        "acc_one",
        workout["workout_id"],
        set_id,
        SetLogInput(
            actual=SetActual(status="completed", reps=10, load={"value": 40, "unit": "kg"}),
            expected_revision=workout["revision"],
            request_id=request_id,
        ),
    )
    return response["workout"], set_id


@pytest.mark.asyncio
async def test_swap_keeps_logged_sets_and_swaps_only_the_open_ones():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, logged_set_id = await log_set_at(service, workout, 0, "log-001")
    target = workout["segments"][0]["items"][0]["exercise_instance_id"]

    result = await service.swap(
        "acc_one", workout["workout_id"], target,
        SwapInput(expected_revision=workout["revision"], reason="The machine is occupied.", request_id="swap-001"),
    )

    assert result["effect"] == "swapped"
    assert result["workout"]["status"] == "in_progress"
    items = result["workout"]["segments"][0]["items"]
    assert [item["exercise_snapshot"]["exercise_id"] for item in items] == [ROW, CABLE]
    assert [set_row["set_id"] for set_row in items[0]["sets"]] == [logged_set_id]
    assert items[0]["sets"][0]["actual"]["reps"] == 10
    assert [set_row["round"] for set_row in items[1]["sets"]] == [2, 3]
    assert all(set_row["actual"] is None for set_row in items[1]["sets"])


@pytest.mark.asyncio
async def test_swap_rejects_an_exercise_whose_every_set_is_logged():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    for index in range(3):
        workout, _ = await log_set_at(service, workout, index, f"log-{index:03d}")
    assert workout["status"] == "completed"
    target = workout["segments"][0]["items"][0]["exercise_instance_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.swap(
            "acc_one", workout["workout_id"], target,
            SwapInput(expected_revision=workout["revision"], reason="Too late.", request_id="swap-locked-001"),
        )

    assert error.value.code == "completed_exercise_locked"
    assert not any(row["request_id"] == "swap-locked-001" for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_override_keeps_logged_sets_and_replaces_only_open_work():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, logged_set_id = await log_set_at(service, workout, 0, "log-001")

    response = await service.override(
        "acc_one",
        WorkoutOverrideInput(
            date="2026-09-21",
            title="Travel gym",
            reason_md="The user asked for a different day.",
            segments=override_segments(),
            expected_revision=workout["revision"],
            request_id="override-001",
        ),
        {"kind": "agent", "job_id": "job_one"},
    )

    merged = response["workout"]
    assert response["effect"] == "agent_override"
    assert merged["status"] == "in_progress"
    assert [segment["segment_id"] for segment in merged["segments"]] == ["seg_main", "seg_main_2"]
    kept = merged["segments"][0]["items"]
    assert [item["exercise_snapshot"]["exercise_id"] for item in kept] == [ROW]
    assert [set_row["set_id"] for set_row in kept[0]["sets"]] == [logged_set_id]
    assert kept[0]["sets"][0]["actual"]["reps"] == 10
    added = merged["segments"][1]["items"]
    assert [item["exercise_snapshot"]["exercise_id"] for item in added] == ["ex_incline_press"]
    assert all(set_row["actual"] is None for item in added for set_row in item["sets"])
    assert merged["lineage"]["source"] == "agent_override"
    assert merged["lineage"]["override"]["replaced_revision"] == workout["revision"]


@pytest.mark.asyncio
async def test_override_without_logs_still_replaces_the_whole_day():
    database = FakeDatabase()
    service, workout = await generated_day(database)

    response = await service.override(
        "acc_one",
        WorkoutOverrideInput(
            date="2026-09-21",
            title="Travel gym",
            reason_md="The user asked for a different day.",
            segments=override_segments(),
            expected_revision=workout["revision"],
            request_id="override-002",
        ),
        {"kind": "agent", "job_id": "job_one"},
    )

    merged = response["workout"]
    assert merged["status"] == "planned"
    assert len(merged["segments"]) == 1
    assert [item["exercise_snapshot"]["exercise_id"] for item in merged["segments"][0]["items"]] == ["ex_incline_press"]
