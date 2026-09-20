# AIFit agent artifact writes

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
- `workout override` takes one resolved day: `date`, `title`, `reason_md`, and `segments`. Each slot has exactly one candidate.
- `workout swap` takes `workout_id`, `exercise_instance_id`, `expected_blueprint_revision`, and `reason`. `--expected-revision` is the current workout revision.

Do not put credentials, owner or tenant identifiers, API URLs, or capabilities in the artifact.
