# AIFit agent artifact writes

The native Ez agent already owns the conversation, workspace Markdown, profile,
goals, constraints, research, and workout context. Do not use this plugin to
read or reconstruct any of that context.

For a workout request, stay inside the native Ez context and the exact local
artifact files named by the owner. Do not search sibling repositories, legacy
AIFit applications, installed plugin packages, API source, MongoDB, or local
runtime/control logs to recover a schema, exercise catalog, or prior run. If a
canonical exercise ID and revision are not present in native context, stop and
return structured feedback asking Ez to provide that context; never invent a
revision and never add a read command to this plugin.

Use one of these commands only after the agent has the required native context
and authored the typed artifact:

```sh
cat /absolute/path/blueprint.json | ez aifit blueprint solidify \
  --input - \
  --request-id blueprint-<unique-key> \
  [--blueprint-id ID --expected-revision REV]

cat /absolute/path/exception-day.json | ez aifit workout override \
  --input - \
  --request-id override-<unique-key> \
  [--expected-revision REV]

cat /absolute/path/swap.json | ez aifit workout swap \
  --input - \
  --request-id swap-<unique-key> \
  --expected-revision REV
```

Use stdin (`--input -`) because Ez runs plugin commands in an isolated
container; the native agent reads the artifact from its workspace and streams
it to the command. A mounted file path may be used only when the runtime has
explicitly provided that mount.

Blueprint solidification validates and stores the canonical blueprint
revision. A workout override validates and materializes one complete exceptional
day against the active blueprint's timezone and hard constraints without
changing the blueprint. An item-level request must be resolved by the agent
into the complete target day before calling the command. Likewise, “do
yesterday's workout today” must be resolved by the agent into a complete
target-day artifact; the plugin does not read or copy workout records. Pass
`--expected-revision` only when native context contains the current target
workout revision; it is a workout revision, not the blueprint revision.
Otherwise omit it and let the backend resolve the current unstarted target
atomically.

For an in-blueprint exercise change, use `workout swap`, not `workout override`.
The native mini-chat context supplies only the scoped workout and blueprint
references needed to author the intent. Put `workout_id`,
`exercise_instance_id`, `expected_blueprint_revision`, and a short reason in
the swap JSON. The backend chooses and validates an unused candidate from the
matching blueprint slot, preserves the workout's other items, and records the
blueprint revision in the swap receipt. The agent path always uses JEV
selection; source selection is not a plugin input. If the required workout or
blueprint context is absent, stop with structured feedback; never invent a
candidate or turn an ordinary swap into an exception day.

The backend's `default` and `jev` generation paths consume the blueprint, and
the frontend reads both generated and exceptional workout records directly.
The agent does not generate, fetch, log, or list workouts through this plugin.

The blueprint input contains only the documented blueprint object. The swap
input contains only `workout_id`, `exercise_instance_id`,
`expected_blueprint_revision`, and `reason`. The override input contains only
`date`, `title`, `reason_md`, and the complete typed `segments` object. Every
override slot must contain exactly one resolved candidate; the backend will not
silently choose one. Never include credentials, owner or tenant identifiers,
API URLs, capabilities, prompts, request IDs, or conversation transcripts.
Reuse a request ID only when retrying the exact same payload after an uncertain
result.
