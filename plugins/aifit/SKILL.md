# AIFit structured fitness records

Use `ez aifit` only in a conversation run initiated by AIFit. Ez supplies a
short-lived, account-scoped context to this plugin; do not request, inspect, or
repeat credentials, tenant IDs, owner IDs, capabilities, or backend URLs.

Begin with `ez aifit context`, then read the focused profile, program, workout,
or exercise history before changing it. The API receipts and revisions are
canonical. Reuse a `--request-id` only when retrying the exact same write.

For a normal program, preserve the layers:

1. Draft the strategic Fitness Plan as Markdown.
2. Validate and draft the typed full-generation blueprint JSON.
3. Publish the exact plan and blueprint revisions as a program.
4. Use `workout generate` for the normal deterministic day.
5. Log actual sets; use `workout swap` for an eligible alternative and
   `workout override` only when Juan explicitly requests an exception.

Use `--mode varied` only for a blueprint-bounded alternative. Do not invent
exercises, historical loads, or medical claims. Run `ez aifit --help` for the
complete command and file-input contract.
