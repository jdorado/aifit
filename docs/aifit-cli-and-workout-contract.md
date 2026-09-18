# AIFit CLI and workout contract

Status: accepted end-state contract. It intentionally has no legacy or compatibility mode.

## 1. Outcome

AIFit needs a narrow custom CLI that lets the user's Ez agent read and change
canonical AIFit records without moving reasoning, conversation history, or general
workspace knowledge into the application backend.

The workout lifecycle is:

```text
profile context
    -> fitness plan
    -> published program release (plan revision + cycle blueprint)
    -> generated workout session
    -> completed set logs
    -> derived exercise history
```

The common path—opening today's workout, generating it, swapping an exercise, and
progressing loads—must not require an LLM turn. The agent remains able to discuss,
author, or override any workout through the same canonical contract.

## 2. Ownership boundary

### Ez and the native agent own

- the conversation and its continuity;
- reasoning and coaching judgment;
- Markdown notes, research, uploaded files, images, and other workspace context;
- authoring the user's profile narrative and Fitness Plan;
- authoring or revising a cycle blueprint;
- exceptional workouts requested through conversation.

These stay in the standard isolated Ez workspace. AIFit does not copy the native
conversation transcript into its database and does not build replacement prompts,
memory, or agent workflows.

### AIFit owns

- authenticated user and coach authorization;
- canonical, renderable profile, program, blueprint, workout, and completion records;
- schema validation, optimistic concurrency, idempotency, and mutation receipts;
- deterministic workout materialization and bounded variation;
- derived workout history and load-progression inputs;
- frontend projections.

### The CLI owns

Only transport. It converts explicit commands and structured input into calls to the
protected AIFit API. It must not infer user intent, choose exercises, write workspace
memory automatically, assemble prompts, or become another source of truth.

The CLI never accepts an owner ID, email, tenant path, or arbitrary API URL. Ez gives
each invocation a short-lived capability already bound to the authenticated principal,
permissions, and current job.

## 3. Sources of truth

| Concern | Authority | Workspace representation |
| --- | --- | --- |
| Agent conversation/history | Native agent session | None required |
| General notes, research, images, files | Ez workspace | Ordinary Markdown and files |
| Profile shown in AIFit | AIFit profile record | Optional agent-authored `profile.md` |
| Scientific/high-level plan | AIFit Fitness Plan revision | Agent-authored `fitness-plan.md` |
| Renderable cycle structure | AIFit blueprint revision | Optional working JSON/YAML; not authoritative |
| Dated workout and set logs | AIFit workout session | Read on demand through CLI |
| Exercise history | Derived from completed canonical set logs | Read on demand through CLI |

Workspace files are authoring inputs and agent memory, not a database mirror. The CLI
only reads a file when the agent explicitly passes it to a command. It never scans or
periodically synchronizes the workspace. After a successful mutation, the receipt's
resource ID and revision are the canonical result.

## 4. Core terminology

- **Fitness Plan**: the high-level, human-readable strategy: goals, constraints,
  rationale, periodization, intended schedule, and evidence. It is Markdown and can be
  as expressive as the coach needs.
- **Program release**: an immutable pairing of one Fitness Plan revision and one valid
  cycle blueprint revision. Exactly one release may be active at a time.
- **Cycle blueprint**: the structured plan for a concrete bounded period, such as one,
  two, or three weeks. It defines dated training days and the feasible choice universe.
- **Segment**: an ordered unit of workout execution, such as warm-up, straight sets,
  superset, circuit, interval, or cooldown.
- **Slot**: one selection position inside a segment. A two-movement circuit has two
  slots; each slot selects one exercise from its own candidate set.
- **Exercise definition**: a stable, versioned movement/variant identity.
- **Exercise instance**: the snapshot of an exercise and its prescription inside one
  dated workout.
- **Set log**: what was actually performed. It is never inferred from a target.

`segment` and `slot` avoid overloading “block,” which in training also means a
multi-week phase.

