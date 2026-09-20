"""Date-scoped admission context: plain chat turns resolve the whole day.

Mini-chat resolves exercise-scoped turns; without the complete day record —
every segment, set target/actual, cue, and rest — the agent cannot explain
the day and can only guess or deflect.
"""

from types import SimpleNamespace
from uuid import uuid4
import asyncio

import pytest

from aifit_api import main
from aifit_api.workouts import WorkoutDomainError

ACCOUNT = {"account_id": "acc_1", "tenant_id": "ten_1"}

WORKOUT = {
    "workout_id": "wrk_0123456789abcdef0123456789abcdef",
    "revision": "rev_0123456789abcdef0123456789abcdef",
    "date": "2026-09-20",
    "status": "in_progress",
    "title": "Evening Easy Cardio",
    "lineage": {"source": "agent_override", "blueprint_id": "bp_x", "blueprint_revision": "rev_y"},
    "segments": [{
        "segment_id": "seg_main", "order": 1, "kind": "interval", "rounds": 2,
        "rest_after_round_seconds": 90,
        "slots": [],
        "items": [{
            "exercise_instance_id": "wex_0123456789abcdef0123456789abcdef",
            "slot_id": "slot_cardio_2",
            "candidate_id": "cand_cardio_2",
            "order": 1,
            "exercise_snapshot": {
                "exercise_id": "ex_treadmill_walk_brisk",
                "exercise_revision": "rev_abcdef0123456789abcdef0123456789",
                "name": "Treadmill Walk Brisk",
                "movement_pattern": "gait",
                "primary_muscles": ["calves"],
                "secondary_muscles": [],
                "equipment_kind": "treadmill",
                "laterality": "bilateral",
                "load_basis": "bodyweight",
            },
            "sets": [
                {"set_id": "set_1", "kind": "work",
                 "target": {"duration_seconds": {"min": 1800, "max": 2400}},
                 "actual": {"status": "completed", "duration_seconds": 2000},
                 "round": 1},
                {"set_id": "set_2", "kind": "work",
                 "target": {"duration_seconds": {"min": 1800, "max": 2400}},
                 "actual": None, "round": 2},
            ],
            "cues_md": "Stay tall through the hips.",
        }],
    }],
}

HISTORY_ROWS = [{
    "exercise_id": "ex_treadmill_walk_brisk",
    "date": "2026-09-13",
    "completed_at": "2026-09-13T10:00:00Z",
    "duration_seconds": 2000,
}]

BLUEPRINT = {"blueprint_id": "bp_x", "revision": "rev_y"}


class WorkoutsCollection:
    def __init__(self, document):
        self.document = document

    async def find_one(self, query):
        if self.document and query.get("date") == self.document["date"]:
            return self.document
        if self.document and query.get("workout_id") == self.document["workout_id"]:
            return self.document
        return None


class StubService:
    def __init__(self, blueprint=None, error=None, history_rows=None):
        self.blueprint = blueprint
        self.error = error
        self.history_rows = history_rows if history_rows is not None else []

    async def active_blueprint(self, account_id, date=None):
        if self.error:
            raise self.error
        return {"blueprint": self.blueprint}

    async def history(self, account_id, exercise_id, before=None, limit=10):
        return self.history_rows[:limit]


def body(**overrides):
    params = {"user_id": "acc_1", "request_id": uuid4(), "message": "add tonight"}
    params.update(overrides)
    return main.ChatInput(**params)


def configure(monkeypatch, workout, blueprint=None, error=None, history_rows=None):
    monkeypatch.setattr(main, "db", SimpleNamespace(
        workouts=WorkoutsCollection(workout)))
    monkeypatch.setattr(main, "workouts", lambda: StubService(blueprint, error, history_rows))


def test_no_reference_date_gives_no_context(monkeypatch):
    configure(monkeypatch, WORKOUT, BLUEPRINT)
    assert asyncio.run(main.date_scoped_context(ACCOUNT, body())) is None


def test_exercise_scoped_turn_stays_with_mini_chat(monkeypatch):
    configure(monkeypatch, WORKOUT, BLUEPRINT)
    assert asyncio.run(main.date_scoped_context(
        ACCOUNT, body(reference_date="2026-09-20", exercise_id="wex_1"))) is None


