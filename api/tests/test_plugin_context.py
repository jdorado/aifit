import asyncio
from copy import deepcopy

import httpx
import pytest

from aifit_api import auth, main
from aifit_api.workouts import WorkoutService
from test_workout_plan_edits import insert_workout, make_item, make_segment, make_set
from test_workout_transactions import FakeDatabase


def test_agent_context_is_namespaced_to_the_aifit_plugin(monkeypatch):
    secret = "test-secret-with-at-least-thirty-two-bytes"
    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", secret)
    monkeypatch.setattr(main, "AGENT_API_BASE_URL", "http://aifit-api:8100")

    context = main.agent_run_context({"account_id": "acc_one", "tenant_id": "ten_one"}, "job_one")

    assert context is not None
    assert set(context) == {"plugins"}
    plugin = context["plugins"]["aifit"]
    assert plugin["api_base_url"] == "http://aifit-api:8100"
    capability = asyncio.run(auth.require_agent_capability(f"Bearer {plugin['capability']}"))
    assert capability.permissions == frozenset({main.AGENT_READ, main.AGENT_WRITE})


def test_plugin_agent_surface_covers_the_canonical_reads_and_writes():
    routes = [route for route in main.app.routes if route.path.startswith("/v1/agent/")]
    by_path: dict[str, set[str]] = {}
    for route in routes:
        by_path.setdefault(route.path, set()).update(route.methods)
    for path in ("/v1/agent/messages", "/v1/agent/jobs/{job_id}"):
        by_path.pop(path)
    assert set(by_path) == {
        "/v1/agent/exercises",
        "/v1/agent/exercises/{exercise_id}",
        "/v1/agent/exercises/{exercise_id}/history",
        "/v1/agent/exercises/{exercise_id}/related-history",
        "/v1/agent/blueprints/draft",
        "/v1/agent/blueprints/active",
        "/v1/agent/blueprints/solidify",
        "/v1/agent/workouts/generate",
        "/v1/agent/workouts",
        "/v1/agent/workouts/{workout_id}",
        "/v1/agent/workouts/{workout_id}/progression",
        "/v1/agent/workouts/{workout_id}/sets/{set_id}",
        "/v1/agent/workouts/{workout_id}/sets/{set_id}/target",
        "/v1/agent/workouts/{workout_id}/exercises/{exercise_instance_id}/sets",
        "/v1/agent/workouts/{workout_id}/sets/{set_id}/remove",
        "/v1/agent/workouts/override",
        "/v1/agent/workouts/swap",
        "/v1/agent/workouts/{workout_id}/sets/{set_id}/unlog",
        "/v1/agent/workouts/{workout_id}/exercises",
        "/v1/agent/workouts/{workout_id}/exercises/{exercise_instance_id}/remove",
        "/v1/agent/workouts/{workout_id}/segments/{segment_id}/remove",
        "/v1/agent/workouts/{workout_id}/segments/reorder",
        "/v1/agent/workouts/{workout_id}/exercises/{exercise_instance_id}/move",
        "/v1/agent/workouts/{workout_id}/exercises/{exercise_instance_id}/extract",
        "/v1/agent/workouts/{workout_id}/notes",
        "/v1/agent/workouts/{workout_id}/exercises/{exercise_instance_id}/notes",
        "/v1/agent/workouts/{workout_id}/clear",
        "/v1/agent/workouts/copy",
        "/v1/agent/workouts/{workout_id}/exercise-repertoire",
        "/v1/agent/workouts/{workout_id}/exercises/{exercise_instance_id}/swap-candidates",
    }
    assert by_path["/v1/agent/workouts/{workout_id}/sets/{set_id}"] == {"PATCH"}
    assert by_path["/v1/agent/workouts"] == {"GET"}
    assert by_path["/v1/agent/exercises"] == {"GET", "POST"}


def test_every_frontend_workout_operation_has_an_agent_equivalent():
    agent_routes = {(route.path, method) for route in main.app.routes
                    if route.path.startswith("/v1/agent/workouts") for method in route.methods}
    aliases = {
        "/v1/workouts/copy-last-week": "/v1/agent/workouts/copy",
        "/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/swap": "/v1/agent/workouts/swap",
    }
    for route in main.app.routes:
        if route.path.startswith("/v1/workouts"):
            counterpart = aliases.get(route.path, route.path.replace("/v1/", "/v1/agent/", 1))
            for method in route.methods:
                assert (counterpart, method) in agent_routes, (method, route.path)


