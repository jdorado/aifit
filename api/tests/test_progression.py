from copy import deepcopy

import pytest

from aifit_api.progression import analyze_exercise, progression_context, summarize_muscles
from aifit_api.workouts import BlueprintInput, Progression, WorkoutDomainError, WorkoutService
from test_workout_contract import blueprint
from test_workout_transactions import FakeDatabase


def candidate():
    value = blueprint()["days"][0]["segments"][0]["slots"][0]["candidates"][0]
    value["progression"] = {"kind": "double_progression", "required_sessions": 2,
        "increase_when": {"completed_reps_at_or_above": 12, "max_rpe": 8},
        "increment": {"value": 2, "unit": "kg"},
        "load_range": [{"value": 40, "unit": "kg"}, {"value": 44, "unit": "kg"}],
        "goal": "Build pulling strength", "plateau_after_exposures": 3}
    return value


def snapshot():
    return {"exercise_id": "ex_chest_supported_row_machine", "name": "Row",
            "load_basis": "machine_stack", "laterality": "bilateral", "equipment_kind": "machine",
            "equipment_profile_id": "eqp_row_machine", "primary_muscles": ["back"], "secondary_muscles": ["biceps"]}


def workout(day="2026-09-21", reps=(12, 12, 12), rpe=8, load=40, account="acc_one"):
    context = progression_context(candidate(), 3, "2026-09-01", {"value": 40, "unit": "kg"})
    item = {"exercise_instance_id": f"wex_{day}", "exercise_snapshot": snapshot(),
            "progression_context": context, "sets": [
                {"set_id": f"set_{day}_{index}", "kind": "work", "target": candidate()["prescription"]["target"],
                 "actual": {"status": "completed", "reps": rep, "load": {"value": load, "unit": "kg"}, "rpe": rpe}}
                for index, rep in enumerate(reps)]}
    return {"account_id": account, "workout_id": f"wrk_{day}_{account}", "revision": f"rev_{day}", "date": day,
            "segments": [{"kind": "straight_sets", "items": [item]}]}


def item(row):
    return row["segments"][0]["items"][0]


def analyze(rows, context=None):
    return analyze_exercise(snapshot(), context or item(workout())["progression_context"], rows, "2026-09-25")


def test_two_complete_exposures_earn_one_equipment_step():
    result = analyze([workout("2026-09-21"), workout("2026-09-24")])
    assert result["status"] == "ready"
    assert result["next_load"] == {"value": 42, "unit": "kg"}
    assert result["qualifying_sessions"] == 2


@pytest.mark.parametrize("change, reason", [
    (lambda value: item(value)["sets"][1].update(actual=None), "incomplete_exposure"),
    (lambda value: item(value)["sets"].pop(), "incomplete_exposure"),
    (lambda value: item(value)["sets"][1]["actual"].update(status="skipped"), "incomplete_exposure"),
    (lambda value: item(value)["sets"][1]["actual"].update(rpe=None), "missing_effort"),
    (lambda value: item(value)["sets"][1]["actual"].update(rpe=9), "effort_target_exceeded"),
    (lambda value: item(value)["sets"][1]["actual"].update(reps=11), "rep_target_not_met"),
    (lambda value: item(value).pop("progression_context"), "execution_changed"),
    (lambda value: item(value)["progression_context"].update(partial=True), "incomplete_exposure"),
    (lambda value: item(value).update(notes={"preset": "pain"}), "exercise_feedback"),
])
def test_incomplete_or_unqualified_evidence_cannot_earn_a_step(change, reason):
    latest = workout("2026-09-24")
    change(latest)
    result = analyze([workout(), latest])
    assert result["status"] != "ready"
    assert result["reason"] == reason
    assert result["qualifying_sessions"] == 0


def test_machine_identity_and_future_records_are_not_qualifying_history():
    other = workout("2026-09-22")
    item(other)["exercise_snapshot"]["equipment_profile_id"] = "eqp_different"
    result = analyze([workout(), other, workout("2026-09-26")])
    assert result["qualifying_sessions"] == 1
    assert result["status"] == "building"


def test_changed_load_resets_the_streak_and_ceiling_does_not_invent_a_step():
    assert analyze([workout(), workout("2026-09-24", load=42)])["qualifying_sessions"] == 1
    result = analyze([workout(load=44), workout("2026-09-24", load=44)])
    assert result["reason"] == "load_ceiling"
    assert result["next_load"]["value"] == 44


def test_deload_retains_the_agent_target_and_is_not_a_negative_trend():
    context = item(workout())["progression_context"]
    context["policy"]["phase"] = "deload"
    context["prescribed_load"] = {"value": 30, "unit": "kg"}
    result = analyze([workout(), workout("2026-09-24")], context)
    assert result["status"] == "planned_easier"
    assert result["next_load"]["value"] == 30


def test_trend_separates_same_load_reps_from_effort_and_volume():
    rows = [workout(reps=(10, 10, 10)), workout("2026-09-24", reps=(12, 12, 11))]
    result = analyze(rows)["trend"]
    assert (result["status"], result["reps_change"], result["days"]) == ("improving", 5, 3)
    for row in item(rows[-1])["sets"]:
        row["actual"]["rpe"] = None
    assert analyze(rows)["trend"]["status"] == "effort_unconfirmed"
    for row in item(rows[-1])["sets"]:
        row["actual"]["load"]["value"] = 42
    assert analyze(rows)["trend"]["status"] == "effort_unconfirmed"
    for row in item(rows[-1])["sets"]:
        row["actual"]["rpe"] = 8
    assert analyze(rows)["trend"]["status"] == "improving"
    assert analyze(rows)["trend"]["load_change_kg"] == 2
    item(rows[-1])["sets"][0]["actual"]["reps"] = 9
    assert analyze(rows)["trend"]["reps_change"] is None


