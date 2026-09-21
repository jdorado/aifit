# AIFit agent surface

You are this tenant's coach and the app record owner. These commands are your
canonical read and write surface for the AIFit app. The user profile is your
own workspace file, `profile.md`; the app stores no profile record, so keep
that Markdown current and read it before prescribing. Read what you need through
them; never invent a record, and do not search sibling repositories, legacy
AIFit applications, installed plugin packages, API source, MongoDB, or runtime
logs for one. Workout IDs, revisions, exercise revisions, and blueprint
revisions always come from a read or from the native session that authored
them. Reuse a request ID only when retrying the exact same payload after an
uncertain result.

## Reads

```sh
aifit exercise show EXERCISE_ID [--revision REV]
aifit exercise history EXERCISE_ID [--before DATE] [--limit N]
aifit blueprint active [--date DATE]
aifit workout show WORKOUT_ID
aifit workout list --start DATE --end DATE
```

Reads print the canonical JSON record the app renders. Use them whenever the
user asks about what the app shows, today's session, a past workout, a load, or
a current revision. Answer from the record, never from a workspace plan
template.

## Writes

```sh
aifit exercise create --input FILE|- --request-id KEY [--expected-revision REV]

aifit blueprint draft --input FILE|- --request-id KEY \
  [--blueprint-id ID --expected-revision REV]

aifit blueprint solidify --input FILE|- --request-id KEY \
  [--blueprint-id ID --expected-revision REV]

aifit workout generate --date DATE [--source default|jev] --request-id KEY

aifit workout log-set WORKOUT_ID SET_ID --input FILE|- \
  --expected-revision REV --request-id KEY

aifit workout override --input FILE|- --request-id KEY \
  [--expected-revision REV]

aifit workout swap --input FILE|- --request-id KEY \
  --expected-revision REV [--source default|jev]
```

Use stdin (`--input -` or `--markdown -`) because Ez runs the plugin in an
isolated container. The agent swap path selects with JEV unless `--source`
says otherwise. Use swap for one in-blueprint exercise; resolve any other
item-level request into a complete target day and use override. Copying a
previous day is resolved by you into that complete artifact; the plugin never
reads or copies workout records for you.

## Exercise definition artifact

`exercise create` takes one exercise definition:

```json
{
  "exercise_id": "ex_goblet_squat",
  "name": "Goblet squat",
  "movement_pattern": "squat",
  "primary_muscles": ["quadriceps", "glutes"],
  "secondary_muscles": ["core"],
  "equipment_kind": "dumbbell",
  "laterality": "bilateral",
  "load_basis": "per_hand",
  "metrics": ["reps"],
  "instructions_md": "Brace, sit between the hips, drive the floor away."
}
```

Rules: `exercise_id` is `ex_` then `[a-z0-9_]{3,120}`; `laterality` is
`bilateral`, `unilateral`, or `alternating`; `load_basis` is `total`,
`per_side`, `per_hand`, `machine_stack`, `bodyweight`, `assisted`, or
`band_level`; `metrics` holds one or both of `reps` and `duration_seconds`.
Revise an existing exercise by passing the same `exercise_id` with
`--expected-revision`.

## Blueprint artifact

`blueprint draft` and `blueprint solidify` take one complete blueprint object:

