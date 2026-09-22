from types import SimpleNamespace

import pytest

from aifit_api.workouts import (
    BlueprintInput,
    ClearWorkoutInput,
    CopyLastWeekInput,
    GenerateInput,
    SetActual,
    SetLogInput,
    WorkoutDomainError,
    WorkoutService,
)

from test_workout_contract import blueprint
from test_workout_transactions import FakeCollection, FakeDatabase, matches


SOURCE_DATE = "2026-09-21"
TARGET_DATE = "2026-09-28"
MISSING_REVISION = "rev_" + "0" * 32


class DayShortcutCollection(FakeCollection):
    async def delete_one(self, query, **_kwargs):
        for index, row in enumerate(self.documents):
            if matches(row, query):
                self.documents.pop(index)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)


class DayShortcutDatabase(FakeDatabase):
    def __getattr__(self, name):
        if name in self.documents:
            return DayShortcutCollection(self, name)
        raise AttributeError(name)


async def generated_day(database) -> tuple[WorkoutService, dict]:
    service = WorkoutService(database)
    await service.solidify_blueprint(
        "acc_one", BlueprintInput(**blueprint()), None, "solidify-001", {"kind": "agent", "job_id": "job_one"},
    )
    response = await service.generate("acc_one", GenerateInput(date=SOURCE_DATE, request_id="generate-001"))
    return service, response["workout"]


async def copied_target(service: WorkoutService) -> dict:
    response = await service.copy_last_week(
        "acc_one", CopyLastWeekInput(date=TARGET_DATE, request_id="copy-target-001"),
    )
    return response["workout"]


async def log_first_set(service: WorkoutService, workout: dict, request_id: str) -> dict:
    set_id = workout["segments"][0]["items"][0]["sets"][0]["set_id"]
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
    return response["workout"]


@pytest.mark.asyncio
async def test_copy_last_week_keeps_segment_labels_from_the_source_day():
    database = DayShortcutDatabase()
    source_segment = {
        "segment_id": "seg_source",
        "order": 1,
        "kind": "circuit",
        "title": "Arms Pair",
        "rounds": 2,
        "rest_after_round_seconds": 60,
        "items": [{
            "exercise_instance_id": "wex_source",
            "slot_id": "slot_legacy_biceps",
            "candidate_id": "cand_legacy_biceps",
            "order": 1,
            "exercise_snapshot": {
                "exercise_id": "ex_biceps_curl_machine", "exercise_revision": "rev_" + "1" * 32,
                "name": "Biceps Curl Machine", "movement_pattern": "elbow_flexion",
                "primary_muscles": ["biceps"], "secondary_muscles": [], "equipment_kind": "machine",
                "laterality": "bilateral", "load_basis": "total", "equipment_profile_id": None,
            },
            "sets": [{"set_id": "set_source", "kind": "work", "target": {"reps": {"min": 8, "max": 8}, "load": {"value": 40, "unit": "kg"}}, "actual": None, "round": 1}],
            "cues_md": "",
        }],
    }
    database.documents["workouts"].append({
        "account_id": "acc_one", "workout_id": "wrk_source", "revision": "rev_" + "2" * 32,
        "date": SOURCE_DATE, "timezone": "Asia/Dubai", "status": "planned", "title": "Mon",
        "notes": "", "segments": [source_segment], "lineage": {"source": "legacy_import"},
        "created_at": "2026-09-21T10:00:00Z", "updated_at": "2026-09-21T10:00:00Z",
    })

    service = WorkoutService(database)
    response = await service.copy_last_week("acc_one", CopyLastWeekInput(date=TARGET_DATE, request_id="copy-title-001"))

    copied = response["workout"]["segments"][0]
    assert copied["title"] == "Arms Pair"
    assert copied["kind"] == "circuit"
    assert copied["items"][0]["sets"][0]["actual"] is None


@pytest.mark.asyncio
async def test_copy_last_week_omits_an_absent_segment_label():
    database = DayShortcutDatabase()
    database.documents["workouts"].append({
        "account_id": "acc_one", "workout_id": "wrk_source", "revision": "rev_" + "3" * 32,
        "date": SOURCE_DATE, "timezone": "Asia/Dubai", "status": "planned", "title": "Mon",
        "notes": "", "lineage": {"source": "legacy_import"},
        "segments": [{
            "segment_id": "seg_source",
            "order": 1,
            "kind": "circuit",
            "rounds": 2,
            "rest_after_round_seconds": 60,
            "items": [{
                "exercise_instance_id": "wex_source",
                "slot_id": "slot_legacy_biceps",
                "candidate_id": "cand_legacy_biceps",
                "order": 1,
                "exercise_snapshot": {
                    "exercise_id": "ex_biceps_curl_machine", "exercise_revision": "rev_" + "1" * 32,
                    "name": "Biceps Curl Machine", "movement_pattern": "elbow_flexion",
                    "primary_muscles": ["biceps"], "secondary_muscles": [], "equipment_kind": "machine",
                    "laterality": "bilateral", "load_basis": "total", "equipment_profile_id": None,
                },
                "sets": [{"set_id": "set_source", "kind": "work", "target": {"reps": {"min": 8, "max": 8}, "load": {"value": 40, "unit": "kg"}}, "actual": None, "round": 1}],
                "cues_md": "",
            }],
        }],
        "created_at": "2026-09-21T10:00:00Z", "updated_at": "2026-09-21T10:00:00Z",
    })

    service = WorkoutService(database)
    response = await service.copy_last_week("acc_one", CopyLastWeekInput(date=TARGET_DATE, request_id="copy-002"))

    for segment in response["workout"]["segments"]:
        assert "title" not in segment


