# Coaching progression

The coach chooses the training path and publishes its parameters in the existing
blueprint. The API calculates evidence from canonical workouts; the web app shows
the result and previews a selected weight against today's prescription. Coaching
judgment stays in the tenant's native Ez agent.

The tenant template and installed AIFit skill describe a Galpin-inspired,
individualized coaching approach. Existing personal workspace files are not
rewritten. The plugin skill documents the complete progression schema and
`aifit workout progression WORKOUT_ID` read command.

## Workout experience

- The exercise shows the goal, qualifying-session rule, current evidence and next
  earned weight. Selected-weight feedback sits next to the active set controls.
- Effort is recorded as RPE on each work set. It can be corrected with the existing
  logged-set editor. Effort is never inherited into the next set.
- Training history has a Muscle progress tab: improving/comparable exercise
  setups and separate direct and indirect weekly work. These are performance and
  workload observations, not a muscle-growth or population score.
- Review with coach opens an editable prompt in the existing exercise chat.

## Evidence rules

Both generation and the progression endpoint use the same calculator. A complete
exposure must contain the prescribed number of completed work sets, with compatible
equipment, load basis, rest and tempo. Missing RPE cannot qualify for an increase.
Skipped, removed, partially swapped and partially overridden work cannot earn a
full-session increase. Logged records remain intact when the plan changes.

Trends use 28 days; readiness can read 84 days. Higher load with fewer reps is an
unresolved tradeoff. Increased assistance is not treated as increased strength.
Legacy records without execution context remain visible but unconfirmed. Weekly
set totals cover generated workouts, not every blueprint candidate. Future
performance never informs an earlier workout.

Maintenance and deload preserve the agent's prescribed target. Review dates,
exposure counts and possible plateaus expose evidence for the coach; they do not
automatically rewrite a plan. Age comparisons remain unavailable without a
supported reference test. Newly generated workouts snapshot the policy; existing
workouts are not silently backfilled or rewritten.

## Local verification

API progression tests cover completeness, effort, setup identity, load ceilings,
future records, assistance, review triggers and tenant isolation. Frontend smoke
checks exercise actual RPE persistence, effort edits, missing effort and weight
previews, alongside existing workout interaction checks.

The installed plugin was exercised through the local Ez coach against an isolated
Mongo database: an incomplete 40 kg session stayed unconfirmed; completing its
third set at 12 reps / RPE 8 earned 42 kg after two qualifying sessions. Canonical
readback confirmed 42 kg on all three sets of the next generated workout and no
changes to previously logged sets. The actual workout components were inspected
with synthetic fixtures for weight feedback, RPE entry and muscle history.

This is a local change. Promotion needs the API, web app and updated plugin skill
together. Existing tenants receive package guidance through the plugin manager;
their personal plans and workspace guidance stay agent-owned.
