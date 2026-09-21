# AIFit / Ez migration contract

Status: current migration boundary.

The Ez platform is the consumer of the AIFit plugin. The frontend is not a
consumer of the plugin; it is a consumer of the AIFit backend.

## 1. Boundary

The agent-facing CLI is the coach's full application surface: canonical reads
plus the deterministic writes the frontend uses.

```sh
aifit profile show
aifit exercise show EXERCISE_ID [--revision REV]
aifit exercise history EXERCISE_ID [--before DATE] [--limit N]
aifit blueprint active [--date DATE]
aifit workout show WORKOUT_ID
aifit workout list --start DATE --end DATE

aifit profile update --markdown FILE|- --request-id KEY [--expected-revision REV]
aifit exercise create --input FILE|- --request-id KEY [--expected-revision REV]
aifit blueprint draft --input FILE|- --request-id KEY [--blueprint-id ID --expected-revision REV]
aifit blueprint solidify --input FILE|- --request-id KEY [--blueprint-id ID --expected-revision REV]
aifit workout generate --date DATE [--source default|jev] --request-id KEY
aifit workout log-set WORKOUT_ID SET_ID --input FILE|- --expected-revision REV --request-id KEY
aifit workout override --input FILE|- --request-id KEY [--expected-revision REV]
aifit workout swap --input FILE|- --request-id KEY --expected-revision REV [--source default|jev]
```

`--input -` and `--markdown -` are the normal Ez form: the agent reads the
artifact from its workspace and streams it to the isolated plugin command
container. A direct file path is valid only when the runtime explicitly mounts
that path.

The native Ez agent owns the conversation, normal workspace and Markdown
context, profile, goals, constraints, research, exercise knowledge, relevant
history, complete blueprint/exception authoring, and the decision to retry or
ask for clarification.

The AIFit plugin owns only transport: typed artifacts, ids, and read requests
to the authoritative AIFit API. It does not run a model, reconstruct a profile,
generate a workout outside the API's blueprint-constrained paths, or expose a
second application workflow. The agent reads the records the frontend renders;
it never rebuilds them from workspace files.

AIFit backend owns schema and domain validation, canonical blueprint revisions,
the active pointer, deterministic workout materialization, exceptional workout
records, workout/set/swap/progression/history records, and the backend read API
used by the frontend.

## 2. Solidify is validate + publish

The plugin sends one complete `BlueprintInput` JSON object. The API performs
typed-schema validation (JSON shape, dates, ID patterns, numeric loads and
units, ordering, and nested field types) so the frontend can render the record.
The agent authors exercise IDs and revisions; the API does not require a prior
catalog row.

If a check fails, the API returns feedback and writes neither a new active
pointer nor a partially accepted blueprint. The CLI prints that feedback so the
native agent can correct the artifact and retry with a new request ID.

If every check passes, the API stores a new canonical revision with
`status: "published"`, points the account's active blueprint at it, and
returns a receipt plus the public published blueprint.

`blueprint draft` stores a non-active revision; there is no separate
agent-facing `validate` or `program publish` sequence, and solidification
remains the publish boundary. The
active blueprint ID/revision is the canonical workout authority; an older
release pointer is valid only when it names that same blueprint revision.

### Revision rules

- Creating a blueprint: omit `blueprint_id` and `expected_revision`.
- Revising one: provide the existing `blueprint_id` and its current
  `expected_revision`.
- A stale revision is rejected; the agent must use current context and author a
  new revision.
- Reusing a `request_id` is idempotent only for the exact same request payload.

### Receipt shape

```json
{
  "status": "saved",
  "resource": "blueprint",
  "resource_id": "bp_<32 hex characters>",
  "revision": "rev_<32 hex characters>",
  "request_id": "blueprint-2026-09-21-a",
  "effect": "published",
  "updated_at": "2026-09-18T10:00:00Z",
  "blueprint": {}
}
```

The CLI never accepts account IDs, tenant IDs, API URLs, or capabilities. Ez
derives those from the signed run context and grants the surface in two
permissions: `aifit:read` for canonical reads, `aifit:write` for domain
mutations.

## 3. Exceptional workout artifact