def test_duplicate_instances_and_unknown_machine_cannot_confirm_progress():
    latest = workout("2026-09-24")
    latest["segments"][0]["items"].append(deepcopy(item(latest)))
    assert analyze([latest])["qualifying_sessions"] == 0
    rows = [workout(), workout("2026-09-24")]
    for row in rows:
        item(row)["exercise_snapshot"].pop("equipment_profile_id")
    value = {**snapshot(), "equipment_profile_id": None}
    result = analyze_exercise(value, item(rows[-1])["progression_context"], rows, "2026-09-25")
    assert result["reason"] == "equipment_not_comparable"
    assert result["trend"]["status"] == "insufficient_data"


def test_pain_before_logging_blocks_a_historical_ready_result():
    latest = workout("2026-09-25")
    for row in item(latest)["sets"]:
        row["actual"] = None
    item(latest)["notes"] = {"preset": "pain"}
    assert analyze([workout(), workout("2026-09-24"), latest])["reason"] == "exercise_feedback"


def test_increased_assistance_is_not_reported_as_strength_progress():
    rows = [workout(), workout("2026-09-24", load=42)]
    for row in rows:
        item(row)["exercise_snapshot"]["load_basis"] = "assisted"
    summary = analyze_exercise(item(rows[-1])["exercise_snapshot"], item(rows[-1])["progression_context"], rows, "2026-09-25")
    assert summary["trend"]["status"] == "insufficient_data"
    assert summary["status"] != "ready"


@pytest.mark.asyncio
async def test_missing_effort_holds_the_earned_prescription_without_using_partial_actuals():
    latest = workout("2026-09-24", load=44, rpe=None)
    item(latest)["progression_context"]["prescribed_load"] = {"value": 42, "unit": "kg"}
    database = FakeDatabase()
    database.documents["workouts"] = [latest]
    service = WorkoutService(database)
    args = ("acc_one", snapshot(), candidate(), [candidate()["prescription"]["target"]] * 3, "2026-09-25", "2026-09-01")
    assert (await service._progression_target(*args))[0]["value"] == 42
    item(latest)["sets"][1]["actual"] = None
    assert (await service._progression_target(*args))[0]["value"] == 42


def test_review_is_evidence_not_an_automatic_rewrite():
    rows = [workout("2026-09-21", reps=(10, 10, 10)), workout("2026-09-23", reps=(10, 10, 10)), workout("2026-09-24", reps=(10, 10, 10))]
    assert analyze(rows)["review_reasons"] == ["no_recent_improvement"]
    context = item(workout())["progression_context"]
    context["policy"].update(review_by="2026-09-24", review_after_exposures=3)
    assert set(analyze(rows, context)["review_reasons"]) == {"review_date", "review_exposures", "no_recent_improvement"}


def test_muscle_summary_keeps_direct_indirect_and_unknown_evidence_separate():
    rows = [workout(reps=(10, 10, 10)), workout("2026-09-24", reps=(12, 12, 11))]
    warmup = deepcopy(item(rows[-1]))
    warmup["sets"] = [{**row, "kind": "warmup"} for row in warmup["sets"]]
    rows[-1]["segments"].append({"kind": "warmup", "items": [warmup]})
    summaries = {row["muscle"]: row for row in summarize_muscles(rows, "2026-09-25")}
    assert summaries["back"]["improving_exercises"] == 1
    assert summaries["back"]["direct_completed_sets"] == 6
    assert summaries["biceps"]["indirect_completed_sets"] == 6
    assert summaries["biceps"]["direct_completed_sets"] == 0


@pytest.mark.asyncio
async def test_canonical_projection_and_generation_are_tenant_and_date_scoped():
    database = FakeDatabase()
    database.documents["workouts"] = [workout(), workout("2026-09-24"), workout("2026-09-22", account="acc_other")]
    service = WorkoutService(database)
    result = await service.progression("acc_one", "wrk_2026-09-24_acc_one")
    assert result["exercises"][0]["status"] == "ready"
    assert result["muscles"][0]["direct_completed_sets"] == 6
    with pytest.raises(WorkoutDomainError):
        await service.progression("acc_other", "wrk_2026-09-24_acc_one")
    load, _ = await service._progression_target("acc_one", snapshot(), candidate(), [candidate()["prescription"]["target"]] * 3, "2026-09-22", "2026-09-01")
    assert load["value"] == 40
    load, _ = await service._progression_target("acc_one", snapshot(), candidate(), [candidate()["prescription"]["target"]] * 3, "2026-09-25", "2026-09-01")
    assert load["value"] == 42


@pytest.mark.parametrize("update", [{"increment": {"value": 0, "unit": "kg"}}, {"required_sessions": 0}, {"review_by": "2026-02-31"}])
def test_invalid_progression_parameters_are_rejected(update):
    with pytest.raises(ValueError):
        Progression(**{**candidate()["progression"], **update})


def test_blueprint_rejects_a_progression_trigger_below_the_prescribed_range():
    value = blueprint()
    selected = value["days"][0]["segments"][0]["slots"][0]["candidates"][0]
    selected["progression"] = candidate()["progression"]
    selected["progression"]["increase_when"]["completed_reps_at_or_above"] = 8
    with pytest.raises(ValueError):
        BlueprintInput(**value)
