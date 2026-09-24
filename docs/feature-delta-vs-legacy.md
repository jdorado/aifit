# Feature delta vs `previous_version/aifit_app`

Read-only inventory of the legacy app's user-facing actions compared with
`aifit/web`. `previous_version/` is migration reference only; nothing here is
deleted, and `aifit/` stays the implementation target. Each item is classified
so the repo can be groomed for open source without silently dropping behavior.

## Parity restored (2026-09-23)

The workout editing gap is closed on the canonical API:

- `POST /v1/workouts/{id}/exercises/{instance}/sets` — add set
- `POST /v1/workouts/{id}/sets/{set_id}/remove` — remove an unlogged set
- `PATCH /v1/workouts/{id}/sets/{set_id}/target` — edit a target, optionally
  propagating to remaining unlogged sets
- `POST /v1/workouts/{id}/exercises/{instance}/remove` — remove an exercise
- `POST /v1/workouts/{id}/segments/{segment_id}/remove` — remove a circuit or
  section

The browser exposes add set, remove set, target edit (commit on blur, legacy
propagation), and trash actions with confirmation on exercise, circuit and
section rows, all gated by edit-program permission and the editable-date rule.
Logged sets stay immutable in every path. Covered by `api/tests/test_workout_plan_edits.py`,
`web/scripts/plan_edit_contract.cjs` (wired into the web build) and a real
browser click-through against the local API and Mongo.

Also restored: the legacy workout quick prompts (last time, progress/deload,
rest time, adjust sets/reps, what next) now answered by the mini-chat agent,
and the copy-last-week confirmation when the day already has a plan.

Still open from this inventory:

- Video gallery exact-match/suggestion states (the current gallery has list,
  retry and empty/error states; legacy suggested alternatives when no exact
  match existed).
- History "estimated values" note: the new history read carries no confidence
  or `value_source` field, so this needs an API field before the app can show
  it.
- Account deletion (`clear account`) and meals/health stay as product
  decisions; meals/health remain documented placeholders.

## Classification

- **PORT NOW** — no new backend contract; small UI/chat wiring on top of reads
  that already exist.
- **PORT WITH API** — the legacy action changed canonical workout state (plan
  targets, set shape). The new API owns that surface, so porting needs a typed
  endpoint or an agent-authored artifact first.
- **TO BE DONE** — product surface intentionally absent in this version; keep
  the gap explicit (same status as meals) instead of re-adding a local layer.
- **DROP** — deliberately retired by the new architecture or the workout
  timeline contract; do not recreate.

Method: static inventory of legacy handlers (`App.tsx`), component props
(`WorkoutView`, `ExerciseSetList`, `WorkoutPlanList`, `VideoGallery`), i18n keys
and view/component trees, diffed against `aifit/web`. No legacy files changed.

## Workout day

| Legacy action | New status | Class |
| --- | --- | --- |
| Add set (`addNewSet`, `workout.addSet`) | Missing. Legacy pushed a target set and persisted the day. | PORT WITH API |
| Delete/remove set (`workout.deleteSet`, `workout.removeSet`) | Missing. New has skip + undo (actuals only). | PORT WITH API |
| Edit target and propagate to remaining sets (`onUpdateSetField(..., propagate)`) | New edits a single set's actual only. | PORT WITH API |
| Remove exercise / extra / circuit / section, with confirm | Missing. The new day is canonical backend data; removal is an override/swap/clear decision. | PORT WITH API (or agent override) |
| Swipe-to-delete rows (`WorkoutPlanList` gesture) | Missing with the removals above. | PORT WITH API |
| `NotesBlock` day-notes block | New `PlanNotes` covers day notes. | DROP (superseded) |
| Explicit finish/save session (`finishSave`, `saveWorkoutTitle`, save success/failed/offline) | New logs every set canonically per set. No session-save step. | DROP (superseded) |
| Whole-day Jev variation (`workout.varyAction`, `handleVaryDayWorkout`) | Removed by the timeline contract. | DROP |
| Copy/paste workout text (`copyWorkoutAction`, `pasteAction`) | Removed by the timeline contract. | DROP |
| Morning/night/post stage labels (`workout.stageMorning/Night/Post`) | New renders agent-authored segment titles. | DROP (superseded) |
| Clear unlogged / clear day (`workout.clearAction`) | New overflow menu has clear day. | Covered |
| Generate / generate with coach / copy last week / refresh | New overflow menu has all four. | Covered |
| Rest overlay + vibration | New `RestOverlay` + `MiniTimer` exist; legacy completion copy (`messages.restComplete*`) has no equivalent string. | PORT NOW (copy) |

## Set and exercise detail

