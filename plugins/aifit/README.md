# AIFit Ez plugin

This is the AIFit domain plugin for Ez: the coach's canonical read and write
surface for the AIFit app. Reads return the same records the frontend renders
(exercises and history, active blueprint, workouts). Writes are deterministic
domain operations (exercises, blueprints, workout generation, set logging,
swaps, and resolved exception days). The user profile is the agent's own
`profile.md` in its workspace, not an app record. It contains no model loop, conversation history,
context builder, workout generator, or workout store.

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
arguments. `ez aifit --help` is available after installation. Ez plugin
containers are isolated from the agent workspace, so the agent streams its
authored artifact through stdin:

```sh
aifit workout show wrk_0123456789abcdef0123456789abcdef
aifit workout list --start 2026-09-21 --end 2026-09-27

cat /absolute/path/blueprint.json | ez aifit blueprint solidify \
  --input - --request-id blueprint-<unique-key>

cat /absolute/path/exception-day.json | ez aifit workout override \
  --input - --request-id override-<unique-key>

cat /absolute/path/swap.json | ez aifit workout swap \
  --input - --request-id swap-<unique-key> --expected-revision REV
```

The full typed artifact schema, rules, and command list live in `SKILL.md`,
which is installed with the plugin and is the agent-facing format contract.
The override input is a complete resolved target-day artifact. Every override
slot contains exactly one resolved candidate. The agent resolves item changes
and copied days from native context; a swap input contains the current
`workout_id`, `exercise_instance_id`, `expected_blueprint_revision`, and a
reason. Logged sets are immutable: swap and override preserve them under their
original exercise snapshots and apply the change to the unlogged remainder. The
frontend consumes the same backend records separately.

## Local verification

This plugin follows AIFit's local testing flow. It is currently a reviewed
local package, not a published npm product; do not publish it merely to test
authentication or packaging.

From this directory, run the offline checks before the Ez smoke:

```sh
pnpm install --frozen-lockfile
pnpm verify
npm pack --ignore-scripts
```

Then inspect the exact source or tarball, install it through the bound Ez
executor, and verify `ez aifit --help` plus one authorized read and one
authorized write with canonical API readback. AIFit's product process merges
the focused local branch to `main` before the VM/production smoke; npm/GitHub
release work is outside this local package process.
