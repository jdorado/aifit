# AIFit Ez plugin

This is the minimal AIFit domain plugin for Ez. It exposes three deterministic
writes: solidifying the agent-authored flexible workout blueprint, swapping a
workout exercise within that blueprint, and publishing one resolved exceptional
workout day in the AIFit API. It contains
no model loop, conversation history, context reader, workout generator, or
workout store.

Install the reviewed local package through the bound tenant launcher:

```sh
ez plugins inspect aifit --source /absolute/aifit/plugins/aifit
ez plugins catalog-add aifit --source /absolute/aifit/plugins/aifit --revision sha256:...
ez plugins install aifit
ez plugins start aifit
```

The plugin runs only from an AIFit application turn. Ez passes its own
`run.application.context.plugins.aifit` object to the one-shot command
container; the CLI never accepts account identity, capability, or API URL as
arguments. `ez aifit --help` is available after installation. The three commands
are `ez aifit blueprint solidify`, `ez aifit workout swap`, and
`ez aifit workout override`; a real mutation requires the AIFit API to issue
that scoped context and to be reachable from the plugin container. Ez plugin
containers are isolated from the agent workspace, so the agent streams its
authored artifact through stdin:

```sh
cat /absolute/path/blueprint.json | ez aifit blueprint solidify \
 --input - --request-id blueprint-<unique-key>

cat /absolute/path/exception-day.json | ez aifit workout override \
  --input - --request-id override-<unique-key>

cat /absolute/path/swap.json | ez aifit workout swap \
  --input - --request-id swap-<unique-key> --expected-revision REV
```

The override input is a complete resolved target-day artifact. Every override
slot contains exactly one resolved candidate. The agent resolves item changes
and copied days from its native context; a swap input contains the current
`workout_id`, `exercise_instance_id`, `expected_blueprint_revision`, and a
reason. The agent path always uses JEV selection. The plugin does not read or
copy workout records. The frontend consumes the backend records separately.
