import pytest

from aifit_api import main
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
        "title": "Press Main",
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
async def test_swap_with_explicit_target_candidate_applies_the_pick():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    target = workout["segments"][0]["items"][0]["exercise_instance_id"]

    result = await service.swap(
        "acc_one", workout["workout_id"], target,
        SwapInput(
            expected_revision=workout["revision"],
            reason="The user picked the cable alternative.",
            request_id="swap-target-001",
            target_candidate_id="cand_row_cable",
        ),
    )

    assert result["effect"] == "swapped"
    items = result["workout"]["segments"][0]["items"]
    assert [item["exercise_snapshot"]["exercise_id"] for item in items] == [CABLE]
    assert items[0]["candidate_id"] == "cand_row_cable"
    entry = result["workout"]["lineage"]["swaps"][-1]
    assert entry["target_candidate_id"] == "cand_row_cable"
    assert entry["probabilities"] == {"cand_row_cable": 1.0}


@pytest.mark.asyncio
async def test_swap_rejects_a_target_candidate_outside_the_slot():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    target = workout["segments"][0]["items"][0]["exercise_instance_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.swap(
            "acc_one", workout["workout_id"], target,
            SwapInput(
                expected_revision=workout["revision"],
                reason="No such candidate.",
                request_id="swap-target-002",
                target_candidate_id="cand_elsewhere",
            ),
        )

    assert error.value.code == "swap_target_not_in_slot"


@pytest.mark.asyncio
async def test_swap_rejects_the_already_selected_target_candidate():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    target = workout["segments"][0]["items"][0]["exercise_instance_id"]
    current = workout["segments"][0]["items"][0]["candidate_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.swap(
            "acc_one", workout["workout_id"], target,
            SwapInput(
                expected_revision=workout["revision"],
                reason="Same exercise.",
                request_id="swap-target-003",
                target_candidate_id=current,
            ),
        )

    assert error.value.code == "swap_target_unchanged"


@pytest.mark.asyncio
async def test_swap_candidates_lists_the_eligible_slot_alternatives():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    target = workout["segments"][0]["items"][0]["exercise_instance_id"]

    result = await service.swap_candidates("acc_one", workout["workout_id"], target)

    assert result["workout_id"] == workout["workout_id"]
    assert result["workout_revision"] == workout["revision"]
    assert result["exercise_instance_id"] == target
    assert result["current_candidate_id"] == workout["segments"][0]["items"][0]["candidate_id"]
    assert result["blueprint_revision"]
    assert [option["candidate_id"] for option in result["candidates"]] == ["cand_row_cable"]
    option = result["candidates"][0]
    assert option["name"] == "Chest Supported Row Cable"
    assert option["target_summary"] == "8-12 reps · 30kg"
    assert option["priority"] == 2


@pytest.mark.asyncio
async def test_swap_candidates_rejects_a_fully_logged_exercise():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    for index in range(3):
        workout, _ = await log_set_at(service, workout, index, f"log-{index:03d}")
    target = workout["segments"][0]["items"][0]["exercise_instance_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.swap_candidates("acc_one", workout["workout_id"], target)

    assert error.value.code == "completed_exercise_locked"


@pytest.mark.asyncio
async def test_swap_candidates_browser_route_delegates_to_the_service(monkeypatch):
    routes = [
        route for route in main.app.routes
        if getattr(route, "path", "") == "/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/swap-candidates"
    ]
    assert len(routes) == 1
    assert routes[0].methods == {"GET"}

    seen = {}

    class StubService:
        async def swap_candidates(self, account_id, workout_id, instance_id):
            seen.update(account_id=account_id, workout_id=workout_id, instance_id=instance_id)
            return {"workout_id": workout_id, "candidates": []}

    monkeypatch.setattr(main, "workouts", lambda: StubService())
    result = await main.swap_candidates_v1("wrk_one", "wex_one", {"account_id": "acc_one"})

    assert result == {"workout_id": "wrk_one", "candidates": []}
    assert seen == {"account_id": "acc_one", "workout_id": "wrk_one", "instance_id": "wex_one"}


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