## 5. Resource lifecycle

### 5.1 Profile

The profile is one revisioned record per account. Its main content is Markdown so the
agent can express goals, preferences, experience, schedule, equipment, limitations,
and relevant context naturally.

```json
{
  "profile_id": "prof_01...",
  "schema_version": 1,
  "revision": "rev_01...",
  "content_md": "# Goals\nBuild strength...",
  "updated_at": "2026-09-18T10:00:00Z",
  "updated_by": { "kind": "agent", "job_id": "job_01..." }
}
```

The first version should not extract an open-ended “facts graph.” Anything needed for
fast workout generation is compiled explicitly into the published blueprint. This
keeps the profile flexible and the runtime deterministic.

### 5.2 Fitness Plan

A Fitness Plan is revisioned Markdown. Recommended sections are guidance, not a parser
contract:

- goals and success measures;
- constraints and contraindications;
- training phase and intended duration;
- weekly/cycle strategy;
- progression and deload principles;
- recovery assumptions;
- rationale and references;
- conditions that should trigger reassessment.

```json
{
  "plan_id": "plan_01...",
  "schema_version": 1,
  "revision": "rev_01...",
  "title": "Eight-week strength and hypertrophy plan",
  "content_md": "# Intent\n...",
  "status": "draft",
  "updated_at": "2026-09-18T10:10:00Z"
}
```

Plan revisions are immutable after publication. Editing creates a new revision.

### 5.3 Program release

The agent drafts a plan and blueprint independently, then publishes them atomically:

```json
{
  "release_id": "rel_01...",
  "plan_id": "plan_01...",
  "plan_revision": "rev_plan_3",
  "blueprint_id": "bp_01...",
  "blueprint_revision": "rev_bp_2",
  "effective_from": "2026-09-21",
  "effective_through": "2026-10-04",
  "published_at": "2026-09-18T10:30:00Z"
}
```

Activation validates the entire blueprint and changes the active pointer in one
transaction. A frontend profile save cannot edit, clear, or replace this pointer.
Activating a new release supersedes the prior release but never rewrites historical
workouts that reference it.

## 6. Cycle blueprint contract

Blueprint days are date-bound, not keyed only by weekday. That supports multi-week
plans, alternating weeks, unusual schedules, and explicit rest days without hidden
calendar logic.

```json
{
  "blueprint_id": "bp_01...",
  "schema_version": 1,
  "revision": "rev_bp_2",
  "timezone": "Asia/Dubai",
  "start_date": "2026-09-21",
  "end_date": "2026-10-04",
  "hard_constraints": {
    "forbidden_exercise_ids": ["ex_barbell_upright_row"],
    "notes_md": "No painful overhead range. Stop on sharp pain."
  },
  "days": [
    {
      "day_id": "day_2026_09_21_upper_a",
      "date": "2026-09-21",
      "kind": "training",
      "title": "Upper A",
      "intent_md": "Horizontal pull emphasis with moderate triceps volume.",
      "segments": [
        {
          "segment_id": "seg_warmup",
          "order": 1,
          "kind": "warmup",
          "rounds": 1,
          "slots": []
        },
        {
          "segment_id": "seg_pull_triceps_circuit",
          "order": 2,
          "kind": "circuit",
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
                  "candidate_id": "cand_chest_supported_row",
                  "exercise_id": "ex_chest_supported_row_machine",
                  "exercise_revision": "rev_ex_4",
                  "priority": 1,
                  "rationale_md": "Stable pull with low lower-back fatigue.",
                  "equipment_profile_id": "eqp_gym_row_1",
                  "prescription": {
                    "metric": "reps",
                    "target": {
                      "reps": { "min": 8, "max": 12 },
                      "rpe": { "min": 7, "max": 8 }
                    },
                    "rest_seconds": 0,
                    "tempo": {
                      "eccentric_seconds": 3,
                      "pause_seconds": 1,
                      "concentric_seconds": 1
                    }
                  },
                  "progression": {
                    "kind": "double_progression",
                    "increase_when": {
                      "completed_reps_at_or_above": 12,
                      "max_rpe": 8
                    },
                    "increment": { "value": 5, "unit": "kg" },
                    "load_range": [
                      { "value": 20, "unit": "kg" },
                      { "value": 80, "unit": "kg" }
                    ]
                  }
                }
              ]
            },
            {
              "slot_id": "slot_triceps",
              "order": 2,
              "role": "elbow_extension",
              "selection_count": 1,
              "candidates": []
            }
          ]
        },
        {
          "segment_id": "seg_cooldown",
          "order": 3,
          "kind": "cooldown",
          "rounds": 1,
          "slots": []
        }
      ]
    },
    {
      "day_id": "day_2026_09_22_rest",
      "date": "2026-09-22",
      "kind": "rest",
      "title": "Recovery",
      "intent_md": "Optional walking and normal mobility."
    }
  ]
}
```

