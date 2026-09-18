# AIFit native tool

Use `aifit` only from an AIFit-originated Ez run. Its capability is scoped to the
current authenticated account and expires with that run.

- Read the focused record before changing it.
- Use the same `--request-id` when retrying the same mutation.
- Edit ordinary workspace Markdown as needed, but publish only an explicit Profile,
  Fitness Plan, blueprint, or workout through this tool.
- Use `workout override` only for an explicitly requested exception. It is typed,
  versioned, and cannot replace a workout that has completed sets.
- Never place a capability, owner ID, tenant ID, or application URL in a workspace
  file, command argument, or reply.
- A receipt confirms the canonical write; read the returned revision before a later
  dependent change.
