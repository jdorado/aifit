# AIFit minimum QA stories

When asked to QA AIFit, run these stories through the authenticated Ez/AIFit
path. Do not invent a larger test plan. Report each story as PASS or FAIL with
the artifact, revision/receipt, and canonical readback that proves it.

## Setup

- Use an isolated test tenant and the current tenant `AGENTS.md`.
- Use the real native agent and protected AIFit commands; mocks only test code
  contracts, not these stories.
- Read the saved artifact and API result after every write.

## Stories

### PLAN-01 — Create the user's master plan

As a 42-year-old male user, I ask the agent to create my fitness plan.

Pass when the agent writes a usable plan (workspace Markdown and/or a published
blueprint) rather than only chat text.

### BLUEPRINT-01 — Publish a three-week blueprint

I ask the agent to publish a three-week plan.

Pass when `ez aifit blueprint solidify` returns a receipt and the active
blueprint contains the period, days, segments, slots, loads/times, and
typed candidates. Read back the active
revision.

### DAY-01 — Generate a day

Given an active blueprint, generate one date using `default` and `jev`.

Pass when each result selects only from its blueprint slot, records the source
(`default` or `jev`), and is idempotent for the same date and request ID.

### ACTION-01 — Apply an atomic day change

Ask to swap one slot, replace today's whole workout, reuse yesterday's workout,
or make next week lighter.

Pass when the agent chooses the smallest valid action: `workout swap` for one
in-blueprint slot, or a complete `workout override` for a new day/week. The
receipt and canonical readback show the requested change without silently
changing the published blueprint.

### LOG-01 — Log a set

I finish a set and mark it logged with my actual reps and load.

Pass when the set carries its actual values and the workout reads back as
`in_progress`, or `completed` when every set has actuals. The receipt effect
is `set_logged` with the new workout revision. Set logging is a UI action;
the agent reads the canonical record, it has no log command.

### LOAD-01 — Change the weights

I ask for heavier (or lighter) weights than prescribed.

Pass when the agent first reads the canonical record including any logged
actuals, then applies the change to unstarted work only: a new complete day
through `workout override` when the request means different loads, or correct
`actuals` on the logged sets when I lifted differently than prescribed. The
receipt and readback show the new loads without silently changing the
published blueprint.

### SWAP-01 — Swap one exercise

I ask to swap one exercise, e.g. the machine is taken.

Pass when the agent uses `workout swap` for that one in-blueprint slot. The
receipt effect is `swapped` and the readback shows the replacement chosen
from the same blueprint slot, every other item unchanged, and the published
blueprint revision unchanged.

### ADD-01 — Add a different exercise

I ask to add a different exercise that is not in the plan.

Pass when the agent resolves my request into one complete target day and
sends it through `workout override`. The receipt effect is `agent_override`
and the readback shows the added exercise in the day without changing the
published blueprint.

### LOCK-01 — Switch an exercise after logging started

I ask to switch an exercise after I already logged one of its sets.

Pass when nothing is silently replaced: the swap path rejects a logged
exercise (`completed_exercise_locked`) and the override path rejects a day
with logged sets (`completed_workout_locked`), so the agent explains in
coach language that the logged work is locked and offers a valid action
instead — swapping a different unlogged exercise, or adjusting a future
unstarted day. No mutation receipt exists for the locked target.
