import asyncio

import pytest

from aifit_api import auth, main


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
        "/v1/agent/workouts/override",
        "/v1/agent/workouts/swap",
    }
    assert by_path["/v1/agent/workouts/{workout_id}/sets/{set_id}"] == {"PATCH"}
    assert by_path["/v1/agent/workouts"] == {"GET"}


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
