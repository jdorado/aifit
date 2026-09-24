import pytest

from aifit_api import main
from aifit_api.workouts import (
    PlanEntryRemoveInput,
    PlanItemMoveInput,
    PlanItemExtractInput,
    PlanReorderInput,
    SetAddInput,
    SetRemoveInput,
    SetTargetInput,
    Target,
    WorkoutDomainError,
    WorkoutService,
)

from test_workout_partial_progress import generated_day, log_set_at
from test_workout_transactions import FakeDatabase


REV = "rev_" + "a" * 32


def make_set(set_id: str, logged: bool = False, round_number: int = 1) -> dict:
    return {
        "set_id": set_id,
        "kind": "work",
        "target": {"reps": {"min": 8, "max": 10}, "load": {"value": 40.0, "unit": "kg"}},
        "actual": {
            "status": "completed",
            "reps": 10,
            "load": {"value": 40.0, "unit": "kg"},
            "completed_at": "2026-09-21T10:00:00Z",
        } if logged else None,
        "round": round_number,
    }


def make_item(instance_id: str, order: int, sets: list[dict]) -> dict:
    return {
        "exercise_instance_id": instance_id,
        "slot_id": f"slot_{instance_id}",
        "candidate_id": f"cand_{instance_id}",
        "order": order,
        "exercise_snapshot": {
            "exercise_id": f"ex_{instance_id}",
            "exercise_revision": "rev_" + "b" * 32,
            "name": instance_id,
            "movement_pattern": "horizontal_pull",
            "primary_muscles": ["latissimus_dorsi"],
            "secondary_muscles": [],
            "equipment_kind": "machine",
            "laterality": "bilateral",
            "load_basis": "total",
            "equipment_profile_id": None,
        },
        "sets": sets,
        "cues_md": "",
    }


def make_segment(segment_id: str, order: int, items: list[dict]) -> dict:
    return {
        "segment_id": segment_id,
        "order": order,
        "kind": "straight_sets",
        "title": segment_id,
        "rounds": 1,
        "rest_after_round_seconds": 60,
        "items": items,
    }


def insert_workout(database: FakeDatabase, segments: list[dict]) -> dict:
    document = {
        "account_id": "acc_one",
        "workout_id": "wrk_manual",
        "schema_version": 1,
        "revision": REV,
        "date": "2026-09-21",
        "timezone": "Asia/Dubai",
        "status": "planned",
        "title": "Manual",
        "notes": "",
        "segments": segments,
        "lineage": {"source": "legacy_import"},
        "created_at": "2026-09-21T09:00:00Z",
        "updated_at": "2026-09-21T09:00:00Z",
    }
    database.documents["workouts"].append(document)
    return document


@pytest.mark.asyncio
async def test_add_set_copies_last_non_warmup_target_and_replays_idempotently():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    stored = database.documents["workouts"][0]
    item = stored["segments"][0]["items"][0]
    work_target = item["sets"][-1]["target"]
    item["sets"].append({
        "set_id": "set_warmup",
        "kind": "warmup",
        "target": {"reps": {"min": 10, "max": 10}, "load": {"value": 20.0, "unit": "kg"}},
        "actual": None,
        "round": 0,
    })
    instance_id = item["exercise_instance_id"]

    response = await service.add_set(
        "acc_one", workout["workout_id"], instance_id,
        SetAddInput(expected_revision=workout["revision"], request_id="add-001"),
    )

    assert response["effect"] == "set_added"
    added = response["workout"]
    sets = added["segments"][0]["items"][0]["sets"]
    assert len(sets) == 5
    new_set = sets[-1]
    assert new_set["target"] == work_target
    assert new_set["kind"] == "work"
    assert new_set["round"] == 4
    assert new_set["actual"] is None
    assert added["revision"] != workout["revision"]
    assert added["status"] == "planned"

    replayed = await service.add_set(
        "acc_one", workout["workout_id"], instance_id,
        SetAddInput(expected_revision=workout["revision"], request_id="add-001"),
    )
    assert replayed == response
    assert len(database.documents["workouts"][0]["segments"][0]["items"][0]["sets"]) == 5


