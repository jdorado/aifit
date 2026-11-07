# AIFit contributor notes

## Situation (running hypothesis; keep it current)

- Who: Juan alone, builds and operates; a small set of real users. (inferred, 2026-11-07)
- Stage and scale: live public app, early users; one API container on the shared OVH box. (inferred from DEV_INDEX, 2026-11-07)
- Objective: a workout and health record a coach-linked user keeps using; the Ez agent acts through the plugin. (inferred, 2026-11-07)
- Optimize for: speed of editing and shipping small fixes; no UI redesign bundled with a fix. (owner, Oct 2026)
- Quality anchor: production-correct for current users on one box. (inferred, 2026-11-07)
- Non-negotiables: server-backed records, Privy auth, account and coach-link boundaries. (owner, this file)

`web/` is the removable React interface. `api/` owns authenticated canonical
records and deterministic domain operations; `plugins/aifit/` exposes those
operations to Ez. Preserve account, coach-link, and revision boundaries.

Workout and health records stay server-backed. Do not restore browser workout
snapshots as data or weaken Privy authentication to speed up opening.

The account-free AIFit splash lives in the initial HTML and disappears as soon
as the app is ready, without a minimum display time. Opening a workout should
not load chat history, model lists, or profile-only integrations.

Privy provides Google sign-in only. External wallets are disabled; the matching
webpack exclusions must be reconsidered if wallet support is ever introduced.