@pytest.mark.asyncio
async def test_copy_last_week_creates_fresh_planned_structure():
    database = DayShortcutDatabase()
    service, source = await generated_day(database)

    response = await service.copy_last_week(
        "acc_one", CopyLastWeekInput(date=TARGET_DATE, request_id="copy-001"),
    )

    copied = response["workout"]
    assert response["status"] == "saved"
    assert response["effect"] == "copied"
    assert response["resource"] == "workout"
    assert response["revision"] == copied["revision"]
    assert copied["date"] == TARGET_DATE
    assert copied["status"] == "planned"
    assert copied["title"] == source["title"]
    assert copied["timezone"] == source["timezone"]
    assert copied["lineage"]["source"] == "copy_last_week"
    assert copied["lineage"]["copied_from"]["workout_id"] == source["workout_id"]
    assert copied["lineage"]["copied_from"]["date"] == SOURCE_DATE
    assert copied["lineage"]["blueprint_id"] == source["lineage"]["blueprint_id"]

    source_items = [item for segment in source["segments"] for item in segment["items"]]
    copied_items = [item for segment in copied["segments"] for item in segment["items"]]
    source_sets = [set_row for item in source_items for set_row in item["sets"]]
    copied_sets = [set_row for item in copied_items for set_row in item["sets"]]

    assert copied_items and copied_sets and len(copied_sets) == len(source_sets)
    assert all(set_row["actual"] is None for set_row in copied_sets)
    assert {set_row["set_id"] for set_row in copied_sets}.isdisjoint({set_row["set_id"] for set_row in source_sets})
    assert {item["exercise_instance_id"] for item in copied_items}.isdisjoint({item["exercise_instance_id"] for item in source_items})
    assert {segment["segment_id"] for segment in copied["segments"]}.isdisjoint({segment["segment_id"] for segment in source["segments"]})
    assert [item["exercise_snapshot"]["exercise_id"] for item in copied_items] == [
        item["exercise_snapshot"]["exercise_id"] for item in source_items
    ]
    assert [set_row["target"] for set_row in copied_sets] == [set_row["target"] for set_row in source_sets]

    # The source day is untouched and the target is a second record.
    unchanged = await service.workout("acc_one", source["workout_id"])
    assert unchanged["revision"] == source["revision"]
    assert len(database.documents["workouts"]) == 2


@pytest.mark.asyncio
async def test_copy_last_week_replaces_an_unlogged_target_in_place():
    database = DayShortcutDatabase()
    service, _source = await generated_day(database)
    target = await copied_target(service)
    first_revision = target["revision"]

    response = await service.copy_last_week(
        "acc_one",
        CopyLastWeekInput(date=TARGET_DATE, expected_revision=target["revision"], request_id="copy-002"),
    )

    assert response["workout"]["workout_id"] == target["workout_id"]
    assert response["workout"]["revision"] != first_revision
    assert response["workout"]["created_at"] == target["created_at"]
    assert len([row for row in database.documents["workouts"] if row["date"] == TARGET_DATE]) == 1


