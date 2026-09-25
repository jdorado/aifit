"""Small, deterministic projections over canonical workout records.

The coach supplies the policy. These functions measure its evidence; they never
infer a training goal, diagnose a plateau, or invent population percentiles.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any


def progression_context(candidate: dict, rounds: int, start_date: str, load: dict | None) -> dict:
    prescription = candidate["prescription"]
    return {
        "policy": candidate.get("progression", {"kind": "none"}),
        "expected_sets": rounds,
        "start_date": start_date,
        "prescribed_load": load,
        "prescription": prescription,
    }


def load_key(snapshot: dict) -> tuple:
    return tuple(snapshot.get(key) for key in ("exercise_id", "equipment_profile_id", "load_basis", "laterality"))


def load_kg(load: dict | None) -> float | None:
    if not load or load.get("unit") not in ("kg", "lb"):
        return None
    return round(load["value"] * (0.45359237 if load["unit"] == "lb" else 1), 6)


def work_sets(item: dict) -> list[dict]:
    return [row for row in item.get("sets", []) if row.get("kind", "work") == "work"]


def items(workout: dict):
    for segment in workout.get("segments", []):
        if segment["kind"] in ("warmup", "cooldown", "mobility"):
            continue
        yield from segment["items"]


def execution_context(item: dict) -> tuple | None:
    context = item.get("progression_context")
    if not context:
        return None
    prescription = context["prescription"]
    tempo = prescription.get("tempo") or {}
    return (prescription.get("metric"), prescription.get("rest_seconds"),
            tuple(sorted(tempo.items())))


def exposure(workout: dict, item: dict) -> dict:
    rows = work_sets(item)
    actuals = [row["actual"] for row in rows if (row.get("actual") or {}).get("status") == "completed"]
    context = item.get("progression_context") or {}
    expected = context.get("expected_sets", len(rows))
    complete = bool(rows) and len(actuals) == len(rows) == expected and not context.get("partial")
    loads = [load_kg(row.get("load")) for row in actuals]
    uniform = bool(loads) and None not in loads and len(set(loads)) == 1
    reps = [row.get("reps") for row in actuals]
    efforts = [row.get("rpe") for row in actuals]
    return {
        "workout_id": workout["workout_id"], "date": workout["date"],
        "exercise_instance_id": item["exercise_instance_id"],
        "complete": complete, "logged_sets": len(actuals), "expected_sets": expected,
        "load": actuals[0].get("load") if uniform else None,
        "load_kg": loads[0] if uniform else None,
        "reps": reps, "total_reps": sum(reps) if reps and None not in reps else None,
        "rpe": efforts, "effort_recorded": bool(efforts) and None not in efforts,
        "context": execution_context(item),
        "prescribed_load": context.get("prescribed_load"),
        "phase": context.get("policy", {}).get("phase", "build"),
        "pain_or_form": (item.get("notes") or {}).get("preset") in ("pain", "form"),
    }


def public_exposure(row: dict | None) -> dict | None:
    return {key: value for key, value in row.items() if key not in ("context", "load_kg")} if row else None


def comparable(row: dict, reference: dict, *, same_load: bool = True) -> bool:
    return (row["complete"] and reference["complete"]
            and row["expected_sets"] == reference["expected_sets"]
            and row["context"] is not None and row["context"] == reference["context"]
            and row["phase"] == reference["phase"] == "build"
            and not row["pain_or_form"] and not reference["pain_or_form"]
            and row["load_kg"] is not None and reference["load_kg"] is not None
            and (not same_load or row["load_kg"] == reference["load_kg"])
            and row["total_reps"] is not None and reference["total_reps"] is not None)


def trend_for(exposures: list[dict]) -> dict:
    completed = [row for row in exposures if row["complete"] and row["total_reps"] is not None and row["phase"] == "build"]
    result = {"status": "insufficient_data", "reps_change": None, "load_change_kg": None, "days": None,
              "exposures": 0, "effort_comparable": False, "baseline": None, "latest": None}
    if not completed:
        return result
    latest = completed[-1]
    matches = [row for row in completed if comparable(row, latest, same_load=False)
               and (row["load_kg"] == latest["load_kg"]
                    or (row["load_kg"] < latest["load_kg"] and all(a <= b for a, b in zip(row["reps"], latest["reps"]))))]
    result["latest"] = public_exposure(latest)
    result["exposures"] = len(matches)
    if len(matches) < 2:
        return result
    first = matches[0]
    change = latest["total_reps"] - first["total_reps"]
    effort_comparable = (first["effort_recorded"] and latest["effort_recorded"]
                         and all(a <= b for a, b in zip(latest["rpe"], first["rpe"])))
    load_change = round(latest["load_kg"] - first["load_kg"], 6)
    result.update({"reps_change": change, "days": (date.fromisoformat(latest["date"]) - date.fromisoformat(first["date"])).days,
                   "load_change_kg": load_change,
                   "effort_comparable": effort_comparable, "baseline": public_exposure(first),
                   "status": ("improving" if change > 0 or load_change > 0 else "holding" if change == 0 else "lower") if effort_comparable else "effort_unconfirmed"})
    return result


def analyze_exercise(snapshot: dict, context: dict | None, workouts: list[dict], as_of: str) -> dict:
    context = context or {}
    policy = context.get("policy", {"kind": "none"})
    target_load = context.get("prescribed_load")
    rows = [exposure(workout, item) for workout in sorted(workouts, key=lambda row: row["date"])
            if workout["date"] <= as_of for item in items(workout)
            if load_key(item["exercise_snapshot"]) == load_key(snapshot)
            and (any(row.get("actual") is not None for row in work_sets(item))
                 or (item.get("notes") or {}).get("preset") in ("pain", "form"))]
    # An override may preserve one instance and add another of the same lift.
    # Two pieces of one day's work are not two qualifying sessions.
    counts = {}
    for row in rows:
        counts[row["workout_id"]] = counts.get(row["workout_id"], 0) + 1
    for row in rows:
        if counts[row["workout_id"]] > 1:
            row["complete"] = False
    latest = rows[-1] if rows else None
    result: dict[str, Any] = {
        "exercise_id": snapshot["exercise_id"], "exercise_name": snapshot["name"],
        "primary_muscles": snapshot.get("primary_muscles", []),
        "load_basis": snapshot.get("load_basis"), "policy": policy,
        "prescribed_load": target_load, "next_load": target_load,
        "status": "coach_managed", "reason": "no_automatic_rule", "qualifying_sessions": 0,
        "required_sessions": policy.get("required_sessions", 1),
        "expected_sets": context.get("expected_sets"),
        "target_reps": context.get("prescription", {}).get("target", {}).get("reps"),
        "latest": public_exposure(latest), "trend": trend_for([row for row in rows if row["date"] >= (date.fromisoformat(as_of) - timedelta(days=27)).isoformat()]), "review_reasons": [],
        "age_comparison": {"status": "unavailable", "reason": "no_matching_reference"},
    }
    equipment_known = not (snapshot.get("equipment_kind") in ("machine", "cable") and not snapshot.get("equipment_profile_id"))
    load_supported = snapshot.get("load_basis") in ("total", "per_hand", "per_side", "machine_stack")
    if not equipment_known or not load_supported:
        result["trend"] = trend_for([])
    since = context.get("start_date", as_of)
    block_rows = [row for row in rows if row["date"] >= since]
    if policy.get("review_by") and as_of >= policy["review_by"]:
        result["review_reasons"].append("review_date")
    if policy.get("review_after_exposures") and len(block_rows) >= policy["review_after_exposures"]:
        result["review_reasons"].append("review_exposures")
    count = policy.get("plateau_after_exposures")
    recent = block_rows[-count:] if count else []
    if count and len(recent) == count and all(comparable(row, recent[0]) and row["effort_recorded"] for row in recent):
        if all(row["total_reps"] <= recent[0]["total_reps"] and max(row["rpe"]) >= max(recent[0]["rpe"]) for row in recent[1:]):
            result["review_reasons"].append("no_recent_improvement")
    if latest and latest["pain_or_form"]:
        result["review_reasons"].append("exercise_feedback")
    if policy.get("phase", "build") != "build":
        result.update(status="planned_easier" if policy["phase"] == "deload" else "planned_hold", reason="planned_phase")
        return result
    if policy["kind"] != "double_progression":
        return result
    if not load_supported or not equipment_known:
        result.update(status="insufficient_data", reason="equipment_not_comparable")
        return result
    if not latest:
        result.update(status="baseline", reason="no_completed_history")
        return result
    if latest["pain_or_form"]:
        result.update(status="review", reason="exercise_feedback")
        return result
    lower, upper = policy["load_range"]
    recent_kg = latest["load_kg"]
    # Out-of-policy loads never become the next automatic prescription.
    if recent_kg is None or not load_kg(lower) <= recent_kg <= load_kg(upper):
        result.update(status="review", reason="load_outside_policy")
        return result
    factor = 0.45359237 if lower["unit"] == "lb" else 1
    result["next_load"] = {"value": round(recent_kg / factor, 4), "unit": lower["unit"]}
    expected = context.get("expected_sets")
    execution = execution_context({"progression_context": context}) if context.get("prescription") else None
    when = policy["increase_when"]
    streak = 0
    reason = "rep_target_not_met"
    for row in reversed(rows):
        if not row["complete"] or row["expected_sets"] != expected:
            reason = "incomplete_exposure"
            break
        if row["context"] is None or row["context"] != execution or row["phase"] != "build":
            reason = "execution_changed"
            break
        if row["pain_or_form"]:
            reason = "exercise_feedback"
            break
        if row["load_kg"] != recent_kg:
            break
        if not row["effort_recorded"]:
            reason = "missing_effort"
            break
        if any(rep is None or rep < when["completed_reps_at_or_above"] for rep in row["reps"]):
            break
        if any(effort > when["max_rpe"] for effort in row["rpe"]):
            reason = "effort_target_exceeded"
            break
        streak += 1
        if streak >= result["required_sessions"]:
            break
    result["qualifying_sessions"] = streak
    if streak >= result["required_sessions"]:
        current_value = result["next_load"]["value"]
        increased = round(current_value + policy["increment"]["value"], 4)
        # Never invent a smaller, unavailable equipment increment at the ceiling.
        if increased <= upper["value"]:
            result.update(status="ready", reason="rule_met", next_load={"value": increased, "unit": upper["unit"]})
        else:
            result.update(status="review", reason="load_ceiling")
            result["review_reasons"].append("load_ceiling")
    elif streak:
        result.update(status="building", reason="more_qualifying_sessions")
    else:
        result.update(status="insufficient_data" if reason in ("incomplete_exposure", "missing_effort", "execution_changed") else "building", reason=reason)
    if result["status"] == "insufficient_data":
        previous_target = latest["prescribed_load"]
        previous_kg = load_kg(previous_target)
        result["next_load"] = previous_target if (latest["context"] == execution and previous_kg is not None
            and load_kg(lower) <= previous_kg <= load_kg(upper)) else target_load
    if latest["pain_or_form"]:
        result.update(status="review", reason="exercise_feedback", next_load=target_load)
    return result


def summarize_muscles(workouts: list[dict], as_of: str) -> list[dict]:
    """Separate exercise performance from scheduled direct/indirect work."""
    anchor = date.fromisoformat(as_of)
    week_start = (anchor - timedelta(days=anchor.weekday())).isoformat()
    week_end = (anchor + timedelta(days=6-anchor.weekday())).isoformat()
    trend_start = (anchor - timedelta(days=27)).isoformat()
    representatives: dict[tuple, tuple[dict, dict]] = {}
    muscles: dict[str, dict] = {}

    def muscle(name):
        return muscles.setdefault(name, {"muscle": name, "tracked_exercises": 0, "improving_exercises": 0,
            "comparable_exercises": 0, "direct_completed_sets": 0, "direct_planned_sets": 0,
            "indirect_completed_sets": 0, "indirect_planned_sets": 0, "exercises": [],
            "week_start": week_start, "week_end": week_end, "dose_scope": "materialized_workouts"})

    for workout in sorted(workouts, key=lambda row: row["date"]):
        for item in items(workout):
            snapshot = item["exercise_snapshot"]
            if trend_start <= workout["date"] <= as_of:
                representatives[load_key(snapshot)] = (snapshot, item.get("progression_context"))
            if not week_start <= workout["date"] <= week_end:
                continue
            sets = work_sets(item)
            completed = sum((row.get("actual") or {}).get("status") == "completed" for row in sets) if workout["date"] <= as_of else 0
            primary = set(snapshot.get("primary_muscles", []))
            for kind, names in (("direct", primary), ("indirect", set(snapshot.get("secondary_muscles", [])) - primary)):
                for name in names:
                    summary = muscle(name)
                    summary[f"{kind}_planned_sets"] += len(sets)
                    summary[f"{kind}_completed_sets"] += completed
    for snapshot, context in representatives.values():
        summary = analyze_exercise(snapshot, context, workouts, as_of)
        for name in set(snapshot.get("primary_muscles", [])):
            row = muscle(name)
            row["tracked_exercises"] += 1
            row["comparable_exercises"] += int(summary["trend"]["effort_comparable"])
            row["improving_exercises"] += int(summary["trend"]["status"] == "improving")
            row["exercises"].append({"exercise_id": snapshot["exercise_id"], "name": snapshot["name"], "trend": summary["trend"]})
    return sorted(muscles.values(), key=lambda row: row["muscle"])