@pytest.mark.asyncio
async def test_agent_set_count_edits_preserve_started_workout_and_enforce_authority(monkeypatch):
    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", "test-secret-with-at-least-thirty-two-bytes")
    database = FakeDatabase()
    service = WorkoutService(database)
    before = deepcopy(insert_workout(database, [make_segment("seg_main", 1, [
        make_item("wex_target", 1, [make_set("set_logged", logged=True)]),
        make_item("wex_other", 2, [make_set("set_other")]),
    ])]))
    monkeypatch.setattr(main, "workouts", lambda: service)

    def headers(account_id="acc_one", permissions=None):
        token = auth.mint_agent_capability(
            account_id=account_id, tenant_id="ten_one", job_id="job_one",
            permissions={main.AGENT_READ, main.AGENT_WRITE} if permissions is None else permissions,
        )
        return {"Authorization": f"Bearer {token}"}

    add_path = "/v1/agent/workouts/wrk_manual/exercises/wex_target/sets"
    remove_path = "/v1/agent/workouts/wrk_manual/sets/{}/remove"
    body = {"expected_revision": before["revision"], "request_id": "add-one"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
        for path in (add_path, remove_path.format("set_logged")):
            assert (await client.post(path, json=body)).status_code == 401
            assert (await client.post(path, json=body, headers=headers(permissions={main.AGENT_READ}))).status_code == 403
            assert (await client.post(path, json=body, headers=headers(account_id="acc_other"))).status_code == 404
        assert database.documents["workouts"][0] == before

        response = await client.post(add_path, json=body, headers=headers())
        assert response.status_code == 200, response.text
        receipt = response.json()
        assert receipt["effect"] == "set_added"
        after = deepcopy(receipt["workout"])
        target = after["segments"][0]["items"][0]
        assert len(target["sets"]) == 2
        assert target["sets"][0] == before["segments"][0]["items"][0]["sets"][0]
        added = target["sets"].pop()
        assert added["actual"] is None
        assert added["target"] == target["sets"][0]["target"]
        assert after["segments"] == before["segments"]
        assert after["lineage"] == before["lineage"]

        replay = await client.post(add_path, json=body, headers=headers())
        assert replay.json() == receipt
        stale = await client.post(add_path, json={**body, "request_id": "stale-add"}, headers=headers())
        assert stale.status_code == 409

        removal = {"expected_revision": receipt["revision"], "request_id": "remove-one"}
        logged = await client.post(remove_path.format("set_logged"), json=removal, headers=headers())
        assert logged.status_code == 409
        assert logged.json()["detail"]["code"] == "set_is_logged"
        removed = await client.post(remove_path.format(added["set_id"]), json=removal, headers=headers())
        assert removed.status_code == 200, removed.text
        assert removed.json()["workout"]["segments"] == before["segments"]
        readback = await client.get("/v1/agent/workouts/wrk_manual", headers=headers())
        assert readback.json() == removed.json()["workout"]


@pytest.mark.parametrize("method,path,operation,ids,payload", [['POST', '/workouts/wrk_one/sets/set_one/unlog', 'unlog_set', ['wrk_one', 'set_one'], {}],
 ['POST', '/workouts/wrk_one/exercises', 'add_exercise', ['wrk_one'],
  {'blueprint_id': 'bp_one',
   'expected_blueprint_revision': 'rev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   'day_id': 'day_one',
   'slot_id': 'slot_one',
   'candidate_id': 'cand_one'}],
 ['POST', '/workouts/wrk_one/exercises/wex_one/remove', 'remove_exercise', ['wrk_one', 'wex_one'], {}],
 ['POST', '/workouts/wrk_one/segments/seg_one/remove', 'remove_segment', ['wrk_one', 'seg_one'], {}],
 ['POST', '/workouts/wrk_one/segments/reorder', 'reorder_segments', ['wrk_one'], {'segment_ids': ['seg_one']}],
 ['POST', '/workouts/wrk_one/exercises/wex_one/move', 'move_item', ['wrk_one', 'wex_one'],
  {'target_segment_id': 'seg_one', 'target_index': 1}],
 ['POST', '/workouts/wrk_one/exercises/wex_one/extract', 'extract_item', ['wrk_one', 'wex_one'],
  {'before_segment_id': 'seg_two'}],
 ['PATCH', '/workouts/wrk_one/notes', 'update_notes', ['wrk_one'], {'notes': 'QA notes'}],
 ['PATCH', '/workouts/wrk_one/exercises/wex_one/notes', 'update_exercise_notes', ['wrk_one', 'wex_one'],
  {'note': 'QA feedback', 'preset': 'form'}],
 ['POST', '/workouts/wrk_one/clear', 'clear_workout', ['wrk_one'], {}],
 ['POST', '/workouts/copy', 'copy_workout', [],
  {'source_date': '2026-09-21', 'date': '2026-09-23', 'expected_source_revision': 'rev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}],
 ['GET', '/workouts/wrk_one/exercise-repertoire', 'exercise_repertoire', ['wrk_one'], None],
 ['GET', '/workouts/wrk_one/exercises/wex_one/swap-candidates', 'swap_candidates', ['wrk_one', 'wex_one'], None]])
@pytest.mark.asyncio
async def test_workout_operations_use_bound_authority_and_typed_service(monkeypatch, method, path, operation, ids, payload):
    calls = []

    class Service:
        def __getattr__(self, name):
            async def invoke(*args):
                calls.append((name, args))
                return {"ok": True}
            return invoke

    monkeypatch.setattr(main, "workouts", lambda: Service())
    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", "test-secret-with-at-least-thirty-two-bytes")
    body = None if payload is None else {
        **payload, "request_id": "qa-operation", "expected_revision": "rev_" + "a" * 32,
    }
    permission = main.AGENT_READ if method == "GET" else main.AGENT_WRITE

    def headers(permissions):
        token = auth.mint_agent_capability(
            account_id="acc_bound", tenant_id="ten_bound", job_id="job_bound", permissions=permissions,
        )
        return {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
        assert (await client.request(method, "/v1/agent" + path, json=body)).status_code == 401
        denied = await client.request(method, "/v1/agent" + path, json=body, headers=headers({"unrelated:read"}))
        assert denied.status_code == 403
        assert not calls
        response = await client.request(method, "/v1/agent" + path, json=body, headers=headers({permission}))
        assert response.status_code == 200, response.text
        assert len(calls) == 1
        name, args = calls[0]
        assert name == operation
        assert args[:1 + len(ids)] == ("acc_bound", *ids)
        if body is not None:
            assert args[-1].model_dump(mode="json") == body


@pytest.mark.parametrize("value", [
    "file:///tmp/aifit-api",
    "https://user:password@example.test/aifit",
    "https://example.test/aifit?token=leak",
    "https://example.test/aifit#fragment",
])
def test_agent_context_rejects_unsafe_api_origins(monkeypatch, value):
    monkeypatch.setattr(main, "AGENT_API_BASE_URL", value)

    assert main.agent_run_context({"account_id": "acc_one", "tenant_id": "ten_one"}, "job_one") is None


def test_agent_swap_intent_requires_blueprint_revision_and_selects_the_source():
    intent = main.AgentWorkoutSwapInput(
        workout_id="wrk_0123456789abcdef0123456789abcdef",
        exercise_instance_id="wex_0123456789abcdef0123456789abcdef",
        reason="The current station is occupied.",
        expected_revision="rev_0123456789abcdef0123456789abcdef",
        expected_blueprint_revision="rev_abcdef0123456789abcdef0123456789",
        request_id="swap-001",
    )
    assert intent.expected_blueprint_revision == "rev_abcdef0123456789abcdef0123456789"
    assert intent.source == "jev"
    assert intent.target_candidate_id is None
    assert main.AgentWorkoutSwapInput(
        workout_id=intent.workout_id,
        exercise_instance_id=intent.exercise_instance_id,
        reason=intent.reason,
        source="default",
        target_candidate_id="cand_row_cable",
        expected_revision=intent.expected_revision,
        expected_blueprint_revision=intent.expected_blueprint_revision,
        request_id=intent.request_id,
    ).target_candidate_id == "cand_row_cable"
    assert main.AgentWorkoutSwapInput(
        workout_id=intent.workout_id,
        exercise_instance_id=intent.exercise_instance_id,
        reason=intent.reason,
        source="default",
        expected_revision=intent.expected_revision,
        expected_blueprint_revision=intent.expected_blueprint_revision,
        request_id=intent.request_id,
    ).source == "default"