An exception is one complete resolved target day. It is the agent-facing escape
hatch for a request such as “replace today's exercise with one that is not in
the blueprint,” “make today a wholly new workout,” or “do yesterday's workout
today.” The agent resolves that intent from its native context and sends the
full target day:

```sh
cat /absolute/path/exception-day.json | ez aifit workout override \
  --input - \
  --request-id override-<unique-key> \
  [--expected-revision REV]
```

The input contains `date`, `title`, `reason_md`, and the complete typed
`segments` array. Every override slot must contain exactly one already-resolved
candidate; the backend never silently chooses an item for an exception day. An
item-level change is still sent as the complete target day so the backend never
has to infer which other items should remain. Copying a previous day is also
resolved by the agent into that complete artifact; the plugin does not read or
copy workout records.

The backend validates every exercise revision and metric, applies the active
blueprint's hard constraints, and replaces only an unstarted workout for the
target date. If `--expected-revision` is supplied it must match the current
workout revision; if omitted, the backend resolves the current unstarted target
and applies the replacement atomically. It stores the result with
`lineage.source: "agent_override"`, the active blueprint ID/revision, the agent
job ID, the reason, and any replaced workout revision. It does not modify the
blueprint or its active pointer. A completed target workout is locked, and a
stale supplied revision is rejected.

### 3a. Blueprint-constrained swap

An in-blueprint request such as “the machine is taken; swap this exercise” is
not an exception day. The native mini-chat context contains only scoped
references for the current target item and active blueprint revision. The agent
sends this small intent through the plugin:

```json
{
  "workout_id": "wrk_<32 hex characters>",
  "exercise_instance_id": "wex_<32 hex characters>",
  "expected_blueprint_revision": "rev_<32 hex characters>",
  "reason": "The machine is occupied."
}
```

The CLI adds the request ID and current workout revision. The agent route
selects with JEV unless `--source default` is passed explicitly. The backend
verifies the expected active blueprint revision
and the workout's blueprint lineage, then selects an unused candidate from the
same blueprint slot, preserves every other workout item, and records the active
blueprint ID/revision in the swap receipt. It rejects stale or completed
workouts and returns `no_eligible_swap` when the blueprint has no alternative.

The receipt has the same shape as other AIFit writes, with `resource: "workout"`
and `effect: "swapped"`.

## 4. Blueprint artifact

The input is the documented `BlueprintInput` object. The agent-facing copy of
the typed schema and its rules is `plugins/aifit/SKILL.md`, shipped with the
plugin; this section is the architecture reference. It is a closed-world
artifact: all workout choices needed for materialization are inside it, while
identity and authority stay outside it.

Top-level shape:

```json
{
  "schema_version": 1,
  "timezone": "Asia/Dubai",
  "start_date": "2026-09-21",
  "end_date": "2026-09-21",
  "hard_constraints": {
    "forbidden_exercise_ids": [],
    "notes_md": ""
  },
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
                  "exercise_revision": "rev_<32 hex characters>",
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
                    "tempo": {
                      "eccentric_seconds": 3,
                      "pause_seconds": 1,
                      "concentric_seconds": 1
                    }
                  },
                  "progression": {"kind": "none"}
                },
                {
                  "candidate_id": "cand_row_cable",
                  "exercise_id": "ex_cable_row",
                  "exercise_revision": "rev_<32 hex characters>",
                  "priority": 2,
                  "rationale_md": "Cable alternative when the machine is occupied.",
                  "equipment_profile_id": "eqp_cable_row",
                  "prescription": {
                    "metric": "reps",
                    "target": {
                      "reps": {"min": 8, "max": 12},
                      "load": {"value": 30, "unit": "kg"},
                      "rpe": {"min": 7, "max": 8}
                    },
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

The typed schema is authoritative for field limits and nested invariants. The
important rules are:

- `schema_version` is `1` and dates use `YYYY-MM-DD`.
- Every day is inside the declared period; IDs and array orders are unique in
  their enclosing collection.
- Training days have segments; rest days have none.
- A day cannot place the same exercise in multiple candidate slots.
- A blueprint slot has more candidates than `selection_count`, leaving at least
  one blueprint-approved alternative when equipment, space, or preference
  changes. An exception-day slot is different: it must contain exactly one
  already-resolved candidate.
- A target uses exactly one primary metric: repetitions or duration.
- Loads use a numeric `value` and a `kg` or `lb` unit.
- Hard-forbidden exercises cannot appear as candidates.
- Progression fields are present only for their declared progression kind.

The agent should author this object from its normal context. The plugin should
not grow profile, exercise-catalog, history, or context commands to make
authoring easier; that would recreate the second agent surface this boundary
removes.

## 5. Backend consumption

After solidification, the active revision is consumed by the backend paths:

```http
GET  /v1/blueprints/active?date=YYYY-MM-DD
POST /v1/workouts/generate
GET  /v1/workouts?start=YYYY-MM-DD&end=YYYY-MM-DD
GET  /v1/workouts/{workout_id}
```

The frontend calls these authenticated backend routes. It never invokes the
plugin, reads `EZ_PLUGIN_CONTEXT`, or treats a working JSON file as canonical.

Generation input is deliberately small:

```json
{
  "date": "2026-09-21",
  "source": "default",
  "request_id": "generate-2026-09-21"
}
```

`source` is one of `default` or `jev`:

- `default` selects the highest-priority eligible candidate in each blueprint
  slot;
- `jev` makes a bounded, deterministic weighted choice from the same slot
  candidates.

Neither source can introduce an exercise outside the published blueprint.
Every materialized workout stores the blueprint ID/revision, day ID, source,
and selection decision receipt in its lineage. Generation is idempotent by
`request_id` and date.

## 6. Other backend behavior

Workout logging and progression remain backend responsibilities. Swaps are also
backend decisions; the plugin only transports the native agent's small swap
intent for mini-chat. A swap is constrained to candidates in the active
blueprint slot and records its source and decision receipt. Completion history
is keyed by the exact exercise, equipment profile, load basis, and laterality
used by the materialized workout.

During migration, older browser plan/release routes may still exist for an
existing consumer. They are not part of the new Ez agent contract and must not
be added to the plugin skill or CLI.

## 7. Error and authority contract

The plugin receives a run-scoped signed capability from Ez. The API validates
the capability signature and expiry, account and job binding, and the exact
permission for each operation: `aifit:read` for canonical reads and
`aifit:write` for domain mutations. The agent supplies none of those values.

Blueprint/schema failures return structured validation feedback. Domain failures
use a stable error code and message, for example:

```json
{
  "detail": {
    "code": "validation_error",
    "message": "body.days.0.segments.0.slots.0.candidates.0.exercise_revision: String should match pattern '^rev_[a-f0-9]{32}$'",
    "errors": [
      {
        "loc": ["body", "days", 0, "segments", 0, "slots", 0, "candidates", 0, "exercise_revision"],
        "msg": "String should match pattern '^rev_[a-f0-9]{32}$'",
        "type": "string_pattern_mismatch"
      }
    ]
  }
}
```

No prompt, transcript, private model chain-of-thought, account credential, or
Ez context is persisted as part of the blueprint mutation.

## 8. Explicit non-goals

The AIFit plugin does not expose model or conversation surfaces:

```text
aifit context ...
aifit chat ... | aifit conversation ... | aifit message ...
aifit blueprint validate ...
aifit account ... | aifit tenant ... | aifit telegram ...
```

There is no AIFit model runner, prompt builder, conversation store, workspace
reader, or frontend adapter inside the plugin. The surface is the canonical
record boundary: read the app's records, author in Ez, apply deterministic
operations in AIFit.

## 9. Verification expectations

A local installation is complete only when:

1. Ez inspects and pins the exact local plugin source revision.
2. `ez aifit --help` shows the canonical reads and writes.
3. A canonical read (for example `aifit workout list`) returns the same record
   the frontend renders.
4. An invalid blueprint returns visible feedback without publishing.
5. A valid blueprint returns a published receipt.
6. A valid exception returns a workout receipt without changing the active
   blueprint revision.
6. The active-blueprint route observes the unchanged published revision.
7. Backend generation consumes that revision through `default` and `jev`, and
   the workout read route returns the exceptional day for the frontend.