@pytest.mark.asyncio
async def test_remove_set_removes_unlogged_set_and_replays_idempotently():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    sets = workout["segments"][0]["items"][0]["sets"]
    removed_id = sets[0]["set_id"]
    remaining_ids = [set_row["set_id"] for set_row in sets[1:]]

    response = await service.remove_set(
        "acc_one", workout["workout_id"], removed_id,
        SetRemoveInput(expected_revision=workout["revision"], request_id="remove-001"),
    )

    assert response["effect"] == "set_removed"
    updated = response["workout"]
    assert [set_row["set_id"] for set_row in updated["segments"][0]["items"][0]["sets"]] == remaining_ids
    assert updated["revision"] != workout["revision"]
    assert updated["status"] == "planned"

    replayed = await service.remove_set(
        "acc_one", workout["workout_id"], removed_id,
        SetRemoveInput(expected_revision=workout["revision"], request_id="remove-001"),
    )
    assert replayed == response


@pytest.mark.asyncio
async def test_remove_set_keeps_the_instance_when_its_last_set_is_removed():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    for request_id, set_row in enumerate(workout["segments"][0]["items"][0]["sets"], start=1):
        response = await service.remove_set(
            "acc_one", workout["workout_id"], set_row["set_id"],
            SetRemoveInput(expected_revision=workout["revision"], request_id=f"remove-{request_id:03d}"),
        )
        workout = response["workout"]

    assert workout["segments"][0]["items"][0]["sets"] == []
    assert len(workout["segments"][0]["items"]) == 1
    assert workout["status"] == "planned"


@pytest.mark.asyncio
async def test_remove_set_rejects_a_logged_set():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_at(service, workout, 0, "log-001")

    with pytest.raises(WorkoutDomainError) as error:
        await service.remove_set(
            "acc_one", workout["workout_id"], set_id,
            SetRemoveInput(expected_revision=workout["revision"], request_id="remove-logged-001"),
        )

    assert error.value.code == "set_is_logged"
    assert error.value.status_code == 409
    assert not any(row["request_id"] == "remove-logged-001" for row in database.documents["mutation_receipts"])
    stored = database.documents["workouts"][0]
    assert stored["segments"][0]["items"][0]["sets"][0]["actual"]["status"] == "completed"


@pytest.mark.asyncio
async def test_update_set_target_replaces_the_target():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    sets = workout["segments"][0]["items"][0]["sets"]
    set_id = sets[1]["set_id"]
    original = [set_row["target"] for set_row in sets]
    new_target = Target(reps={"min": 8, "max": 10}, load={"value": 50, "unit": "kg"})

    response = await service.update_set_target(
        "acc_one", workout["workout_id"], set_id,
        SetTargetInput(target=new_target, apply_to_remaining=False,
                       expected_revision=workout["revision"], request_id="target-001"),
    )

    assert response["effect"] == "set_target_updated"
    updated = response["workout"]["segments"][0]["items"][0]["sets"]
    expected = new_target.model_dump(mode="json", exclude_none=True)
    assert updated[1]["target"] == expected
    assert updated[0]["target"] == original[0]
    assert updated[2]["target"] == original[2]
    assert response["workout"]["revision"] != workout["revision"]
    assert response["workout"]["status"] == "planned"


@pytest.mark.asyncio
async def test_update_set_target_apply_to_remaining_updates_only_later_unlogged_sets():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, _ = await log_set_at(service, workout, 0, "log-001")
    sets = workout["segments"][0]["items"][0]["sets"]
    set_id = sets[1]["set_id"]
    new_target = Target(reps={"min": 6, "max": 8}, load={"value": 60, "unit": "kg"})

    response = await service.update_set_target(
        "acc_one", workout["workout_id"], set_id,
        SetTargetInput(target=new_target, apply_to_remaining=True,
                       expected_revision=workout["revision"], request_id="target-apply-001"),
    )

    updated = response["workout"]["segments"][0]["items"][0]["sets"]
    expected = new_target.model_dump(mode="json", exclude_none=True)
    assert updated[0]["target"] == sets[0]["target"]
    assert updated[1]["target"] == expected
    assert updated[2]["target"] == expected
    assert updated[0]["actual"]["reps"] == 10


