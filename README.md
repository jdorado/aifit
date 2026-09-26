# AIFit

AIFit is an open-source fitness product with a removable web interface, a
minimal canonical API, and a narrow Ez plugin boundary.

- `web/` is the React/TypeScript interaction surface;
- `api/` owns authentication, canonical records, and deterministic domain
  operations;
- `plugins/aifit/` exposes the canonical reads and deterministic domain writes used by Ez;
- `docs/tenant/AGENTS.md` is the tenant-runtime context template.

Ez owns native context, memory, sessions, reasoning, and execution. The
frontend consumes the API and never invokes the plugin directly. Deployment
provisioning, binding registries, credentials, and runtime state are
intentionally outside this repository.

For the public tenant contract, see [`docs/new_tenant.md`](docs/new_tenant.md).

## Local development

Install MongoDB, Python 3.11+, `uv`, Node.js, and `pnpm`. Create a separate
private configuration directory and copy the example files into it:

```sh
export AIFIT_CONFIG_DIR=/path/outside/this/repository/aifit
mkdir -p "$AIFIT_CONFIG_DIR"
cp api/.env.example "$AIFIT_CONFIG_DIR/api.env"
cp web/.env.example "$AIFIT_CONFIG_DIR/web.env"
chmod 700 "$AIFIT_CONFIG_DIR"
chmod 600 "$AIFIT_CONFIG_DIR/api.env" "$AIFIT_CONFIG_DIR/web.env"
```

Use your own Privy application credentials and your own Ez deployment
configuration. Never create `api/.env` or `web/.env` in the checkout, and never
commit a binding registry, token file, workspace, native session, or bot token.

Telegram pairing is persisted by Ez. When local web chat uses a separate Ez
deployment, set `EZ_TELEGRAM_BINDINGS_FILE` to a private binding registry for
the existing Telegram deployment (through a loopback tunnel if remote).
Telegram status, linking, and bot setup then use that same deployment in both
environments. Without the override they use `EZ_BINDINGS_FILE`. A stopped
poller or unavailable relay does not mean the saved pairing was removed.

Run the API and frontend with the external environment files:

```sh
(cd api && uv run uvicorn --env-file "$AIFIT_CONFIG_DIR/api.env" \
  aifit_api.main:app --host 0.0.0.0 --port 8100)

(cd web && AIFIT_WEB_ENV_FILE="$AIFIT_CONFIG_DIR/web.env" pnpm dev)
```

Chat and agent-authored workout writes require an Ez deployment and server-side
binding that you operate separately. This repository does not contain a
provider-specific provisioning command or deployment manifest for that service.
The web release reads canonical workout records and can request typed day
generation. Exercise history and YouTube demo videos have typed public
contracts (`GET /v1/exercises/{exercise_id}/history`, `GET /v1/videos`). Coach
sharing has a typed public contract too: `POST/GET/PATCH /v1/coach-links` plus
the `act_as_link_id` parameter on the canonical `/v1` routes, re-checked on
every request. Coach chat and `GET/POST /chat/models` also carry this link:
the trainee binding runs a separate native scope per coach link and chat
surface, leaving the trainee's own conversation and model unchanged. Every
trainee needs its own verified binding in the API deployment serving the app,
including local development. Arbitrary plan rewrites stay disabled until their own typed
public contract exists.

Before authoring a blueprint or override, the coach can page the existing exercise
catalog with `aifit exercise list` and reuse its IDs and revisions. Common names
belong on exercise definitions; setup and tempo cues belong in instructions and
prescriptions. Reusing an ID keeps history and progression together even when
the plan uses another wording for the same exercise.

## Testing

```sh
api/.venv/bin/pytest
pnpm --dir web build
```

The API tests cover identity, tenant isolation, agent capabilities, and the
typed workout contract. The frontend build runs the critical timeline and PWA
contract checks before compiling the production bundle.

The workout list's **Add exercise** picker reads the active blueprint across all
days through `GET /v1/workouts/{workout_id}/exercise-repertoire`. Selecting an
exercise calls `POST /v1/workouts/{workout_id}/exercises` and appends a standalone
exercise with the published sets and targets. It requires an existing workout,
preserves logged sets, and uses revision checks and idempotent receipts. This
browser flow does not run the coach or modify the blueprint.

The speaker icon beside exercise history and chat requests a short form guide through its
existing coach chat, using the exercise, profile, and plan context available to
the agent. It asks for setup, useful cues, and mistakes to avoid, with adjustments
only for documented limitations. The completed reply plays as audio in the
exercise detail. Text remains in
**Ask coach**. Ez owns synthesis and its Gemini credential; the API only relays
authenticated audio. This needs Ez's `POST /v1/runs/{id}/speech` endpoint and a
configured `GEMINI_API_KEY`. Playback can be paused and replayed without another
generation while the exercise remains open. Browsers that block autoplay show
the native Play control. Changing exercise stops playback. Ez selects the
configured English or Spanish voice from the selected app language, which is
saved for signed-in accounts. In coach view, the audio request reads the
trainee's saved language when available.

## License

This project is licensed under the MIT License; see [`LICENSE`](LICENSE).
