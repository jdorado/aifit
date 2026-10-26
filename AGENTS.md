# AIFit contributor notes

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