@pytest.mark.asyncio
async def test_update_set_target_apply_to_remaining_never_touches_logged_sets():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, _ = await log_set_at(service, workout, 0, "log-001")
    workout, _ = await log_set_at(service, workout, 2, "log-002")
    sets = workout["segments"][0]["items"][0]["sets"]
    set_id = sets[1]["set_id"]
    logged_second_target = sets[2]["target"]
    new_target = Target(reps={"min": 6, "max": 8}, load={"value": 60, "unit": "kg"})

    response = await service.update_set_target(
        "acc_one", workout["workout_id"], set_id,
        SetTargetInput(target=new_target, apply_to_remaining=True,
                       expected_revision=workout["revision"], request_id="target-apply-002"),
    )

    updated = response["workout"]["segments"][0]["items"][0]["sets"]
    expected = new_target.model_dump(mode="json", exclude_none=True)
    assert updated[0]["target"] == sets[0]["target"]
    assert updated[1]["target"] == expected
    assert updated[2]["target"] == logged_second_target
    assert updated[2]["actual"]["reps"] == 10


@pytest.mark.asyncio
async def test_update_set_target_rejects_a_logged_set():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout, set_id = await log_set_at(service, workout, 0, "log-001")

    with pytest.raises(WorkoutDomainError) as error:
        await service.update_set_target(
            "acc_one", workout["workout_id"], set_id,
            SetTargetInput(target=Target(reps={"min": 5, "max": 5}), apply_to_remaining=False,
                           expected_revision=workout["revision"], request_id="target-logged-001"),
        )

    assert error.value.code == "set_is_logged"
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_remove_exercise_drops_unlogged_sets_and_renumbers_items():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [
            make_item("wex_a", 1, [make_set("set_a1")]),
            make_item("wex_b", 2, [make_set("set_b1", logged=True), make_set("set_b2")]),
        ]),
    ])
    service = WorkoutService(database)

    response = await service.remove_exercise(
        "acc_one", "wrk_manual", "wex_a",
        PlanEntryRemoveInput(expected_revision=REV, request_id="remove-ex-001"),
    )

    assert response["effect"] == "exercise_removed"
    segments = response["workout"]["segments"]
    assert [segment["segment_id"] for segment in segments] == ["seg_one"]
    items = segments[0]["items"]
    assert [item["exercise_instance_id"] for item in items] == ["wex_b"]
    assert items[0]["order"] == 1
    # The untouched sibling keeps both its logged and unlogged sets.
    assert [set_row["set_id"] for set_row in items[0]["sets"]] == ["set_b1", "set_b2"]
    assert items[0]["sets"][0]["actual"]["reps"] == 10
    assert items[0]["sets"][1]["actual"] is None
    assert items[0]["exercise_snapshot"] == make_item("wex_b", 2, []).get("exercise_snapshot")


@pytest.mark.asyncio
async def test_remove_exercise_keeps_the_targets_logged_sets_verbatim():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [
            make_item("wex_a", 1, [make_set("set_a1", logged=True), make_set("set_a2")]),
            make_item("wex_b", 2, [make_set("set_b1")]),
        ]),
    ])
    service = WorkoutService(database)

    response = await service.remove_exercise(
        "acc_one", "wrk_manual", "wex_a",
        PlanEntryRemoveInput(expected_revision=REV, request_id="remove-ex-004"),
    )

    assert response["effect"] == "exercise_removed"
    items = response["workout"]["segments"][0]["items"]
    assert [item["exercise_instance_id"] for item in items] == ["wex_a", "wex_b"]
    assert [item["order"] for item in items] == [1, 2]
    kept = items[0]
    assert [set_row["set_id"] for set_row in kept["sets"]] == ["set_a1"]
    assert kept["sets"][0]["actual"]["reps"] == 10
    assert kept["sets"][0]["target"] == make_set("set_a1", logged=True)["target"]
    assert kept["exercise_snapshot"] == make_item("wex_a", 1, [])["exercise_snapshot"]


@pytest.mark.asyncio
async def test_remove_exercise_drops_an_empty_segment_and_renumbers_segments():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [make_item("wex_a", 1, [make_set("set_a1", logged=True)])]),
        make_segment("seg_two", 2, [make_item("wex_c", 1, [make_set("set_c1")])]),
    ])
    service = WorkoutService(database)

    response = await service.remove_exercise(
        "acc_one", "wrk_manual", "wex_c",
        PlanEntryRemoveInput(expected_revision=REV, request_id="remove-ex-002"),
    )

    assert response["effect"] == "exercise_removed"
    segments = response["workout"]["segments"]
    assert [segment["segment_id"] for segment in segments] == ["seg_one"]
    assert segments[0]["order"] == 1
    assert [item["exercise_instance_id"] for item in segments[0]["items"]] == ["wex_a"]
    assert segments[0]["items"][0]["sets"][0]["actual"]["reps"] == 10


