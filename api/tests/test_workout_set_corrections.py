import pytest

from aifit_api.workouts import (
    SetActual,
    SetLogInput,
    SetUnlogInput,
    WorkoutDomainError,
    WorkoutService,
)

from test_workout_partial_progress import generated_day
from test_workout_transactions import FakeDatabase


def index_rows(database: FakeDatabase) -> list[dict]:
    return database.documents["performance_index"]


async def log_set_with_load(service: WorkoutService, workout: dict, index: int, request_id: str, value: float = 40) -> tuple[dict, str]:
    set_id = workout["segments"][0]["items"][0]["sets"][index]["set_id"]
    response = await service.log_set(
        "acc_one",
        workout["workout_id"],
        set_id,
        SetLogInput(
            actual=SetActual(status="completed", reps=10, load={"value": value, "unit": "kg"}),
            expected_revision=workout["revision"],
            request_id=request_id,
        ),
    )
    return response["workout"], set_id


@pytest.mark.asyncio
async def test_unlog_returns_a_logged_set_to_pending_and_removes_its_history():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_with_load(service, workout, 0, "log-001")
    assert workout["status"] == "in_progress"
    assert len(index_rows(database)) == 1

    response = await service.unlog_set(
        "acc_one", workout["workout_id"], set_id,
        SetUnlogInput(expected_revision=workout["revision"], request_id="unlog-001"),
    )

    assert response["effect"] == "set_unlogged"
    assert response["revision"] != workout["revision"]
    assert response["workout"]["status"] == "planned"
    set_row = response["workout"]["segments"][0]["items"][0]["sets"][0]
    assert set_row["actual"] is None
    assert index_rows(database) == []
    assert any(row["request_id"] == "unlog-001" for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_unlog_keeps_the_other_logged_sets_and_their_history():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, first_set_id = await log_set_with_load(service, workout, 0, "log-001")
    workout, second_set_id = await log_set_with_load(service, workout, 1, "log-002", value=45)
    assert workout["status"] == "in_progress"
    assert len(index_rows(database)) == 2

    response = await service.unlog_set(
        "acc_one", workout["workout_id"], first_set_id,
        SetUnlogInput(expected_revision=workout["revision"], request_id="unlog-002"),
    )

    assert response["workout"]["status"] == "in_progress"
    sets = response["workout"]["segments"][0]["items"][0]["sets"]
    assert sets[0]["actual"] is None
    assert sets[1]["actual"]["load"]["value"] == 45
    assert [row["set_id"] for row in index_rows(database)] == [second_set_id]


@pytest.mark.asyncio
async def test_unlog_rejects_a_pending_set_without_writing_a_receipt():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    set_id = workout["segments"][0]["items"][0]["sets"][0]["set_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.unlog_set(
            "acc_one", workout["workout_id"], set_id,
            SetUnlogInput(expected_revision=workout["revision"], request_id="unlog-pending-001"),
        )

    assert error.value.code == "set_not_logged"
    assert error.value.status_code == 409
    assert not any(row["request_id"] == "unlog-pending-001" for row in database.documents["mutation_receipts"])
    stored = database.documents["workouts"][0]
    assert stored["revision"] == workout["revision"]


@pytest.mark.asyncio
async def test_unlog_rejects_a_stale_revision():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    logged, set_id = await log_set_with_load(service, workout, 0, "log-001")

    with pytest.raises(WorkoutDomainError) as error:
        await service.unlog_set(
            "acc_one", logged["workout_id"], set_id,
            SetUnlogInput(expected_revision=workout["revision"], request_id="unlog-stale-001"),
        )

    assert error.value.code == "stale_revision"
    stored = database.documents["workouts"][0]
    assert stored["segments"][0]["items"][0]["sets"][0]["actual"]["status"] == "completed"
    assert len(index_rows(database)) == 1


@pytest.mark.asyncio
async def test_unlog_is_idempotent_for_the_same_request():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_with_load(service, workout, 0, "log-001")

    first = await service.unlog_set(
        "acc_one", workout["workout_id"], set_id,
        SetUnlogInput(expected_revision=workout["revision"], request_id="unlog-003"),
    )
    replay = await service.unlog_set(
        "acc_one", workout["workout_id"], set_id,
        SetUnlogInput(expected_revision=workout["revision"], request_id="unlog-003"),
    )

    assert replay == first
    stored = database.documents["workouts"][0]
    assert stored["revision"] == first["revision"]


@pytest.mark.asyncio
async def test_editing_a_logged_set_replaces_its_performance_row():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_with_load(service, workout, 0, "log-001")

    response = await service.log_set(
        "acc_one", workout["workout_id"], set_id,
        SetLogInput(
            actual=SetActual(status="completed", reps=8, load={"value": 45, "unit": "kg"}),
            expected_revision=workout["revision"],
            request_id="edit-001",
        ),
    )

    assert response["effect"] == "set_logged"
    assert response["revision"] != workout["revision"]
    assert response["workout"]["status"] == "in_progress"
    rows = index_rows(database)
    assert len(rows) == 1
    assert rows[0]["load"]["value"] == 45
    assert rows[0]["reps"] == 8
    assert response["workout"]["segments"][0]["items"][0]["sets"][0]["actual"]["reps"] == 8


@pytest.mark.asyncio
async def test_editing_a_completed_set_to_skipped_removes_its_performance_row():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_with_load(service, workout, 0, "log-001")

    response = await service.log_set(
        "acc_one", workout["workout_id"], set_id,
        SetLogInput(
            actual=SetActual(status="skipped"),
            expected_revision=workout["revision"],
            request_id="skip-001",
        ),
    )

    assert response["workout"]["segments"][0]["items"][0]["sets"][0]["actual"]["status"] == "skipped"
    assert response["workout"]["status"] == "in_progress"
    assert index_rows(database) == []


@pytest.mark.asyncio
async def test_editing_a_logged_set_without_a_load_removes_its_performance_row():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_with_load(service, workout, 0, "log-001")

    response = await service.log_set(
        "acc_one", workout["workout_id"], set_id,
        SetLogInput(
            actual=SetActual(status="completed", reps=12),
            expected_revision=workout["revision"],
            request_id="edit-002",
        ),
    )

    assert response["workout"]["segments"][0]["items"][0]["sets"][0]["actual"]["reps"] == 12
    assert index_rows(database) == []


@pytest.mark.asyncio
async def test_unlog_rolls_back_when_receipt_write_fails():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_with_load(service, workout, 0, "log-001")
    revision = workout["revision"]

    async def fail_receipt(*_args, **_kwargs):
        raise RuntimeError("receipt unavailable")

    service._save_receipt = fail_receipt
    with pytest.raises(RuntimeError, match="receipt unavailable"):
        await service.unlog_set(
            "acc_one", workout["workout_id"], set_id,
            SetUnlogInput(expected_revision=revision, request_id="unlog-transaction-001"),
        )

    stored = database.documents["workouts"][0]
    assert stored["revision"] == revision
    assert stored["segments"][0]["items"][0]["sets"][0]["actual"]["status"] == "completed"
    assert len(index_rows(database)) == 1
    assert database.aborted == 1
