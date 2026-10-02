# Coaching progression

The coach chooses the training path and publishes parameters in the blueprint.
The API calculates observations from canonical workouts. Coaching judgment stays
in the tenant's native Ez agent, guided by the installed AIFit skill; personal
workspace files are not rewritten by the app.

## Workout experience

The active set has a compact traffic-light indicator: green for improving or
ready to increase, amber for steady/building, red for lower performance or feedback
needing attention. Text and arrows accompany color. Tap it for the next step,
comparison and “Ask why” in the existing coach chat. Users log weight and reps;
there is no effort questionnaire. A partly logged workout can say “Improving so
far”, comparing the same set positions last time without declaring a whole-session PR.

Training history's Muscle progress tab counts improving exercises and separates
direct and indirect weekly sets. These are observed performance and workload,
not a muscle-growth or population score. Unavailable age comparisons are hidden.

## Evidence rules

Generation and the progression endpoint share the calculator. The same exercise,
load basis, laterality and equipment profile match; missing profile IDs can match
other missing IDs on that exercise. Legacy records without execution context are
usable. Explicit differences in rest, tempo or equipment separate comparisons.

A full-session increase requires every prescribed work set to reach the coach's
rep threshold for the required consecutive sessions. Missing RPE never blocks it;
an optional effort limit only checks recorded effort. Skipped, removed, partially
swapped and partially overridden work cannot earn an increase. Completed actuals
establish the working load; partial work does not raise it or reset an established
load to an older blueprint starting weight. For example, 125 kg × 10/12/12 holds
125; 125 kg × 12/12/12 can earn 130 with a 5 kg, one-session policy.

Trends use 28 days; readiness can read 84 days. More weight with fewer reps is a
mixed result. Assistance is not strength gain. Future performance never informs
an earlier workout. Weekly totals cover materialized workouts.

Maintenance and deload preserve the coach's explicit prescription. Review dates,
exposure counts and possible plateaus expose evidence for the coach. The agent
combines history and volunteered feedback to judge fatigue and revise the path;
it never writes inferred RPE as fact. `workout set-target` corrects an existing
unlogged target through the existing revision-guarded operation; lasting policy
changes belong in the blueprint. Logged sets remain intact.

## Focused QA

Run `api/tests/test_progression.py` and the plugin context contract; these cover
legacy 125 kg carry-forward without RPE, partial set comparisons, the 130 kg step,
explicit deloads, setup identity, ceilings, future records and tenant isolation.
The existing set-target tests protect revision checks and logged-set preservation.
Type-check the web app and inspect the actual workout components at phone width.

Through the installed local plugin and native Ez agent, use an isolated database
to read progression, correct an unlogged target, complete work without RPE, and
generate the next day. Read back canonical targets and ensure previous actuals
are unchanged. Do not create synthetic records in the shared live database.

For manual QA in `pnpm dev`: open Leg Press, check the compact indicator and last
125 kg performance, tap for the next step, then log only weight/reps. Verify the
indicator refreshes after saving and remains correct after reload. Check Training
history → Muscle progress for the same exercise trend.

Promotion needs the API, web app and updated plugin together. Local QA is not a
production deployment.