The abbreviated empty candidate lists above are illustrative only. A publishable
training day must satisfy all validation rules.

### Blueprint invariants

1. Dates are unique, fall inside the period, and use the declared timezone.
2. IDs are stable and unique within the blueprint; array order is explicit.
3. A training day has at least one segment and every required slot has enough unique
   eligible candidates to satisfy `selection_count`.
4. Segment kinds are `warmup`, `straight_sets`, `superset`, `circuit`, `interval`,
   `mobility`, or `cooldown`.
5. A candidate references one existing immutable exercise revision.
6. A forbidden exercise cannot appear as a candidate.
7. Every candidate has a complete typed prescription and progression policy, or an
   explicit `progression.kind: "none"`.
8. `segment.rounds` is the execution/set count for every selected slot in that
   segment. The candidate target applies to each round; an optional `round_targets`
   array may vary them but must contain exactly `rounds` entries. Set count is not
   duplicated inside the candidate.
9. Quantity fields are numbers plus explicit units. Display strings such as `"20kg"`
   are invalid at the API boundary.
10. Hard constraints are never overridable. Soft selection constraints may be
   overridden only by an agent-authored workout carrying explicit provenance.
11. Publishing fails as a whole; partial blueprints never become active.

## 7. Exercise identity

Muscle labels are useful for search and explanation, but they are not exercise
identity and never justify copying a load.

```json
{
  "exercise_id": "ex_chest_supported_row_machine",
  "schema_version": 1,
  "revision": "rev_ex_4",
  "name": "Chest-supported machine row",
  "movement_pattern": "horizontal_pull",
  "primary_muscles": ["latissimus_dorsi"],
  "secondary_muscles": ["rhomboids", "posterior_deltoid", "biceps_brachii"],
  "equipment_kind": "machine",
  "laterality": "bilateral",
  "load_basis": "machine_stack",
  "metrics": ["reps"],
  "instructions_md": "Keep the chest supported..."
}
```

The exact load-comparison identity is:

```text
exercise_id + equipment_profile_id + load_basis + laterality
```

`equipment_profile_id` identifies a specific machine/stack or implement context when
loads are not portable between equipment. A missing equipment profile makes the load
history lower-confidence; it does not permit falling back to same-muscle loads.

Exercise revisions may correct display/instruction metadata without breaking load
compatibility. A material movement, equipment, laterality, or load-basis change must
create a new exercise identity; revisions do not create an implicit equivalence class.

## 8. Workout session contract

A workout is a materialized snapshot. It does not dereference mutable plan or
exercise content at render time.