def test_date_resolves_whole_day_with_all_sets_cues_and_rest(monkeypatch):
    configure(monkeypatch, WORKOUT, BLUEPRINT)
    context = asyncio.run(main.date_scoped_context(
        ACCOUNT, body(reference_date="2026-09-20")))
    assert context is not None
    day = context["aifit"]
    assert day["reference_date"] == "2026-09-20"
    assert day["date_covered_by_blueprint"] is True
    assert day["workout_id"] == WORKOUT["workout_id"]
    assert day["workout_revision"] == WORKOUT["revision"]
    assert day["workout_status"] == "in_progress"
    assert day["workout_title"] == "Evening Easy Cardio"
    assert day["workout_source"] == "agent_override"
    assert day["workout_blueprint_id"] == "bp_x"
    assert day["active_blueprint_revision"] == "rev_y"
    (segment,) = day["segments"]
    assert segment["segment_id"] == "seg_main"
    assert segment["kind"] == "interval"
    assert segment["rounds"] == 2
    assert segment["rest_after_round_seconds"] == 90
    (item,) = segment["items"]
    assert item["exercise_instance_id"] == "wex_0123456789abcdef0123456789abcdef"
    assert item["exercise"]["exercise_id"] == "ex_treadmill_walk_brisk"
    assert item["exercise"]["name"] == "Treadmill Walk Brisk"
    assert item["exercise"]["equipment_kind"] == "treadmill"
    assert item["cues_md"] == "Stay tall through the hips."
    assert len(item["sets"]) == 2
    assert item["sets"][0]["target"] == {"duration_seconds": {"min": 1800, "max": 2400}}
    assert item["sets"][0]["actual"] == {"status": "completed", "duration_seconds": 2000}
    assert item["sets"][1]["actual"] is None
    assert item["sets_logged"] == 1
    assert item["sets_total"] == 2


def test_mini_chat_resolves_selected_exercise_day_and_history(monkeypatch):
    configure(monkeypatch, WORKOUT, BLUEPRINT, history_rows=HISTORY_ROWS)
    context = asyncio.run(main.mini_chat_workout_context(
        ACCOUNT, body(reference_date="2026-09-20",
                       exercise_id="wex_0123456789abcdef0123456789abcdef")))
    assert context is not None
    day = context["aifit"]
    assert day["workout_id"] == WORKOUT["workout_id"]
    assert day["selected_exercise_instance_id"] == "wex_0123456789abcdef0123456789abcdef"
    selected = day["selected_exercise"]
    assert selected["exercise"]["name"] == "Treadmill Walk Brisk"
    assert len(selected["sets"]) == 2
    assert selected["cues_md"] == "Stay tall through the hips."
    assert day["selected_slot_id"] == "slot_cardio_2"
    assert len(day["segments"]) == 1
    assert day["selected_exercise_recent_history"] == HISTORY_ROWS
    assert day["active_blueprint_revision"] == "rev_y"


def test_mini_chat_resolves_by_canonical_workout_id(monkeypatch):
    configure(monkeypatch, WORKOUT, BLUEPRINT)
    context = asyncio.run(main.mini_chat_workout_context(
        ACCOUNT, body(workout_id="wrk_0123456789abcdef0123456789abcdef",
                       exercise_id="wex_0123456789abcdef0123456789abcdef")))
    assert context is not None
    assert context["aifit"]["workout_id"] == WORKOUT["workout_id"]


def test_mini_chat_unknown_exercise_gives_no_context(monkeypatch):
    configure(monkeypatch, WORKOUT, BLUEPRINT)
    assert asyncio.run(main.mini_chat_workout_context(
        ACCOUNT, body(reference_date="2026-09-20", exercise_id="wex_unknown"))) is None


def test_uncovered_date_without_workout_gives_no_context(monkeypatch):
    configure(monkeypatch, None, None,
              WorkoutDomainError("blueprint_date_uncovered", "not covered.", 404))
    assert asyncio.run(main.date_scoped_context(
        ACCOUNT, body(reference_date="2026-09-20"))) is None


def test_uncovered_date_with_workout_still_resolves_day(monkeypatch):
    configure(monkeypatch, WORKOUT, None,
              WorkoutDomainError("blueprint_date_uncovered", "not covered.", 404))
    context = asyncio.run(main.date_scoped_context(
        ACCOUNT, body(reference_date="2026-09-20")))
    assert context is not None
    assert context["aifit"]["date_covered_by_blueprint"] is False
    assert context["aifit"]["workout_id"] == WORKOUT["workout_id"]
    assert context["aifit"]["active_blueprint_revision"] is None