@pytest.mark.asyncio
async def test_remove_exercise_deletes_the_workout_when_nothing_logged_remains():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [make_item("wex_a", 1, [make_set("set_a1")])]),
    ])
    service = WorkoutService(database)

    response = await service.remove_exercise(
        "acc_one", "wrk_manual", "wex_a",
        PlanEntryRemoveInput(expected_revision=REV, request_id="remove-ex-003"),
    )

    assert response["workout"] is None
    assert response["revision"] == REV
    assert database.documents["workouts"] == []


@pytest.mark.asyncio
async def test_remove_segment_applies_the_exercise_rule_to_every_item():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [
            make_item("wex_a", 1, [make_set("set_a1", logged=True), make_set("set_a2")]),
            make_item("wex_b", 2, [make_set("set_b1")]),
        ]),
        make_segment("seg_two", 2, [make_item("wex_c", 1, [make_set("set_c1", logged=True)])]),
    ])
    service = WorkoutService(database)

    response = await service.remove_segment(
        "acc_one", "wrk_manual", "seg_one",
        PlanEntryRemoveInput(expected_revision=REV, request_id="remove-seg-001"),
    )

    assert response["effect"] == "segment_removed"
    segments = response["workout"]["segments"]
    assert [segment["segment_id"] for segment in segments] == ["seg_one", "seg_two"]
    assert [segment["order"] for segment in segments] == [1, 2]
    kept = segments[0]["items"]
    assert [item["exercise_instance_id"] for item in kept] == ["wex_a"]
    assert kept[0]["order"] == 1
    assert [set_row["set_id"] for set_row in kept[0]["sets"]] == ["set_a1"]
    assert kept[0]["sets"][0]["actual"]["reps"] == 10
    assert [item["exercise_instance_id"] for item in segments[1]["items"]] == ["wex_c"]


@pytest.mark.asyncio
async def test_remove_segment_deletes_the_workout_when_nothing_logged_remains():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [make_item("wex_a", 1, [make_set("set_a1")])]),
    ])
    service = WorkoutService(database)

    response = await service.remove_segment(
        "acc_one", "wrk_manual", "seg_one",
        PlanEntryRemoveInput(expected_revision=REV, request_id="remove-seg-002"),
    )

    assert response["workout"] is None
    assert response["revision"] == REV
    assert database.documents["workouts"] == []