```json
{
  "workout_id": "wrk_01...",
  "schema_version": 1,
  "revision": "rev_wrk_1",
  "date": "2026-09-21",
  "timezone": "Asia/Dubai",
  "status": "planned",
  "title": "Upper A",
  "lineage": {
    "source": "default",
    "release_id": "rel_01...",
    "blueprint_id": "bp_01...",
    "blueprint_revision": "rev_bp_2",
    "day_id": "day_2026_09_21_upper_a",
    "decision_receipt_id": "dec_01..."
  },
  "segments": [
    {
      "segment_id": "seg_pull_triceps_circuit",
      "order": 2,
      "kind": "circuit",
      "rounds": 3,
      "rest_after_round_seconds": 90,
      "items": [
        {
          "exercise_instance_id": "wex_01...",
          "slot_id": "slot_horizontal_pull",
          "candidate_id": "cand_chest_supported_row",
          "order": 1,
          "exercise_snapshot": {
            "exercise_id": "ex_chest_supported_row_machine",
            "exercise_revision": "rev_ex_4",
            "name": "Chest-supported machine row",
            "movement_pattern": "horizontal_pull",
            "primary_muscles": ["latissimus_dorsi"],
            "secondary_muscles": ["rhomboids", "posterior_deltoid"],
            "equipment_kind": "machine",
            "equipment_profile_id": "eqp_gym_row_1",
            "laterality": "bilateral",
            "load_basis": "machine_stack"
          },
          "sets": [
            {
              "set_id": "set_1",
              "kind": "work",
              "round": 1,
              "target": {
                "reps": { "min": 8, "max": 12 },
                "load": { "value": 55, "unit": "kg" },
                "rpe": { "min": 7, "max": 8 }
              },
              "actual": null
            },
            {
              "set_id": "set_2",
              "kind": "work",
              "round": 2,
              "target": {
                "reps": { "min": 8, "max": 12 },
                "load": { "value": 55, "unit": "kg" },
                "rpe": { "min": 7, "max": 8 }
              },
              "actual": null
            },
            {
              "set_id": "set_3",
              "kind": "work",
              "round": 3,
              "target": {
                "reps": { "min": 8, "max": 12 },
                "load": { "value": 55, "unit": "kg" },
                "rpe": { "min": 7, "max": 8 }
              },
              "actual": null
            }
          ],
          "cues_md": "Three-second eccentric; pause briefly at contraction."
        }
      ]
    }
  ],
  "created_at": "2026-09-21T05:00:00Z",
  "updated_at": "2026-09-21T05:00:00Z"
}
```

An actual set log is typed and separate from the target:

```json
{
  "status": "completed",
  "reps": 11,
  "load": { "value": 55, "unit": "kg" },
  "rpe": 8,
  "completed_at": "2026-09-21T06:22:00Z"
}
```

No field accepts both a string and an object. Zero is a valid number. Missing is
`null` or field absence, never an empty string. Units remain explicit at write time.

## 9. Generation modes

### 9.1 Default

`default` is the normal path and contains no model call:

1. Resolve the active release and date-bound blueprint day.
2. Select the lowest-priority-number eligible candidate for each slot.
3. Exclude duplicate exercise selections.
4. Materialize exercise snapshots and sets.
5. Calculate each load from compatible completed history and the candidate's
   progression policy.
6. Validate hard constraints and save idempotently.

Given the same release, compatible history, and request ID, this produces
the same workout.

### 9.2 Varied

`varied` replaces the old “JEV generates the workout” concept with a bounded decision:

- the decision engine receives only valid candidates for each slot;
- it may rank or sample candidates within that closed set;
- it cannot invent an exercise, change segment structure, or exceed prescription and
  progression bounds;
- its engine/model version, candidate set, scores/probabilities, seed when applicable,
  and selections are stored in a decision receipt;
- failure falls back to `default`, not to an unconstrained generation prompt.

Variation chooses feasible exercises. It does not randomly increase loads. Load
progression remains bounded by the explicit policy and compatible completion history.

### 9.3 Agent override

When the user asks for something genuinely new, Ez continues the native conversation.
The agent can discuss tradeoffs, inspect the relevant canonical records through the
CLI, and save a full workout.

