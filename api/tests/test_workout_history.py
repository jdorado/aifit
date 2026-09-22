import pytest

from aifit_api.workouts import WorkoutDomainError, WorkoutService

from test_workout_transactions import FakeDatabase


def row(exercise_id: str, set_id: str, completed_at: str, account_id: str = "acc_one",
        pattern: str = "", muscles: list[str] | None = None) -> dict:
    return {
        "account_id": account_id,
        "load_key": f"{exercise_id}|None|total|bilateral",
        "exercise_id": exercise_id,
        "exercise_name": exercise_id.replace("ex_", "").replace("_", " ").title(),
        "movement_pattern": pattern,
        "primary_muscles": muscles or [],
        "workout_id": f"wrk_{set_id}",
        "exercise_instance_id": f"wex_{set_id}",
        "set_id": set_id,
        "date": completed_at[:10],
        "completed_at": completed_at,
        "load": {"value": 40, "unit": "kg"},
        "reps": 8,
    }


@pytest.mark.asyncio
async def test_history_returns_only_the_requested_exercise_newest_first():
    database = FakeDatabase()
    database.documents["performance_index"] = [
        row("ex_press", "set_old", "2026-09-01T10:00:00Z"),
        row("ex_row", "set_other", "2026-09-02T10:00:00Z"),
        row("ex_press", "set_new", "2026-09-03T10:00:00Z"),
        row("ex_press", "set_foreign", "2026-09-04T10:00:00Z", account_id="acc_two"),
    ]

    service = WorkoutService(database)
    rows = await service.history("acc_one", "ex_press")

    assert [item["set_id"] for item in rows] == ["set_new", "set_old"]


@pytest.mark.asyncio
async def test_history_prefix_does_not_match_a_longer_exercise_id():
    database = FakeDatabase()
    database.documents["performance_index"] = [
        row("ex_press", "set_press", "2026-09-01T10:00:00Z"),
        row("ex_press_machine", "set_machine", "2026-09-02T10:00:00Z"),
    ]

    service = WorkoutService(database)
    rows = await service.history("acc_one", "ex_press")

    assert [item["set_id"] for item in rows] == ["set_press"]


@pytest.mark.asyncio
async def test_related_history_splits_family_and_muscle_without_duplicates():
    database = FakeDatabase()
    database.documents["exercise_heads"] = [
        {"account_id": "acc_one", "exercise_id": "ex_back_squat", "revision": "rev_one"},
    ]
    database.documents["exercises"] = [
        {"account_id": "acc_one", "exercise_id": "ex_back_squat", "revision": "rev_one",
         "movement_pattern": "squat", "primary_muscles": ["quads"]},
    ]
    database.documents["performance_index"] = [
        row("ex_back_squat", "set_exact", "2026-09-04T10:00:00Z", pattern="squat", muscles=["quads"]),
        row("ex_front_squat", "set_family", "2026-09-03T10:00:00Z", pattern="squat", muscles=["quads"]),
        row("ex_leg_press", "set_family_muscle", "2026-09-02T10:00:00Z", pattern="squat", muscles=["glutes"]),
        row("ex_curl", "set_unrelated", "2026-09-01T10:00:00Z", pattern="elbow_flexion", muscles=["biceps"]),
        row("ex_back_squat", "set_foreign", "2026-09-05T10:00:00Z", account_id="acc_two", pattern="squat", muscles=["quads"]),
    ]

    service = WorkoutService(database)
    result = await service.related_history("acc_one", "ex_back_squat")

    assert result["movement_pattern"] == "squat"
    assert result["primary_muscle"] == "quads"
    assert [item["set_id"] for item in result["exact"]] == ["set_exact"]
    assert [item["set_id"] for item in result["family"]] == ["set_family", "set_family_muscle"]
    assert result["muscle"] == []


@pytest.mark.asyncio
async def test_related_history_muscle_rows_exclude_family_rows_and_general_patterns():
    database = FakeDatabase()
    database.documents["exercise_heads"] = [
        {"account_id": "acc_one", "exercise_id": "ex_goblet_squat", "revision": "rev_one"},
    ]
    database.documents["exercises"] = [
        {"account_id": "acc_one", "exercise_id": "ex_goblet_squat", "revision": "rev_one",
         "movement_pattern": "general", "primary_muscles": ["quads"]},
    ]
    database.documents["performance_index"] = [
        row("ex_goblet_squat", "set_exact", "2026-09-04T10:00:00Z", pattern="general", muscles=["quads"]),
        row("ex_back_squat", "set_muscle", "2026-09-03T10:00:00Z", pattern="squat", muscles=["quads"]),
        row("ex_curl", "set_unrelated", "2026-09-01T10:00:00Z", pattern="elbow_flexion", muscles=["biceps"]),
    ]

    service = WorkoutService(database)
    result = await service.related_history("acc_one", "ex_goblet_squat")

    assert result["family"] == []
    assert [item["set_id"] for item in result["muscle"]] == ["set_muscle"]


@pytest.mark.asyncio
async def test_related_history_requires_an_existing_exercise():
    database = FakeDatabase()
    service = WorkoutService(database)
    with pytest.raises(WorkoutDomainError) as error:
        await service.related_history("acc_one", "ex_missing")
    assert error.value.code == "exercise_not_found"