@pytest.mark.asyncio
async def test_plan_edits_reject_a_stale_revision():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    stale = "rev_" + "f" * 32
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.add_set(
            "acc_one", workout["workout_id"], instance_id,
            SetAddInput(expected_revision=stale, request_id="stale-001"),
        )

    assert error.value.code == "stale_revision"
    assert error.value.status_code == 409
    assert len(database.documents["workouts"]) == 1
    assert not any(row["request_id"] == "stale-001" for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_plan_edits_return_404_for_unknown_ids():
    database = FakeDatabase()
    service, workout = await generated_day(database)
    workout_id = workout["workout_id"]
    instance_id = workout["segments"][0]["items"][0]["exercise_instance_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.add_set(
            "acc_one", "wrk_missing", instance_id,
            SetAddInput(expected_revision=workout["revision"], request_id="missing-wrk-001"),
        )
    assert error.value.code == "workout_not_found"
    assert error.value.status_code == 404

    with pytest.raises(WorkoutDomainError) as error:
        await service.add_set(
            "acc_one", workout_id, "wex_missing",
            SetAddInput(expected_revision=workout["revision"], request_id="missing-wex-001"),
        )
    assert error.value.code == "exercise_instance_not_found"

    with pytest.raises(WorkoutDomainError) as error:
        await service.remove_set(
            "acc_one", workout_id, "set_missing",
            SetRemoveInput(expected_revision=workout["revision"], request_id="missing-set-001"),
        )
    assert error.value.code == "set_not_found"

    with pytest.raises(WorkoutDomainError) as error:
        await service.update_set_target(
            "acc_one", workout_id, "set_missing",
            SetTargetInput(target=Target(reps={"min": 5, "max": 5}),
                           expected_revision=workout["revision"], request_id="missing-set-002"),
        )
    assert error.value.code == "set_not_found"

    with pytest.raises(WorkoutDomainError) as error:
        await service.remove_exercise(
            "acc_one", workout_id, "wex_missing",
            PlanEntryRemoveInput(expected_revision=workout["revision"], request_id="missing-wex-002"),
        )
    assert error.value.code == "exercise_instance_not_found"

    with pytest.raises(WorkoutDomainError) as error:
        await service.remove_segment(
            "acc_one", workout_id, "seg_missing",
            PlanEntryRemoveInput(expected_revision=workout["revision"], request_id="missing-seg-001"),
        )
    assert error.value.code == "segment_not_found"

    with pytest.raises(WorkoutDomainError) as error:
        await service.move_item(
            "acc_one", workout_id, "wex_missing",
            PlanItemMoveInput(target_segment_id="seg_missing", target_index=1,
                              expected_revision=workout["revision"], request_id="missing-wex-003"),
        )
    assert error.value.code == "exercise_instance_not_found"

    with pytest.raises(WorkoutDomainError) as error:
        await service.move_item(
            "acc_one", workout_id, instance_id,
            PlanItemMoveInput(target_segment_id="seg_missing", target_index=1,
                              expected_revision=workout["revision"], request_id="missing-seg-002"),
        )
    assert error.value.code == "segment_not_found"


@pytest.mark.asyncio
async def test_reorder_segments_renumbers_and_replays_idempotently():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [make_item("wex_a", 1, [make_set("set_a1", logged=True)])]),
        make_segment("seg_two", 2, [make_item("wex_b", 1, [make_set("set_b1")])]),
        make_segment("seg_three", 3, [make_item("wex_c", 1, [make_set("set_c1")])]),
    ])
    service = WorkoutService(database)

    response = await service.reorder_segments(
        "acc_one", "wrk_manual",
        PlanReorderInput(segment_ids=["seg_three", "seg_one", "seg_two"],
                         expected_revision=REV, request_id="reorder-seg-001"),
    )

    assert response["effect"] == "segments_reordered"
    segments = response["workout"]["segments"]
    assert [segment["segment_id"] for segment in segments] == ["seg_three", "seg_one", "seg_two"]
    assert [segment["order"] for segment in segments] == [1, 2, 3]
    # Logged sets stay verbatim under their original snapshot.
    logged = segments[1]["items"][0]
    assert logged["exercise_instance_id"] == "wex_a"
    assert [set_row["set_id"] for set_row in logged["sets"]] == ["set_a1"]
    assert logged["sets"][0]["actual"]["reps"] == 10
    assert response["workout"]["revision"] != REV

    replayed = await service.reorder_segments(
        "acc_one", "wrk_manual",
        PlanReorderInput(segment_ids=["seg_three", "seg_one", "seg_two"],
                         expected_revision=REV, request_id="reorder-seg-001"),
    )
    assert replayed == response
    assert [segment["segment_id"] for segment in database.documents["workouts"][0]["segments"]] == ["seg_three", "seg_one", "seg_two"]


@pytest.mark.asyncio
async def test_reorder_segments_rejects_a_non_permutation():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [make_item("wex_a", 1, [make_set("set_a1")])]),
        make_segment("seg_two", 2, [make_item("wex_b", 1, [make_set("set_b1")])]),
    ])
    service = WorkoutService(database)

    for request_id, segment_ids in [
        ("reorder-bad-001", ["seg_one"]),
        ("reorder-bad-002", ["seg_one", "seg_one"]),
        ("reorder-bad-003", ["seg_one", "seg_missing"]),
    ]:
        with pytest.raises(WorkoutDomainError) as error:
            await service.reorder_segments(
                "acc_one", "wrk_manual",
                PlanReorderInput(segment_ids=segment_ids, expected_revision=REV, request_id=request_id),
            )
        assert error.value.code == "reorder_mismatch"
        assert error.value.status_code == 422

    assert [segment["segment_id"] for segment in database.documents["workouts"][0]["segments"]] == ["seg_one", "seg_two"]
    assert not any(row["request_id"].startswith("reorder-bad") for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_move_item_reorders_within_a_segment():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [
            make_item("wex_a", 1, [make_set("set_a1")]),
            make_item("wex_b", 2, [make_set("set_b1")]),
            make_item("wex_c", 3, [make_set("set_c1")]),
        ]),
    ])
    service = WorkoutService(database)

    response = await service.move_item(
        "acc_one", "wrk_manual", "wex_c",
        PlanItemMoveInput(target_segment_id="seg_one", target_index=1,
                          expected_revision=REV, request_id="move-item-001"),
    )

    assert response["effect"] == "item_moved"
    items = response["workout"]["segments"][0]["items"]
    assert [item["exercise_instance_id"] for item in items] == ["wex_c", "wex_a", "wex_b"]
    assert [item["order"] for item in items] == [1, 2, 3]
    assert [set_row["set_id"] for set_row in items[0]["sets"]] == ["set_c1"]

    replayed = await service.move_item(
        "acc_one", "wrk_manual", "wex_c",
        PlanItemMoveInput(target_segment_id="seg_one", target_index=1,
                          expected_revision=REV, request_id="move-item-001"),
    )
    assert replayed == response