An override outside the blueprint's soft candidate universe requires:

```json
{
  "source": "agent_override",
  "release_id": "rel_01...",
  "override": {
    "reason_md": "User requested novelty; substituted a lower-impact outdoor session.",
    "agent_job_id": "job_01...",
    "replaced_revision": "rev_01..."
  }
}
```

The API still rejects hard constraints, invalid exercise identities, malformed sets,
or unauthorized writes. “Agentic” means the agent can author a different valid result;
it does not mean bypassing identity, safety, concurrency, or audit contracts.

## 10. Load progression and history

Canonical history is the sequence of saved workout snapshots and completed set logs.
A performance index may be materialized for speed, but it is rebuildable and never
directly writable by the frontend or agent.

For each candidate, generation reads recent exposures with the exact compatible load
identity. The progression decision records:

- source workout and exercise instance IDs;
- history watermark/revision;
- previous completed sets;
- policy and bounds used;
- decision: `initialize`, `hold`, `increase`, `decrease`, or `deload`;
- resulting target and concise reason.

Default double progression is:

1. Initialize from a blueprint range or an explicit conservative starting value when
   there is no compatible history.
2. Hold while prescribed work is incomplete or the top of the rep range is not met.
3. Increase by the declared increment only after the completion/RPE rule is met.
4. Deload only under the blueprint's explicit deload rule or an agent-authored change.
5. Clamp every decision to the candidate's load range.

Same movement family and same primary muscle are discovery relationships only. They
may suggest swap candidates or help answer questions, but never transfer a weight.

## 11. Swap contract

### Fast swap

The frontend calls the backend directly for the common swap:

```http
POST /v1/workouts/{workout_id}/exercises/{exercise_instance_id}/swap
Content-Type: application/json

{
  "mode": "default",
  "reason": "equipment_unavailable",
  "expected_revision": "rev_wrk_1",
  "request_id": "swap_..."
}
```

The backend finds the originating slot, excludes already used exercises and the active
candidate, applies availability, chooses within that slot, materializes a compatible
prescription/load, saves the workout, and returns the updated workout plus receipt.
`mode: "varied"` may use the bounded decision engine over that same candidate set.

If no candidate remains, it returns `409 no_eligible_swap`; it does not broaden to the
same muscle automatically.

### Conversational swap

“Change this to X” or a more nuanced request goes through scoped mini-chat. The agent
may choose another blueprint candidate or save an explicit override. The resulting
canonical mutation is returned to the frontend by receipt and read back from AIFit.

## 12. Mini-chat contract

Mini-chat is a scoped view into the same Ez agent, not a backend answer generator.
The frontend sends identifiers, not a reconstructed workout prompt:

```http
POST /v1/agent/messages
Content-Type: application/json

{
  "conversation_id": "conv_workout_01...",
  "request_id": "018f2c51-bab0-7a48-afdb-d6c67a52d355",
  "message": "Why this exercise, and how should I do it?",
  "scope": {
    "kind": "workout_exercise",
    "workout_id": "wrk_01...",
    "exercise_instance_id": "wex_01..."
  }
}
```

The backend validates ownership, submits the message to the account's Ez binding, and
mints a job-scoped capability. Ez continues the native session. The agent can retrieve
only the focused data it needs:

```sh
aifit workout show wrk_01
aifit history exercise ex_chest_supported_row_machine --limit 6
```

Common questions include “why this?”, form explanation, “what did I do last time?”,
and “change this to X.” Read-only answers create no AIFit mutation. A change is complete
only when a CLI mutation returns a receipt and the frontend reads the new workout
revision.

Candidate rationale, exercise instructions, cues, and recent exact history are already
structured on the focused records. The UI may show those facts immediately for “why”
and form help; when the user opens chat, the agent reads the same compact fields instead
of regenerating or reloading the complete plan and history.

Separate mini-chat surfaces may use separate `conversation_id` values, but they still
bind to the same tenant agent. AIFit stores delivery/job state and rendered messages;
it does not reconstruct native model history.