| Legacy action | New status | Class |
| --- | --- | --- |
| Quick prompts: last time, progress/deload, rest time, next exercise, adjust volume, swap similar (`workout.prompt*`) | New CoachChat has only the swap prompt. | PORT NOW |
| Fast weight suggestion (`handleSuggestWeight` → `/exercise-decisions/suggest-weight`) | Missing; legacy endpoint retired. | PORT WITH API |
| Quick decision buttons (`handleQuickExerciseDecision` → `/exercise-decisions/quick`, `handleApplyQuickAction`) | Missing; legacy endpoint retired. | PORT WITH API |
| Exercise history sheet | New sheet + related-history tabs exist. | Covered (gained) |
| History "estimated values" note (`workout.historyEstimatedNote`) | Missing string/copy. | PORT NOW |
| Muscle-group history (`workout.muscleHistory`, `noExactMatch`, `noOtherExercises`) | New related-history covers part of this. | PORT NOW |
| Video gallery, search and offline states (`workout.videosTitle`, `videosOffline`, `videoExactMatch`) | New gallery fetches typed videos; verify offline/empty copy. | PORT NOW |
| Skip set / undo set | New-only; legacy had delete set instead. | Covered (gained) |
| Exercise feedback presets (easy/hard/form/pain) | New `ExerciseFeedback` with presets exists. | Covered |

## Chat

| Legacy action | New status | Class |
| --- | --- | --- |
| Chat landing hero, kicker, open-workout (`chat.hero*`, `chat.openWorkout`) | Missing. | PORT NOW |
| Suggested prompts: today, week, adjust, recover (`chat.quick*`) | Missing; new has workout quick prompts only. | PORT NOW |
| Model power label (`chat.modelPowerLabel`) | New shows model labels per message. | DROP (superseded) |
| Offline message (`messages.offline`, `messages.coachOffline`) | New has backend-health state without the user-facing copy. | PORT NOW |
| Agent plan-update notices (`messages.planUpdated`, `planRestored`, `morningUpdated*`) | Missing; new has no plan-patch flow. | TO BE DONE (needs agent-update signal) |

## Profile and account

| Legacy action | New status | Class |
| --- | --- | --- |
| Free-text details, weekly plan, active notes (`profile.details*`, `weeklyPlan*`, `activeNotes*`) | Retired: the profile is the agent's workspace `profile.md`, not an app record. Edit through chat. | DROP (by architecture) |
| Language, font scale | New profile has both. | Covered |
| Clear account / local data (`profile.clearAccount*`) | Missing. Account deletion is a real open-source requirement. | TO BE DONE (needs decision) |
| Telegram link | New profile has it. | Covered |
| Coach dashboard, tokens, trainee select, diet/health permissions (`coach.*`) | Replaced by coach sharing links (invite, accept, permissions, act-as). | DROP (superseded) |
| Coach links (invite/accept/revoke/view-as) | New-only rewrite. | Covered (gained) |

## Health and meals

| Legacy surface | New status | Class |
| --- | --- | --- |
| `HealthTimelineView`, health tab (`kind: diet \| health`) | Missing; tab removed. | TO BE DONE |
| Meal capture + AI analysis, nutrients, suggestions, favorites (`components/meals/*`) | Missing. Legacy used retired API routes. | TO BE DONE |
| `HealthReport` (`components/health/*`) | Missing. | TO BE DONE |

Keep these visible as explicit placeholders rather than rebuilding local logic;
when ported they need canonical API contracts and the app/agent split above.

## Known defects found while building this inventory

1. **Fixed:** empty/future days rendered phantom completed cards.
   An agent override keeps logged history next to the replacement plan, so two
   segments can share one title. The title-based React key collided, React left
   the previous day's circuit rows mounted, and every later day (including
   future rest days) showed them, sometimes next to the empty-state card.
   Fixed by keying circuit rows by segment identity; covered by
   `web/scripts/workout_circuit_keys_smoke.cjs` (wired into `web` build).
2. **Fixed:** the plan-edit restore rendered always-visible trash buttons on
   every plan row; the legacy app hides delete behind a swipe. Restored the
   swipe pattern (row reveal, confirm, tap-elsewhere closes) and removed the
   always-visible buttons.
3. **Fixed:** a typed rep/weight in the next-set hero did not carry to the
   remaining unlogged sets, so the following set fell back to the suggested
   target. Restored both halves of the legacy behavior: hero typing propagates
   to remaining unlogged sets (editing a logged set stays local), and the
   canonical read carries the last logged actual into the following unlogged
   sets, so reopening a workout shows the logged value instead of the plan
   target. Covered by `web/scripts/workout_set_inherit_smoke.cjs`.
4. **Open (owner: API/agent artifact):** an override on a partially logged day
   emits two segments with the same title — the preserved logged history and
   the new plan — so the UI shows the same circuit twice, one `Done`, one open.
   Preservation is intended; the duplicate title is not distinguishable to the
   user. Options: mark preserved segments (for example a `preserved` flag) and
   group them as history in the app, or have the override artifact reuse the
   original segment identity for the replacement. Product decision pending.

## Open-source grooming checklist

- [x] Restore the set-shape writes (add/delete set, target propagation, plan
      removal) on the canonical API and the browser.
- [ ] Decide account deletion (`clear account`) before publishing.
- [ ] Keep meals/health as documented `TO BE DONE` placeholders.
- [ ] Remove or archive the legacy `feat/legacy-parity-1-5` and
      `codex/prod-setup` branches before the public release.
