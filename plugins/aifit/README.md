# AIFit Ez plugin

This is the AIFit domain plugin for Ez. It is a deterministic client for the
AIFit API; it contains no model loop, conversation history, or workout store.

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
arguments. `ez aifit --help` is available after installation. A real mutation
requires the AIFit API to issue that scoped context and to be reachable from the
plugin container.
