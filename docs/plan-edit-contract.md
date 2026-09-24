# Plan-edit contract (browser API)

Canonical workout edits the browser may perform on the unlogged remainder of a
day. Logged sets are immutable history: every mutation below either refuses a
logged target with `409 set_is_logged` or preserves logged sets and changes
only unlogged ones. The engine's surfaces (swap, override, generation) are
unchanged; these routes are the app's own edit surface, the same shape as
`clear` and `unlog`.

## Shared rules

- All routes require the edit account and take `expected_revision` plus
  `request_id`.
- Replays with the same `request_id` and payload return the original receipt
  (idempotent), matching `log_set` / `unlog_set` / `clear_workout`.
- A stale `expected_revision` returns `409 stale_revision`.
- Responses are the standard receipt
  `{ resource: "workout", resource_id, revision, effect, workout }`, with
  `workout` as the public document. A mutation that removes the last unlogged
  set everywhere follows `clear_workout`: the workout record is deleted and the
  receipt carries `workout: null`.
- After any mutation, `status` is recomputed with the existing rule: all sets
  logged → `completed`, some → `in_progress`, none → `planned`.
- Segment and item `order` stay canonical (1-based, contiguous) after removals.
- Extras do not exist in canonical workouts; there is no extra route.

## 1. Add a set

`POST /v1/workouts/{workout_id}/exercises/{exercise_instance_id}/sets`

Body `SetAddInput`:

```json
{ "expected_revision": "rev_…", "request_id": "…" }
```

- Appends one unlogged set to the instance.
- `target` and `kind` are copied from the instance's last non-warmup set
  (fallback: its last set); `round` is that set's round plus one when present.
- `effect`: `set_added`.
- `404` when the workout or instance does not exist.

## 2. Remove a set

`POST /v1/workouts/{workout_id}/sets/{set_id}/remove`

Body `SetRemoveInput`:

```json
{ "expected_revision": "rev_…", "request_id": "…" }
```

- Removes one set from its instance.
- `409 set_is_logged` when the set has an `actual` (unlog first).
- The instance stays in place when its last set is removed; the app renders an
  instance with no sets as skipped.
- `effect`: `set_removed`.

## 3. Edit a target

`PATCH /v1/workouts/{workout_id}/sets/{set_id}/target`

Body `SetTargetInput`:

```json
{
  "target": { "reps": { "min": 8, "max": 10 }, "load": { "value": 40, "unit": "kg" } },
  "apply_to_remaining": true,
  "expected_revision": "rev_…",
  "request_id": "…"
}
```

- `target` is a full replacement and uses the existing `Target` model (exactly
  one of `reps` or `duration_seconds`, optional `load`, optional `rpe`).
- `409 set_is_logged` when the set has an `actual`.
- With `apply_to_remaining: true`, the same target replaces the target of every
  later set in the same instance that is not logged. Earlier or logged sets are
  untouched.
- `effect`: `set_target_updated`.

## 4. Remove an exercise

`POST /v1/workouts/{workout_id}/exercises/{exercise_instance_id}/remove`

Body `PlanEntryRemoveInput`:

```json
{ "expected_revision": "rev_…", "request_id": "…" }
```

- Drops the instance's unlogged sets and keeps logged sets verbatim under their
  original snapshot, exactly like `clear_workout` does for a day.
- An instance with no remaining sets is removed from its segment; a segment
  with no remaining items is removed; remaining orders are renumbered.
- `effect`: `exercise_removed`.

## 5. Remove a segment

`POST /v1/workouts/{workout_id}/segments/{segment_id}/remove`

Body `PlanEntryRemoveInput` (same shape as above).

- Applies the exercise rule to every item in the segment.
- `effect`: `segment_removed`.

## 6. Reorder segments

`POST /v1/workouts/{workout_id}/segments/reorder`

Body `PlanReorderInput`:

```json
{ "segment_ids": ["seg_cooldown", "seg_main", "seg_warmup"], "expected_revision": "rev_…", "request_id": "…" }
```

- `segment_ids` is the complete new order: every segment of the day exactly
  once. A missing, duplicated or unknown id returns `422 reorder_mismatch`.
- Segments move as whole blocks; items and every set (logged or not) stay
  verbatim under their original snapshot.
- `effect`: `segments_reordered`.

## 7. Move an item

`POST /v1/workouts/{workout_id}/exercises/{exercise_instance_id}/move`

Body `PlanItemMoveInput`:

```json
{ "target_segment_id": "seg_main", "target_index": 2, "expected_revision": "rev_…", "request_id": "…" }
```

- Moves one item within its segment or to another segment of the same day.
- `target_index` is the 1-based position the item takes in the target segment
  after the source removal, so a same-segment move never counts the item twice.
  An index outside `1..items+1` returns `422 target_index_out_of_range`.
- Every set stays verbatim; only item order and segment membership change. A
  source segment left with no items is removed and remaining orders are
  renumbered. `404 exercise_instance_not_found` / `404 segment_not_found` when
  either id is unknown.
- `effect`: `item_moved`.

## Browser consumption

Dragging an exercise into the gap between segments uses
`POST /v1/workouts/{workout_id}/exercises/{exercise_instance_id}/extract` with
`before_segment_id` (or `null` for the end), `expected_revision`, and
`request_id`. It creates a standalone `straight_sets` segment titled with the
exercise name, keeps the item's sets verbatim, and leaves adjacent circuit and
recovery segments intact. The receipt effect is `item_extracted`.

After a successful mutation the app applies the returned workout with the same
path it already uses for swap and clear:

```ts
const receipt = await response.json() as BackendWorkoutReceipt
if (receipt.workout) {
  applySavedWorkoutSessionToWeek(backendWorkoutToSession(receipt.workout, currentUserId))
  await refreshVisibleWorkoutSessions()
}
```

`workout: null` means the day is gone; the app shows the cleared/empty day the
same way `clear` does.

## Parity mapping

| Legacy action | Route |
| --- | --- |
| Add set | `POST …/exercises/{id}/sets` |
| Remove unlogged set | `POST …/sets/{set_id}/remove` |
| Edit target, propagate to remaining sets | `PATCH …/sets/{set_id}/target` |
| Remove exercise | `POST …/exercises/{id}/remove` |
| Remove circuit / section | `POST …/segments/{segment_id}/remove` |
| Reorder blocks | `POST …/segments/reorder` |
| Reorder / move an item | `POST …/exercises/{id}/move` |
| Move an item into its own slot | `POST …/exercises/{id}/extract` |
| Remove extra | Not applicable: canonical workouts have no extras |