## 13. CLI surface

Commands are explicit and print the exact JSON response. Mutation payloads use an
explicit JSON or Markdown file. Large structured data is never placed in shell
arguments.

```text
aifit context

aifit profile show
aifit profile update --markdown FILE --expected-revision REV --request-id KEY

aifit plan draft --markdown FILE --expected-revision REV_OR_NONE --request-id KEY

aifit exercise show ID [--revision REV]
aifit exercise create --input FILE --request-id KEY
aifit exercise revise --input FILE --expected-revision REV --request-id KEY

aifit blueprint validate --input FILE
aifit blueprint draft --input FILE --request-id KEY [--blueprint-id ID --expected-revision REV]
aifit program publish --plan-id ID --plan-revision REV \
  --blueprint-id ID --blueprint-revision REV --request-id KEY
aifit program active [--date YYYY-MM-DD]

aifit workout show ID
aifit workout list --start YYYY-MM-DD --end YYYY-MM-DD
aifit workout generate --date YYYY-MM-DD --mode default|varied --request-id KEY
aifit workout override --input FILE --expected-revision REV_OR_NONE --request-id KEY
aifit workout swap --workout-id ID --exercise-instance ID --mode default|varied \
  --reason REASON --expected-revision REV --request-id KEY

aifit history exercise ID --before YYYY-MM-DD --limit N
```

There is deliberately no generic raw HTTP command, owner selector, force-write flag,
workspace sync daemon, or `--ignore-constraints` option.

### Receipts

Every mutation returns the same envelope:

```json
{
  "status": "saved",
  "resource": "workout",
  "resource_id": "wrk_01...",
  "revision": "rev_wrk_2",
  "request_id": "swap_...",
  "effect": "updated",
  "updated_at": "2026-09-21T06:00:00Z"
}
```

Retrying the same key with the same payload returns the same effect. Reusing it with a
different payload returns `409 idempotency_conflict`. A stale expected revision returns
`409 stale_revision` with the current revision; the CLI never force-overwrites it.

## 14. Frontend ↔ backend API

The frontend never calls the CLI or Ez directly.

Minimum product endpoints:

```text
GET    /v1/profile
PUT    /v1/profile
POST   /v1/exercises
GET    /v1/exercises/{id}
GET    /v1/programs/active?date=YYYY-MM-DD
GET    /v1/workouts?start=...&end=...
GET    /v1/workouts/{id}
POST   /v1/workouts/generate
POST   /v1/workouts/{id}/exercises/{instance_id}/swap
PATCH  /v1/workouts/{id}/sets/{set_id}
GET    /v1/exercises/{id}/history
POST   /v1/agent/messages
GET    /v1/agent/jobs/{id}
```

The protected agent API may share service functions and schemas, but uses scoped Ez
capabilities rather than browser authentication. Backend services—not route handlers—
own validation, generation, history derivation, and optimistic writes so FE and CLI
cannot diverge.

## 15. Authorization and mutation rules

- Browser calls use the signed-in AIFit identity.
- CLI calls use short-lived Ez capabilities bound to one principal and job.
- Coach access is a separate delegated capability and never changes record ownership.
- Capabilities enumerate resource/action permissions such as `profile:read`,
  `programs:write`, `workouts:write`, and `history:read`.
- The API derives owner scope from auth; clients cannot supply it.
- Mutations require a `request_id`; mutations against an existing revision also
  require `expected_revision`.
- Workout set logging cannot rewrite exercise structure.
- A swap or agent override rejects any workout with completed set logs.
- Agent overrides are typed segment/slot records with release lineage, reason, and
  agent job ID; they are an intentional exception, not a free-form workout blob.
- Mutation audit stores IDs, revisions, actor/job, and effect—not private model chain of
  thought or duplicated conversation content.

## 16. End-state non-goals

