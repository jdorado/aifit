import pytest
from fastapi import HTTPException

from aifit_api import auth, main
from aifit_api.workouts import WorkoutService
from test_workout_transactions import FakeDatabase


def seed(database, exercise_id, name, revision="rev_current", account="acc_one", current=True):
    definition = {
        "account_id": account, "exercise_id": exercise_id, "revision": revision,
        "name": name, "movement_pattern": "scapular_protraction",
        "primary_muscles": ["serratus anterior"], "equipment_kind": "cable",
        "laterality": "unilateral", "load_basis": "machine_stack", "metrics": ["reps"],
        "instructions_md": "Reach forward.",
    }
    database.documents["exercises"].append(definition)
    if current:
        database.documents["exercise_heads"].append({
            key: definition[key] for key in ("account_id", "exercise_id", "revision")
        })


@pytest.mark.asyncio
async def test_catalog_pages_current_identities_without_other_tenants_or_old_revisions():
    database = FakeDatabase()
    seed(database, "ex_serratus", "Single-arm cable serratus press reach", "rev_old", current=False)
    seed(database, "ex_serratus", "Single-arm cable serratus reach")
    seed(database, "ex_press", "Cable chest press")
    seed(database, "ex_foreign", "Private exercise", account="acc_two")
    seed(database, "ex_serratus", "Other tenant's definition", account="acc_two")
    service = WorkoutService(database)

    first = await service.list_exercises("acc_one", limit=1)
    assert [item["exercise_id"] for item in first["exercises"]] == ["ex_press"]
    assert first["next_after"] == "ex_press"
    second = await service.list_exercises("acc_one", after=first["next_after"], limit=1)
    assert [(item["exercise_id"], item["name"], item["revision"]) for item in second["exercises"]] == [
        ("ex_serratus", "Single-arm cable serratus reach", "rev_current"),
    ]
    assert second["next_after"] is None
    assert "account_id" not in second["exercises"][0]
    assert await service.list_exercises("acc_empty") == {"exercises": [], "next_after": None}


@pytest.mark.asyncio
async def test_agent_catalog_uses_capability_account_and_requires_read_permission(monkeypatch):
    database = FakeDatabase()
    seed(database, "ex_serratus", "Cable serratus press")
    monkeypatch.setattr(main, "workouts", lambda: WorkoutService(database))
    capability = auth.AgentCapability("acc_one", "tenant_one", "job_one", frozenset({main.AGENT_READ}))
    result = await main.agent_list_exercises_v1(after=None, limit=50, capability=capability)
    assert result["exercises"][0]["exercise_id"] == "ex_serratus"
    denied = auth.AgentCapability("acc_one", "tenant_one", "job_one", frozenset({main.AGENT_WRITE}))
    with pytest.raises(HTTPException) as error:
        await main.agent_list_exercises_v1(after=None, limit=50, capability=denied)
    assert error.value.status_code == 403
