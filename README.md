# AIFit

Stage 1 is a clean local development baseline:

- `web/` preserves the existing React/TypeScript frontend;
- `api/` is a new FastAPI/PyMongo application boundary;
- MongoDB uses the fresh `aifit_dev` database by default;
- chat runs through an isolated Ez application profile for each account;
- Telegram is the native channel on that same Ez agent;
- workouts, meals, Health, Coach and onboarding are not implemented yet.

Local secrets and Ez runtime state stay outside this repository under the
operator-selected private directory. Never commit a development auth token,
Ez binding registry, agent workspace or native session state.

## Stage 1 QA

Sign in through the existing AIFit Privy client app. Do not create a second
Privy application. Copy `api/.env.example` and `web/.env.example` to `.env`
files and fill in that client’s `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, and
`PRIVY_CLIENT_ID`. Leave `AIFIT_DEV_AUTH_TOKEN` and `DEV_LOCAL_AUTH_TOKEN`
unset so the development account is created from the signed-in Privy identity.

Allow `http://localhost:5175` on that Privy app if it is not already listed.
With the private local environment configured, run the API on port `8100`, the
copied frontend on port `5175`, and the standard Ez container on port `8793`.
Never start an application-only Ez listener directly on the host. The relay uses
the existing AIFit private state and standard host-executor binding:

```sh
AIFIT_EZ_STATE_DIR=/absolute/private/aifit-dev \
  docker compose -f deploy/compose.local.yml up -d --build --wait
```

Point the API at the matching binding registry and start both servers from their
env files:

```sh
export AIFIT_EZ_STATE_DIR=/absolute/private/aifit-dev

(cd api && EZ_BINDINGS_FILE="$AIFIT_EZ_STATE_DIR/ez-bindings.json" \
  .venv/bin/uvicorn --env-file .env aifit_api.main:app --host 127.0.0.1 --port 8100)

(cd web && pnpm exec webpack serve --config webpack.config.cjs --mode development --host ::1 --port 5175)
```

Open `http://localhost:5175` (not `http://127.0.0.1:5175`), sign in with the
Privy account already used on the previous AIFit client, and confirm the
development account is created from that identity. Then send two related
messages, reload, and confirm both replies remain visible and contextual.

The optional local development auth token exists only as a fallback before
Privy sign-in. It is disabled when unset and must never be used in a deployed
build.

## Telegram connection

Telegram is the channel for the account's existing Ez agent, not an AIFit relay
or a second AIFit agent. An agent starts application-only; on Profile, the
authenticated user creates or selects their own bot in BotFather and supplies
its token once. A private Ez provisioning manager stores that token only in the
agent's relay secret, restarts that one relay, and asks the same Ez application
binding for a short-lived `t.me` link. The user opens the bot and presses
**Start**; Ez verifies the one-time link and persists the Telegram channel on
the existing owner. The AIFit API only forwards the one-time token and projects
state: it never stores a Telegram ID, pairing code, or bot token. The agent
continues to work in Telegram if the frontend is closed.

Each account agent owns its bot. Do not share a bot or a relay between accounts:
that would require tenant routing at the channel boundary and would break the
one-account, one-agent isolation model. Telegram needs no feature flag: it
becomes active when Ez has that agent's private bot token. The Profile tab
intentionally has no disconnect action. Signing out remains the existing AIFit
authentication action and does not alter the user's Ez agent.
