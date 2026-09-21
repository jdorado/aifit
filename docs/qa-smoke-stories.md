# AIFit QA checklist

Run these through the authenticated Ez/AIFit path with the real native agent.
For each line: PASS/FAIL plus the canonical readback (command, id/revision or
receipt). Do not expand the list.

## Setup

- [ ] Isolated tenant with the current tenant `AGENTS.md`
- [ ] Real agent, installed `aifit` plugin, `ez aifit --help` current
- [ ] A canonical readback after every write

## Reads

- [ ] READ-01 `workout list` shows the days the frontend shows
- [ ] READ-02 `workout show` shows today's exercises, sets and revision
- [ ] READ-03 `blueprint active` shows the published blueprint revision
- [ ] READ-04 `exercise show` / `exercise history` show canonical records
- [ ] READ-05 "what's my workout today?" answers from the record, never from `fitness-plan.md`

## Writes

- [ ] EXERCISE-01 `exercise create` writes, `exercise show` reads it back
- [ ] BLUEPRINT-01 `blueprint draft` stores a revision without activating it
- [ ] BLUEPRINT-02 `blueprint solidify` publishes; `blueprint active` shows the revision
- [ ] DAY-01 `workout generate` with `default` and `jev` picks only blueprint candidates; same date + request id is idempotent
- [ ] LOG-01 `workout log-set` records actuals; workout reads back `in_progress` or `completed`
- [ ] LOAD-01 "heavier weights" → one complete `workout override`; unstarted work only
- [ ] SWAP-01 "machine taken" → `workout swap`; other items and the blueprint revision unchanged
- [ ] ADD-01 "add an exercise" → complete `workout override`; blueprint unchanged
- [ ] LOCK-01 logged sets are locked: mutation rejected, no receipt, coach language + valid alternative
- [ ] TG-01 a Telegram turn runs a plugin read and a plugin write