@pytest.mark.asyncio
async def test_move_item_moves_across_segments_and_drops_the_empty_source():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [make_item("wex_a", 1, [make_set("set_a1", logged=True)])]),
        make_segment("seg_two", 2, [
            make_item("wex_b", 1, [make_set("set_b1")]),
            make_item("wex_c", 2, [make_set("set_c1")]),
        ]),
    ])
    service = WorkoutService(database)

    response = await service.move_item(
        "acc_one", "wrk_manual", "wex_a",
        PlanItemMoveInput(target_segment_id="seg_two", target_index=3,
                          expected_revision=REV, request_id="move-item-002"),
    )

    assert response["effect"] == "item_moved"
    segments = response["workout"]["segments"]
    assert [segment["segment_id"] for segment in segments] == ["seg_two"]
    assert segments[0]["order"] == 1
    items = segments[0]["items"]
    assert [item["exercise_instance_id"] for item in items] == ["wex_b", "wex_c", "wex_a"]
    assert [item["order"] for item in items] == [1, 2, 3]
    moved = items[2]
    assert [set_row["set_id"] for set_row in moved["sets"]] == ["set_a1"]
    assert moved["sets"][0]["actual"]["reps"] == 10
    assert moved["sets"][0]["target"] == make_set("set_a1", logged=True)["target"]
    assert moved["exercise_snapshot"] == make_item("wex_a", 1, [])["exercise_snapshot"]


@pytest.mark.asyncio
async def test_extract_bike_between_circuit_and_recovery_keeps_sets_and_membership():
    database = FakeDatabase()
    arms = make_segment("seg_arms", 1, [make_item("wex_arm", 1, [make_set("set_arm", logged=True)])])
    arms["kind"] = "circuit"
    recovery = make_segment("seg_recovery", 2, [
        make_item("wex_bike", 1, [make_set("set_bike")]),
        make_item("wex_stretch", 2, [make_set("set_stretch")]),
    ])
    recovery["title"] = "Evening Recovery"
    insert_workout(database, [arms, recovery])
    service = WorkoutService(database)

    response = await service.extract_item(
        "acc_one", "wrk_manual", "wex_bike",
        PlanItemExtractInput(before_segment_id="seg_recovery", expected_revision=REV, request_id="extract-bike-001"),
    )

    segments = response["workout"]["segments"]
    assert response["effect"] == "item_extracted"
    assert [segment["order"] for segment in segments] == [1, 2, 3]
    assert [segment["segment_id"] for segment in (segments[0], segments[2])] == ["seg_arms", "seg_recovery"]
    assert segments[1]["kind"] == "straight_sets"
    assert segments[1]["title"] == "wex_bike"
    assert [item["exercise_instance_id"] for item in segments[1]["items"]] == ["wex_bike"]
    assert [item["exercise_instance_id"] for item in segments[2]["items"]] == ["wex_stretch"]
    assert segments[1]["items"][0]["sets"][0]["set_id"] == "set_bike"
    assert segments[0]["items"][0]["sets"][0]["actual"]["reps"] == 10

    replayed = await service.extract_item(
        "acc_one", "wrk_manual", "wex_bike",
        PlanItemExtractInput(before_segment_id="seg_recovery", expected_revision=REV, request_id="extract-bike-001"),
    )
    assert replayed == response