@pytest.mark.asyncio
async def test_copy_last_week_protects_logged_history_on_the_target():
    database = DayShortcutDatabase()
    service, _source = await generated_day(database)
    target = await copied_target(service)
    target = await log_first_set(service, target, "log-target-001")

    with pytest.raises(WorkoutDomainError) as error:
        await service.copy_last_week(
            "acc_one",
            CopyLastWeekInput(date=TARGET_DATE, expected_revision=target["revision"], request_id="copy-logged-001"),
        )

    assert error.value.code == "workout_has_logged_sets"
    assert error.value.status_code == 409
    kept = await service.workout("acc_one", target["workout_id"])
    assert kept["revision"] == target["revision"]
    assert kept["segments"][0]["items"][0]["sets"][0]["actual"]["reps"] == 10
    assert not any(row["request_id"] == "copy-logged-001" for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_copy_last_week_rejects_a_stale_target_revision():
    database = DayShortcutDatabase()
    service, _source = await generated_day(database)
    await copied_target(service)

    with pytest.raises(WorkoutDomainError) as error:
        await service.copy_last_week(
            "acc_one",
            CopyLastWeekInput(date=TARGET_DATE, expected_revision=MISSING_REVISION, request_id="copy-stale-001"),
        )

    assert error.value.code == "stale_revision"
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_copy_last_week_reports_a_missing_source_day():
    database = DayShortcutDatabase()
    service = WorkoutService(database)

    with pytest.raises(WorkoutDomainError) as error:
        await service.copy_last_week(
            "acc_one", CopyLastWeekInput(date=TARGET_DATE, request_id="copy-missing-001"),
        )

    assert error.value.code == "copy_source_missing"
    assert error.value.status_code == 404
    assert database.documents["workouts"] == []


@pytest.mark.asyncio
async def test_copy_last_week_replay_returns_the_same_receipt():
    database = DayShortcutDatabase()
    service, _source = await generated_day(database)
    payload = CopyLastWeekInput(date=TARGET_DATE, request_id="copy-replay-001")

    first = await service.copy_last_week("acc_one", payload)
    second = await service.copy_last_week("acc_one", payload)

    assert second == first
    assert len([row for row in database.documents["workouts"] if row["date"] == TARGET_DATE]) == 1
    assert len([row for row in database.documents["mutation_receipts"] if row["request_id"] == "copy-replay-001"]) == 1


@pytest.mark.asyncio
async def test_clear_removes_the_workout_when_nothing_is_logged():
    database = DayShortcutDatabase()
    service, workout = await generated_day(database)

    response = await service.clear_workout(
        "acc_one",
        workout["workout_id"],
        ClearWorkoutInput(expected_revision=workout["revision"], request_id="clear-001"),
    )

    assert response["status"] == "saved"
    assert response["effect"] == "cleared"
    assert response["resource_id"] == workout["workout_id"]
    assert response["revision"] == workout["revision"]
    assert response["workout"] is None
    assert database.documents["workouts"] == []
    with pytest.raises(WorkoutDomainError) as error:
        await service.workout("acc_one", workout["workout_id"])
    assert error.value.code == "workout_not_found"


@pytest.mark.asyncio
async def test_clear_keeps_logged_sets_verbatim_and_reduces_the_day():
    database = DayShortcutDatabase()
    service, workout = await generated_day(database)
    workout = await log_first_set(service, workout, "log-001")
    logged_item = workout["segments"][0]["items"][0]
    logged_set_id = logged_item["sets"][0]["set_id"]

    response = await service.clear_workout(
        "acc_one",
        workout["workout_id"],
        ClearWorkoutInput(expected_revision=workout["revision"], request_id="clear-002"),
    )

    reduced = response["workout"]
    assert response["effect"] == "cleared"
    assert reduced["workout_id"] == workout["workout_id"]
    assert reduced["revision"] != workout["revision"]
    assert reduced["status"] == "completed"
    assert [segment["segment_id"] for segment in reduced["segments"]] == [workout["segments"][0]["segment_id"]]
    items = reduced["segments"][0]["items"]
    assert len(items) == 1
    assert items[0]["exercise_instance_id"] == logged_item["exercise_instance_id"]
    assert items[0]["exercise_snapshot"] == logged_item["exercise_snapshot"]
    assert [set_row["set_id"] for set_row in items[0]["sets"]] == [logged_set_id]
    assert items[0]["sets"][0]["actual"] == logged_item["sets"][0]["actual"]
    assert items[0]["sets"][0]["target"] == logged_item["sets"][0]["target"]
    stored = await service.workout("acc_one", workout["workout_id"])
    assert stored["revision"] == reduced["revision"]
    assert len(stored["segments"][0]["items"][0]["sets"]) == 1


@pytest.mark.asyncio
async def test_clear_rejects_a_stale_revision():
    database = DayShortcutDatabase()
    service, workout = await generated_day(database)

    with pytest.raises(WorkoutDomainError) as error:
        await service.clear_workout(
            "acc_one",
            workout["workout_id"],
            ClearWorkoutInput(expected_revision=MISSING_REVISION, request_id="clear-stale-001"),
        )

    assert error.value.code == "stale_revision"
    assert error.value.status_code == 409
    assert len(database.documents["workouts"]) == 1


@pytest.mark.asyncio
async def test_clear_replay_returns_the_deleted_day_receipt():
    database = DayShortcutDatabase()
    service, workout = await generated_day(database)
    payload = ClearWorkoutInput(expected_revision=workout["revision"], request_id="clear-replay-001")

    first = await service.clear_workout("acc_one", workout["workout_id"], payload)
    second = await service.clear_workout("acc_one", workout["workout_id"], payload)

    assert second == first
    assert second["workout"] is None
    assert database.documents["workouts"] == []
    assert len([row for row in database.documents["mutation_receipts"] if row["request_id"] == "clear-replay-001"]) == 1