- No legacy sessions, workout-array adapters, target coercion, or migration endpoint.
- No dual writes, read fallback, background workspace synchronization, or second
  workout database.
- No frontend snapshot can write a plan, blueprint, release, or completion projection.
- No same-muscle load transfer, unconstrained workout generation, or random load rise.
- No application-owned prompt store, agent runner, or replacement of Ez sessions.

Every new write uses this schema from day one. Historical data import is a separately
approved customer migration, never a runtime compatibility feature.

## 17. Performance targets

The architecture should make the common path observably faster, not merely use fewer
tokens:

- cached week/workout reads: p95 under 300 ms at the AIFit API boundary;
- default generation and fast swap: p95 under 750 ms excluding network latency;
- varied selection: p95 under 2 seconds, with a bounded timeout and default fallback;
- no native-agent invocation for default generation, fast swap, completion logging,
  history lookup, or load progression;
- history queries use the rebuildable performance index and return only the requested
  bounded window;
- frontend updates optimistically only after request acceptance and reconciles with the
  returned canonical revision;
- agent mini-chat receives identifiers and pulls focused context instead of embedding
  the whole plan, blueprint, workout history, and workspace in every message.

Generation receipts should record timing for release lookup, candidate selection,
history lookup, load decisions, validation, and save. They must not record private
prompt content.

## 18. Required validation scenarios

1. Publish a two-week release with different first- and second-week structures; read
   the exact active release from the authenticated frontend.
2. Generate a default day twice with the same request ID; receive one identical
   canonical workout and no model call.
3. Generate a varied day; prove every selection came from its slot and store a decision
   receipt.
4. Swap an exercise; preserve the segment/slot, avoid duplicates, and use
   no same-muscle fallback.
5. Complete sets, regenerate the next compatible exposure, and prove the load decision
   uses the exact equipment/load identity and explicit policy.
6. Attempt progression from an incompatible machine or per-side/total basis; prove the
   load is not copied.
7. Ask “why this?” in mini-chat; answer from the focused workout and plan without
   creating a mutation.
8. Ask for a novel workout; save an agent override with rationale, job, and release
   lineage, then show it immediately in the authenticated UI.
9. Race a frontend edit and agent edit; the stale writer receives `stale_revision` and
   cannot erase plan/blueprint state or completion logs.
10. Retry every mutation after a simulated timeout; prove there are no duplicate
    releases, workouts, swaps, or set logs.
11. Supersede the active release; historical workouts retain their exact snapshots and
    lineage.
12. Rebuild the performance index solely from canonical workout/set records and obtain
    the same history result.
13. Measure default generation, swap, and varied generation against the stated
    performance targets with realistic account history.

## 19. Implementation status and release gate

Implemented in this repository:

1. Strict Pydantic schemas, revisioned canonical records, receipts, active-release
   pointer, deterministic default materialization, bounded varied selection, exact
   load identity, progression, swaps, and typed agent overrides.
2. Browser `/v1` routes and a capability-protected `/v1/agent` surface backed by the
   same service layer.
3. The standard `plugins/aifit` Ez plugin, which receives only its own scoped
   object from `run.application.context.plugins.aifit`; it never accepts an
   account identifier, capability, or API URL as a command argument or workspace
   file.
4. Schema/capability tests plus a Mongo smoke run covering exercise → plan → blueprint
   → publish → generate → complete → next-load progression.

Before a real tenant release, configure `AIFIT_AGENT_API_BASE_URL` and a strong
`AIFIT_AGENT_CAPABILITY_SECRET` on the AIFit API, inspect and pin the standard AIFit
plugin in the bound Ez registry, and verify the full authenticated flow against that
tenant. The current UI/UX is intentionally unchanged; connecting its existing visual
surface to these endpoints is a separate implementation task. Do not add an
application-owned agent runner, prompt framework, vector memory, generic workflow
engine, second workout store, background workspace synchronizer, or runtime
compatibility layer.