@pytest.mark.asyncio
async def test_move_item_rejects_an_out_of_range_target_index():
    database = FakeDatabase()
    insert_workout(database, [
        make_segment("seg_one", 1, [make_item("wex_a", 1, [make_set("set_a1")])]),
        make_segment("seg_two", 2, [make_item("wex_b", 1, [make_set("set_b1")])]),
    ])
    service = WorkoutService(database)

    with pytest.raises(WorkoutDomainError) as error:
        await service.move_item(
            "acc_one", "wrk_manual", "wex_a",
            PlanItemMoveInput(target_segment_id="seg_two", target_index=3,
                              expected_revision=REV, request_id="move-item-003"),
        )

    assert error.value.code == "target_index_out_of_range"
    assert error.value.status_code == 422
    assert [segment["segment_id"] for segment in database.documents["workouts"][0]["segments"]] == ["seg_one", "seg_two"]
    assert not any(row["request_id"] == "move-item-003" for row in database.documents["mutation_receipts"])


@pytest.mark.asyncio
async def test_plan_edit_routes_delegate_to_the_service(monkeypatch):
    calls = []

    class StubService:
        async def add_set(self, account_id, workout_id, instance_id, body):
            calls.append(("add_set", account_id, workout_id, instance_id))
            return {"effect": "set_added"}

        async def remove_set(self, account_id, workout_id, set_id, body):
            calls.append(("remove_set", account_id, workout_id, set_id))
            return {"effect": "set_removed"}

        async def update_set_target(self, account_id, workout_id, set_id, body):
            calls.append(("update_set_target", account_id, workout_id, set_id))
            return {"effect": "set_target_updated"}

        async def remove_exercise(self, account_id, workout_id, instance_id, body):
            calls.append(("remove_exercise", account_id, workout_id, instance_id))
            return {"effect": "exercise_removed"}

        async def remove_segment(self, account_id, workout_id, segment_id, body):
            calls.append(("remove_segment", account_id, workout_id, segment_id))
            return {"effect": "segment_removed"}

        async def reorder_segments(self, account_id, workout_id, body):
            calls.append(("reorder_segments", account_id, workout_id, tuple(body.segment_ids)))
            return {"effect": "segments_reordered"}

        async def move_item(self, account_id, workout_id, instance_id, body):
            calls.append(("move_item", account_id, workout_id, instance_id, body.target_segment_id, body.target_index))
            return {"effect": "item_moved"}

    monkeypatch.setattr(main, "workouts", lambda: StubService())
    account = {"account_id": "acc_one"}

    assert await main.add_workout_set_v1(
        "wrk_one", "wex_one", SetAddInput(expected_revision=REV, request_id="r1"), account,
    ) == {"effect": "set_added"}
    assert await main.remove_workout_set_v1(
        "wrk_one", "set_one", SetRemoveInput(expected_revision=REV, request_id="r2"), account,
    ) == {"effect": "set_removed"}
    assert await main.update_workout_set_target_v1(
        "wrk_one", "set_one",
        SetTargetInput(target=Target(reps={"min": 5, "max": 5}), expected_revision=REV, request_id="r3"), account,
    ) == {"effect": "set_target_updated"}
    assert await main.remove_workout_exercise_v1(
        "wrk_one", "wex_one", PlanEntryRemoveInput(expected_revision=REV, request_id="r4"), account,
    ) == {"effect": "exercise_removed"}
    assert await main.remove_workout_segment_v1(
        "wrk_one", "seg_one", PlanEntryRemoveInput(expected_revision=REV, request_id="r5"), account,
    ) == {"effect": "segment_removed"}
    assert await main.reorder_workout_segments_v1(
        "wrk_one", PlanReorderInput(segment_ids=["seg_two", "seg_one"], expected_revision=REV, request_id="r6"), account,
    ) == {"effect": "segments_reordered"}
    assert await main.move_workout_item_v1(
        "wrk_one", "wex_one",
        PlanItemMoveInput(target_segment_id="seg_two", target_index=2, expected_revision=REV, request_id="r7"), account,
    ) == {"effect": "item_moved"}

    assert calls == [
        ("add_set", "acc_one", "wrk_one", "wex_one"),
        ("remove_set", "acc_one", "wrk_one", "set_one"),
        ("update_set_target", "acc_one", "wrk_one", "set_one"),
        ("remove_exercise", "acc_one", "wrk_one", "wex_one"),
        ("remove_segment", "acc_one", "wrk_one", "seg_one"),
        ("reorder_segments", "acc_one", "wrk_one", ("seg_two", "seg_one")),
        ("move_item", "acc_one", "wrk_one", "wex_one", "seg_two", 2),
    ]
