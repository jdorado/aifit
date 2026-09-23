# Contributing to AIFit

AIFit is an open-source fitness product: a React/TypeScript web surface, a
minimal canonical API, and a narrow Ez plugin boundary. See
[`README.md`](README.md) for the architecture and local setup.

## Setup

Install MongoDB, Python 3.11+, `uv`, Node.js, and `pnpm`. Keep a private
configuration directory outside the checkout (see `README.md`), and never
commit `api/.env`, `web/.env`, a binding registry, token file, workspace,
native session, or bot token.

## Checks

Run these before asking for review:

```sh
api/.venv/bin/pytest
pnpm --dir web build
pnpm --dir plugins/aifit verify
```

The API tests cover identity, tenant isolation, agent capabilities, and the
typed workout contract. The frontend build runs the timeline and PWA contract
checks, `tsc`, and the production bundle. The plugin check runs its node
tests plus the release metadata check.

## Workflow

- Work on a short task branch; verify focused tests and real behavior.
- Merge to `main` when green (no PR flow while the product is pre-release).
- Leave the tree clean and buildable: no uncommitted, untracked, or stashed
  changes, and no leftover branches or worktrees.

## Boundaries

- The API owns authentication, canonical records, and deterministic domain
  functions. It contains no LLM, prompt builder, conversation store, or
  workspace reader.
- The web consumes the API and never invokes the plugin directly.
- The plugin is the only agent execution surface for its purpose.
- The user profile is the agent's own workspace `profile.md`, not an app
  record.

## Releases

Versions are `X.Y.Z-beta.N`. QA candidates (`X.Y.Z-beta.N.rc.M`) are built
from an exact commit and stay local until the beta passes.

## License

Contributions are licensed under the MIT License; see [`LICENSE`](LICENSE).