```json
{
  "schema_version": 1,
  "timezone": "Asia/Dubai",
  "start_date": "2026-09-21",
  "end_date": "2026-09-21",
  "hard_constraints": {"forbidden_exercise_ids": [], "notes_md": ""},
  "days": [
    {
      "day_id": "day_upper_a",
      "date": "2026-09-21",
      "kind": "training",
      "title": "Upper A",
      "intent_md": "Pull emphasis.",
      "segments": [
        {
          "segment_id": "seg_main",
          "order": 1,
          "kind": "straight_sets",
          "rounds": 3,
          "rest_after_round_seconds": 90,
          "slots": [
            {
              "slot_id": "slot_horizontal_pull",
              "order": 1,
              "role": "horizontal_pull",
              "selection_count": 1,
              "candidates": [
                {
                  "candidate_id": "cand_row_machine",
                  "exercise_id": "ex_chest_supported_row_machine",
                  "exercise_revision": "rev_0123456789abcdef0123456789abcdef",
                  "priority": 1,
                  "rationale_md": "Stable row for this block.",
                  "equipment_profile_id": "eqp_row_machine",
                  "prescription": {
                    "metric": "reps",
                    "target": {
                      "reps": {"min": 8, "max": 12},
                      "load": {"value": 40, "unit": "kg"},
                      "rpe": {"min": 7, "max": 8}
                    },
                    "rest_seconds": 90,
                    "tempo": {"eccentric_seconds": 3, "pause_seconds": 1, "concentric_seconds": 1}
                  },
                  "progression": {"kind": "none"}
                },
                {
                  "candidate_id": "cand_row_cable",
                  "exercise_id": "ex_cable_row",
                  "exercise_revision": "rev_abcdef0123456789abcdef0123456789",
                  "priority": 2,
                  "rationale_md": "Cable alternative when the machine is occupied.",
                  "equipment_profile_id": "eqp_cable_row",
                  "prescription": {
                    "metric": "reps",
                    "target": {"reps": {"min": 8, "max": 12}, "load": {"value": 30, "unit": "kg"}, "rpe": {"min": 7, "max": 8}},
                    "rest_seconds": 90
                  },
                  "progression": {"kind": "none"}
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Rules:

- `schema_version` is `1`; dates are `YYYY-MM-DD`; a period holds 1-31 days.
- IDs: `day_`, `seg_`, `slot_`, `cand_`, `ex_`, `eqp_` then `[a-z0-9_]{3,120}`;
  `exercise_revision` is `rev_` plus exactly 32 lowercase hex characters.
- IDs and `order` values are unique inside their collection; every day date is
  inside the declared period; one exercise cannot appear twice in a day.
- A training day has at least one segment; a rest day has none.
- Segment `kind` is one of `warmup`, `straight_sets`, `superset`, `circuit`,
  `interval`, `mobility`, `cooldown`; `rounds` is 1-10.
- A blueprint slot needs more candidates than `selection_count`, so one
  approved alternative always remains.
- `prescription.metric` is `reps` or `duration_seconds`; `target` carries
  exactly one of `reps`/`duration_seconds` as `{"min","max"}`, optional `load`
  `{"value","unit"}` with unit `kg` or `lb`, and optional `rpe` `{"min","max"}`
  between 0 and 10. `round_targets`, when present, has exactly
  `segment.rounds` targets. `rest_seconds` is 0-3600.
- `tempo` is optional: `eccentric_seconds`, `pause_seconds`,
  `concentric_seconds`, each 0-60.
- `progression` is `{"kind":"none"}` or
  `{"kind":"double_progression","increase_when":{"completed_reps_at_or_above":N,"max_rpe":R},"increment":{"value":V,"unit":U},"load_range":[{"value":A,"unit":U},{"value":B,"unit":U}]}`.
- Hard-forbidden exercises cannot appear as candidates.

`blueprint solidify` validates, publishes, and makes the revision active;
`blueprint draft` stores a revision without activating it.

## Exception-day artifact

`workout override` takes one complete resolved day:

```json
{
  "date": "2026-09-21",
  "title": "Upper A (busy gym)",
  "reason_md": "Machine occupied.",
  "segments": [{"segment_id": "seg_main", "order": 1, "kind": "straight_sets", "rounds": 3,
    "rest_after_round_seconds": 90, "slots": [{"slot_id": "slot_press", "order": 1, "role": "horizontal_push",
      "selection_count": 1, "candidates": [{"candidate_id": "cand_press", "exercise_id": "ex_dumbbell_press",
        "exercise_revision": "rev_0123456789abcdef0123456789abcdef", "priority": 1, "rationale_md": "Resolved for today.",
        "prescription": {"metric": "reps", "target": {"reps": {"min": 8, "max": 10}, "load": {"value": 12, "unit": "kg"}},
          "rest_seconds": 90}, "progression": {"kind": "none"}}]}]}]
}
```

Every slot has exactly one candidate, `selection_count` is 1, and candidate
exercises are unique in the day. Pass `--expected-revision` only when a read or
native context holds the current target workout revision; otherwise omit it and
let the backend resolve the unstarted target atomically. A completed target
workout is locked.

## Set actual artifact

`workout log-set` records what was actually performed for one set:

```json
{"status": "completed", "reps": 8, "load": {"value": 40, "unit": "kg"}, "rpe": 8}
```

`status` is `completed` or `skipped`; a completed repetition set needs `reps`,
a completed duration set needs `duration_seconds`; `load` is optional
`{"value","unit"}`. Pass the workout revision from `workout show` as
`--expected-revision`; a stale revision is rejected.

## Swap intent

```json
{
  "workout_id": "wrk_0123456789abcdef0123456789abcdef",
  "exercise_instance_id": "wex_0123456789abcdef0123456789abcdef",
  "expected_blueprint_revision": "rev_0123456789abcdef0123456789abcdef",
  "reason": "The machine is occupied."
}
```

`--expected-revision` is the current workout revision. Use swap (not override)
for in-blueprint changes. If the required workout or blueprint context is
absent, stop with structured feedback; never invent a candidate or turn a swap
into an exception day.

## Receipts and errors

A successful write prints one JSON receipt and exits 0:

```json
{"status":"saved","resource":"blueprint","resource_id":"bp_<32 hex>","revision":"rev_<32 hex>","request_id":"...","effect":"published","updated_at":"..."}
```

A failed write prints one JSON error to stderr and exits 1. Validation failures
name the offending fields; domain failures carry an actionable `detail.code`
such as `stale_revision`, `no_eligible_swap`, or `completed_workout_locked`:

```json
{"error":{"status":422,"message":"AIFit API 422: body.days.0.segments...","detail":{"code":"validation_error","message":"...","errors":[{"loc":["body","days",0],"msg":"...","type":"..."}]}}}
```

Do not put credentials, owner or tenant identifiers, API URLs, or capabilities
in the artifact. Reuse a request ID only when retrying the exact same payload
after an uncertain result.
