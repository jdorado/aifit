# AIFit agent artifact writes

Stay inside the native Ez context and the exact local artifact files named by
the owner. Do not search sibling repositories, legacy AIFit applications,
installed plugin packages, API source, MongoDB, or runtime logs to recover a
schema, exercise catalog, or prior run.

You author exercise IDs and revisions freely: the API needs no prior catalog
row and synthesizes display metadata from the ID. The only thing you must
never invent is someone else's record — workout IDs, revisions, and
blueprint revisions always come from native context. Reuse a request ID only
when retrying the exact same payload after an uncertain result.

Three writes. Author the typed JSON and stream it:

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

Use stdin (`--input -`) because Ez runs the plugin in an isolated container.

- `blueprint solidify` takes a complete `BlueprintInput`. Omit `--blueprint-id` and `--expected-revision` when creating; pass them when revising.
- `workout override` takes one resolved day: `date`, `title`, `reason_md`, and `segments`. Each slot has exactly one candidate. Resolve item-level requests ("swap this one exercise", "do yesterday's workout today") into the complete target day first; the plugin does not read or copy workout records. Pass `--expected-revision` only when native context holds the current target workout revision, otherwise omit it and let the backend resolve the unstarted target atomically.
- `workout swap` takes `workout_id`, `exercise_instance_id`, `expected_blueprint_revision`, and `reason`. `--expected-revision` is the current workout revision. Use swap (not override) for in-blueprint changes; the agent path always uses JEV selection. If the required workout or blueprint context is absent, stop with structured feedback; never invent a candidate or turn a swap into an exception day.

Do not put credentials, owner or tenant identifiers, API URLs, or capabilities in the artifact. Reuse a request ID only when retrying the exact same payload after an uncertain result.
