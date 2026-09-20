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