def test_enqueue_chat_merges_day_context(monkeypatch):
    seen = {}

    async def fake_ez_call(binding, method, path, body):
        seen["admission"] = body
        return {"id": "r_test"}

    turns = SimpleNamespace(
        rows={},
        find_one_and_update=lambda query, update, **_: _await(_insert(turns, query, update)),
        find_one=lambda query: None,
        update_one=lambda query, update: None,
    )

    def _insert(store, query, update):
        row = {"_id": query["_id"], **update["$setOnInsert"]}
        store.rows[query["_id"]] = row
        return row

    import copy

    async def fake_find_one(query):
        return copy.deepcopy(turns.rows.get(query["_id"]))

    async def fake_update_one(query, update):
        turns.rows[query["_id"]].update(copy.deepcopy(update["$set"]))

    turns.find_one = fake_find_one
    turns.update_one = fake_update_one
    monkeypatch.setattr(main, "db", SimpleNamespace(
        chat_turns=turns, workouts=WorkoutsCollection(WORKOUT)))
    monkeypatch.setattr(main, "workouts", lambda: StubService(BLUEPRINT))
    monkeypatch.setattr(main, "owned_account", lambda *a: _await(ACCOUNT))
    monkeypatch.setattr(main, "verified_binding",
                        lambda *a: _await({"bindingId": "b1"}))
    monkeypatch.setattr(main, "ez_call", fake_ez_call)
    monkeypatch.setattr(main, "fallback_choice", lambda *a: None)
    monkeypatch.setattr(main, "reconcile_turn",
                        lambda account, turn: _await(turn))

    async def _await(value):
        return value

    result = asyncio.run(main.enqueue_chat(
        body(reference_date="2026-09-20"),
        SimpleNamespace(subject="did:privy:owner")))
    assert result["request_id"] == str(turns.rows[
        f"ten_1:{result['request_id']}"]["request_id"])
    context = seen["admission"]["context"]
    assert context["referenceDate"] == "2026-09-20"
    assert context["aifit"]["workout_id"] == WORKOUT["workout_id"]
    assert context["aifit"]["date_covered_by_blueprint"] is True
    assert seen["admission"]["text"].endswith("\n\n[Selected day: 2026-09-20]")
    # Stored turn text stays the raw user message.
    assert turns.rows[f"ten_1:{result['request_id']}"]["text"] == "add tonight"


def test_enqueue_chat_scopes_mini_chat_text_with_exercise(monkeypatch):
    seen = {}

    async def fake_ez_call(binding, method, path, body):
        seen["admission"] = body
        return {"id": "r_test"}

    import copy

    store: dict = {}

    async def fake_find_one_and_update(query, update, **_kwargs):
        row = {"_id": query["_id"], **update["$setOnInsert"]}
        store[query["_id"]] = row
        return row

    async def fake_find_one(query):
        return copy.deepcopy(store.get(query["_id"]))

    async def fake_update_one(query, update):
        store[query["_id"]].update(copy.deepcopy(update["$set"]))

    async def _await(value):
        return value

    monkeypatch.setattr(main, "db", SimpleNamespace(
        chat_turns=SimpleNamespace(
            find_one_and_update=fake_find_one_and_update,
            find_one=fake_find_one,
            update_one=fake_update_one,
        ),
        workouts=WorkoutsCollection(WORKOUT)))
    monkeypatch.setattr(main, "workouts", lambda: StubService(BLUEPRINT, history_rows=HISTORY_ROWS))
    monkeypatch.setattr(main, "owned_account", lambda *a: _await(ACCOUNT))
    monkeypatch.setattr(main, "verified_binding",
                        lambda *a: _await({"bindingId": "b1"}))
    monkeypatch.setattr(main, "ez_call", fake_ez_call)
    monkeypatch.setattr(main, "fallback_choice", lambda *a: None)
    monkeypatch.setattr(main, "reconcile_turn",
                        lambda account, turn: _await(turn))

    asyncio.run(main.enqueue_chat(
        body(reference_date="2026-09-20",
             exercise_id="wex_0123456789abcdef0123456789abcdef"),
        SimpleNamespace(subject="did:privy:owner")))
    assert seen["admission"]["text"].endswith(
        "\n\n[Selected day: 2026-09-20]\n[Selected exercise: Treadmill Walk Brisk]")
