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
    (lambda value: item(value)["sets"][1]["actual"].update(rpe=9), "effort_target_exceeded"),
    (lambda value: item(value)["sets"][1]["actual"].update(reps=11), "rep_target_not_met"),
    (lambda value: item(value)["progression_context"]["prescription"].update(rest_seconds=600), "execution_changed"),
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


def test_trend_uses_recorded_weight_and_reps_without_requiring_effort():
    rows = [workout(reps=(10, 10, 10)), workout("2026-09-24", reps=(12, 12, 11))]
    result = analyze(rows)["trend"]
    assert (result["status"], result["reps_change"], result["days"]) == ("improving", 5, 3)
    for row in item(rows[-1])["sets"]:
        row["actual"]["rpe"] = None
    assert analyze(rows)["trend"]["status"] == "improving"
    for row in item(rows[-1])["sets"]:
        row["actual"]["load"]["value"] = 42
    assert analyze(rows)["trend"]["status"] == "improving"
    for row in item(rows[-1])["sets"]:
        row["actual"]["rpe"] = 8
    assert analyze(rows)["trend"]["status"] == "improving"
    assert analyze(rows)["trend"]["load_change_kg"] == 2
    item(rows[-1])["sets"][0]["actual"]["reps"] = 9
    assert analyze(rows)["trend"]["status"] == "mixed"


def test_duplicate_instances_cannot_qualify_but_same_exercise_without_profile_can():
    latest = workout("2026-09-24")
    latest["segments"][0]["items"].append(deepcopy(item(latest)))
    assert analyze([latest])["qualifying_sessions"] == 0
    rows = [workout(), workout("2026-09-24")]
    for row in rows:
        item(row)["exercise_snapshot"].pop("equipment_profile_id")
    value = {**snapshot(), "equipment_profile_id": None}
    result = analyze_exercise(value, item(rows[-1])["progression_context"], rows, "2026-09-25")
    assert result["status"] == "ready"
    assert result["trend"]["status"] == "holding"


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
async def test_complete_work_needs_no_effort_but_partial_actuals_cannot_raise_the_target():
    latest = workout("2026-09-24", load=44, rpe=None)
    item(latest)["progression_context"]["prescribed_load"] = {"value": 42, "unit": "kg"}
    database = FakeDatabase()
    database.documents["workouts"] = [latest]
    service = WorkoutService(database)
    args = ("acc_one", snapshot(), candidate(), [candidate()["prescription"]["target"]] * 3, "2026-09-25", "2026-09-01")
    assert (await service._progression_target(*args))[0]["value"] == 44
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


@pytest.mark.asyncio
async def test_legacy_leg_press_keeps_125_then_earns_130_without_rpe():
    selected = candidate()
    selected['prescription']['target']['load'] = {'value': 120, 'unit': 'kg'}
    selected['progression'].update(required_sessions=1, increment={'value': 5, 'unit': 'kg'},
        load_range=[{'value': 120, 'unit': 'kg'}, {'value': 140, 'unit': 'kg'}],
        increase_when={'completed_reps_at_or_above': 12})
    context = progression_context(selected, 3, '2026-09-28', {'value': 120, 'unit': 'kg'})
    history = workout(reps=(10, 12, 12), load=125, rpe=None)
    item(history).pop('progression_context')
    item(history)['exercise_snapshot']['equipment_profile_id'] = None
    snap = item(history)['exercise_snapshot']
    database = FakeDatabase()
    database.documents['workouts'] = [history]
    svc = WorkoutService(database)
    args = ('acc_one', snap, selected, [selected['prescription']['target']] * 3, '2026-09-28', '2026-09-28')
    assert (await svc._progression_target(*args))[0] == {'value': 125, 'unit': 'kg'}
    assert analyze_exercise(snap, context, [history], '2026-09-28')['status'] == 'building'

    current = workout('2026-09-28', load=125, rpe=None)
    item(current)['exercise_snapshot'] = snap
    item(current)['progression_context'] = context
    item(current)['sets'][1]['actual'] = None
    item(current)['sets'][2]['actual'] = None
    result = analyze_exercise(snap, context, [history, current], '2026-09-28')
    assert result['status'] != 'ready'
    assert result['next_load']['value'] == 125
    assert result['comparison']['status'] == 'improving'
    assert result['comparison']['partial'] is True
    assert result['comparison']['sets_compared'] == 1
    for row in item(current)['sets']:
        row['actual'] = {'status': 'completed', 'reps': 12, 'load': {'value': 125, 'unit': 'kg'}}
    result = analyze_exercise(snap, context, [history, current], '2026-09-28')
    assert result['status'] == 'ready'
    assert result['next_load']['value'] == 130
    assert result['comparison']['status'] == 'improving'
    assert result['comparison']['partial'] is False
