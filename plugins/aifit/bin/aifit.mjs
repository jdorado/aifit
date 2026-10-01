#!/usr/bin/env node

// AIFit is the coach's full application surface: canonical record reads and
// deterministic domain writes. The agent owns the surrounding context; these
// commands only transport typed artifacts and ids to the AIFit API, scoped to
// its installed tenant credential, independent of the incoming channel.

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const connectionFile = process.env.AIFIT_CONFIG_FILE || '/state/connection.json';

function fail(message) {
  const payload = message && typeof message === 'object' && message.payload
    ? message.payload
    : { error: { code: 'cli_error', message: message instanceof Error ? message.message : String(message) } };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = process.argv[2] === 'doctor' ? 2 : 1;
}

class ApiError extends Error {
  constructor(payload) {
    super(payload?.error?.message || 'AIFit API request failed');
    this.payload = payload;
  }
}

function usage() {
  return `AIFit native agent tool

Setup (operator, private JSON stdin):
  aifit configure --account-id ACCOUNT_ID [--rebind-from-account CURRENT_ACCOUNT_ID]
  aifit doctor --json
  configure input: {"api_base_url":"https://api.aifit.living","capability":"PRIVATE_TOKEN"}

Read:
  aifit exercise list [--after EXERCISE_ID] [--limit N]
  aifit exercise show EXERCISE_ID [--revision REV]
  aifit exercise history EXERCISE_ID [--before DATE] [--limit N]
  aifit exercise related-history EXERCISE_ID [--limit N]
  aifit blueprint active [--date DATE]
  aifit workout progression WORKOUT_ID
  aifit workout show WORKOUT_ID
  aifit workout list --start DATE --end DATE
  aifit workout exercise-repertoire WORKOUT_ID
  aifit workout swap-candidates WORKOUT_ID EXERCISE_INSTANCE_ID

Write (all require --request-id):
  aifit exercise create --input FILE|- [--expected-revision REV]
  aifit blueprint draft --input FILE|- [--blueprint-id ID --expected-revision REV]
  aifit blueprint solidify --input FILE|- [--blueprint-id ID --expected-revision REV]
  aifit workout generate --date DATE [--source default|jev]
  aifit workout add-set WORKOUT_ID EXERCISE_INSTANCE_ID --expected-revision REV
  aifit workout remove-set WORKOUT_ID SET_ID --expected-revision REV
  aifit workout log-set WORKOUT_ID SET_ID --input FILE|- --expected-revision REV
  aifit workout set-target WORKOUT_ID SET_ID --input FILE|- --expected-revision REV
  aifit workout unlog-set WORKOUT_ID SET_ID --expected-revision REV
  aifit workout add-exercise WORKOUT_ID --input FILE|- --expected-revision REV
  aifit workout remove-exercise WORKOUT_ID EXERCISE_INSTANCE_ID --expected-revision REV
  aifit workout move-exercise WORKOUT_ID EXERCISE_INSTANCE_ID --input FILE|- --expected-revision REV
  aifit workout extract-exercise WORKOUT_ID EXERCISE_INSTANCE_ID [--input FILE|-] --expected-revision REV
  aifit workout remove-segment WORKOUT_ID SEGMENT_ID --expected-revision REV
  aifit workout reorder-segments WORKOUT_ID --input FILE|- --expected-revision REV
  aifit workout set-notes WORKOUT_ID --input FILE|- --expected-revision REV
  aifit workout set-exercise-notes WORKOUT_ID EXERCISE_INSTANCE_ID --input FILE|- --expected-revision REV
  aifit workout clear WORKOUT_ID --expected-revision REV
  aifit workout copy --from DATE --date DATE --source-revision REV [--expected-revision REV]
  aifit workout override --input FILE|- [--expected-revision REV]
  aifit workout swap --input FILE|- --expected-revision REV [--source default|jev] [--target-candidate CAND]

Artifacts (full typed schema and rules are in the installed aifit skill):
  exercise definition: exercise_id, name, movement_pattern, primary_muscles,
    secondary_muscles, equipment_kind, laterality, load_basis, metrics,
    instructions_md
  blueprint: schema_version=1, timezone, start_date, end_date, hard_constraints,
    days[{day_id,date,kind,title,intent_md,segments[{segment_id,order,kind,title,rounds,
    rest_after_round_seconds,slots[{slot_id,order,role,selection_count,candidates[
    {candidate_id,exercise_id,exercise_revision,priority,rationale_md,
    equipment_profile_id,prescription{metric,target{reps|duration_seconds,load,rpe},
    set_count?,round_targets?,rest_seconds,tempo},progression}]}]}]}]
  Each slot selects one movement. Alternatives are optional and must preserve
  its plan-defined purpose and eligibility. Use set_count for a distinct dose.
  Every training-day and override segment needs a short title (1-80 chars,
  e.g. "Chest + Back", "Warm-up Flow") naming its focus.
  override: date, title, reason_md, segments (every slot exactly one candidate)
  set actual: status, reps, duration_seconds, load, rpe, completed_at
  set target: target{reps|duration_seconds,load,rpe}, apply_to_remaining (optional)
  add exercise: blueprint_id, expected_blueprint_revision, day_id, slot_id, candidate_id
    (read exercise-repertoire; copies one eligible published prescription)
  move exercise: target_segment_id, target_index (1-based, after source removal)
  extract exercise: before_segment_id (optional; default is end of workout)
  reorder segments: segment_ids (every current segment exactly once)
  workout note: notes (string; empty clears)
  exercise note: note (string), preset (pain|hard|easy|form|null, optional)
  swap: workout_id, exercise_instance_id, expected_blueprint_revision, reason
    (pass --target-candidate CAND when the user already picked a slot candidate,
    e.g. a mini-chat top-3 choice; otherwise the API selects via --source)

Reads print canonical JSON records. Writes print one receipt. Use stdin
(--input -) because Ez runs the plugin in an isolated container.
For "add a set", use add-set on the current exercise instance: it appends one
unlogged set with the last working set's target and preserves everything else.
Use remove-set for one unlogged set; set-target for reps/load/time changes.
Never regenerate or override a day for a set edit. Override replaces the entire
unlogged remainder; logged sets are kept separately, so repeating the full
planned dose in an override adds that work again.
Exercise/segment removal and clear remove only unlogged work. Moving, extracting
and reordering preserve sets. Notes replace the named note. Unlog is only for
an explicit correction of recorded performance, never to bypass logged history.
Copy reads a saved source day and creates fresh unlogged sets on a different date;
it refuses to replace a target with logged sets. Read both days before copying.
Before authoring blueprint candidates or overrides, reuse matching catalog
exercise IDs from exercise list. Use common exercise names; keep setup cues
in instructions and prescriptions. Naming variations alone do not need new IDs.
Do not include owner, tenant, API URL, capability, request_id, or conversation
content in an artifact.`;
}

function parseArgs(args, allowed) {
  const values = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--')) { positional.push(name); continue; }
    if (!allowed.has(name)) throw new Error(`Unknown option ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`${name} may be supplied only once`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values[name] = value;
    index += 1;
  }
  return { values, positional };
}

function optional(options, name) {
  return options[name];
}

function required(options, name) {
  const value = optional(options, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function date(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error(`${name} must use YYYY-MM-DD`);
  return value;
}

function oneOf(value, name, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return value;
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value || '')) throw new Error(`${name} must be a whole number`);
  return value;
}

function exactly(positional, count, shape) {
  if (positional.length !== count) throw new Error(`Use ${shape}`);
  return positional;
}

function validateConnection(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'api_base_url,capability' ||
      typeof value.api_base_url !== 'string' || typeof value.capability !== 'string' ||
      !value.capability.startsWith('aifit_plugin_') || value.capability.length < 48) {
    throw new Error('Invalid AIFit connection; operator setup required');
  }
  const url = new URL(value.api_base_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || url.origin !== value.api_base_url) {
    throw new Error('AIFit connection requires an HTTPS origin');
  }
  return value;
}

async function connection() {
  try {
    const stat = await lstat(connectionFile);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('private file required');
    const stored = JSON.parse(await readFile(connectionFile, 'utf8'));
    if (typeof stored.account_id !== 'string' || typeof stored.tenant_id !== 'string') throw new Error('tenant pin required');
    return { ...validateConnection({ api_base_url: stored.api_base_url, capability: stored.capability }), account_id: stored.account_id, tenant_id: stored.tenant_id };
  } catch {
    throw new Error('AIFit plugin is not configured; operator must bind its tenant credential');
  }
}

async function configure(expectedAccount, rebindFrom) {
  if (!/^acc_[a-z0-9_]+$/.test(expectedAccount || '') ||
      (rebindFrom !== undefined && !/^acc_[a-z0-9_]+$/.test(rebindFrom))) {
    throw new Error('Configure requires the intended --account-id from the verified application binding');
  }
  let value;
  try { value = JSON.parse(await readStdin()); } catch { throw new Error('Configure requires private JSON stdin'); }
  const next = validateConnection(value);
  const identity = await call(next, 'GET', '/identity');
  if (!identity?.account_id || !identity?.tenant_id) throw new Error('Invalid AIFit identity readback');
  if (identity.account_id !== expectedAccount) throw new Error('AIFit credential does not match the intended account');
  // An installation must never silently switch tenants.
  try {
    await lstat(connectionFile);
    const current = await connection();
    if (rebindFrom !== undefined && current.account_id !== rebindFrom) {
      throw new Error('AIFit rebind does not match the current account');
    }
    if (current.account_id !== identity.account_id || current.tenant_id !== identity.tenant_id) {
      if (rebindFrom === undefined) throw new Error('AIFit installation is bound to a different tenant');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (rebindFrom !== undefined) throw new Error('AIFit rebind requires an existing account binding');
  }
  await mkdir(dirname(connectionFile), { recursive: true, mode: 0o700 });
  const temporary = connectionFile + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ ...next, account_id: identity.account_id, tenant_id: identity.tenant_id }) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, connectionFile);
  } finally { await rm(temporary, { force: true }); }
  return { configured: true, ...identity };
}

async function call(context, method, path, body, query) {
  const entries = Object.entries(query ?? {}).filter(([, value]) => value !== undefined);
  const search = entries.length ? `?${new URLSearchParams(entries)}` : '';
  const response = await fetch(`${context.api_base_url}/v1/agent${path}${search}`, {
    method,
    headers: {
      authorization: `Bearer ${context.capability}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const detail = typeof parsed === 'object' && parsed !== null
      ? parsed
      : { detail: { message: text || 'request failed' } };
    const message = typeof detail.detail === 'string'
      ? detail.detail
      : detail.detail?.message || text || 'request failed';
    throw new ApiError({
      error: {
        status: response.status,
        message: `AIFit API ${response.status}: ${message}`,
        ...detail,
      },
    });
  }
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonFile(file, shape) {
  let parsed;
  try {
    const source = file === '-' ? await readStdin() : await readFile(file, 'utf8');
    parsed = JSON.parse(source);
  } catch (error) { throw new Error(`Could not read JSON input ${file}: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must contain one JSON object`);
  for (const field of shape.forbidden ?? []) {
    if (Object.hasOwn(parsed, field)) throw new Error(`${file} must contain only the ${shape.name}; pass ${field} as a CLI option`);
  }
  return parsed;
}

function jsonShape(name, forbidden = []) {
  return { name, forbidden };
}

// Scoped workout edits all use the same revision/request envelope.
const workoutEdits = {
  'unlog-set': { ids: 2, shape: 'WORKOUT_ID SET_ID', method: 'POST', input: null,
    path: (workout, id) => `/workouts/${workout}/sets/${id}/unlog` },
  'add-exercise': { ids: 1, shape: 'WORKOUT_ID', method: 'POST', input: "required",
    path: (workout) => `/workouts/${workout}/exercises` },
  'remove-exercise': { ids: 2, shape: 'WORKOUT_ID EXERCISE_INSTANCE_ID', method: 'POST', input: null,
    path: (workout, id) => `/workouts/${workout}/exercises/${id}/remove` },
  'move-exercise': { ids: 2, shape: 'WORKOUT_ID EXERCISE_INSTANCE_ID', method: 'POST', input: "required",
    path: (workout, id) => `/workouts/${workout}/exercises/${id}/move` },
  'extract-exercise': { ids: 2, shape: 'WORKOUT_ID EXERCISE_INSTANCE_ID', method: 'POST', input: "optional",
    path: (workout, id) => `/workouts/${workout}/exercises/${id}/extract` },
  'remove-segment': { ids: 2, shape: 'WORKOUT_ID SEGMENT_ID', method: 'POST', input: null,
    path: (workout, id) => `/workouts/${workout}/segments/${id}/remove` },
  'reorder-segments': { ids: 1, shape: 'WORKOUT_ID', method: 'POST', input: "required",
    path: (workout) => `/workouts/${workout}/segments/reorder` },
  'set-notes': { ids: 1, shape: 'WORKOUT_ID', method: 'PATCH', input: "required",
    path: (workout) => `/workouts/${workout}/notes` },
  'set-exercise-notes': { ids: 2, shape: 'WORKOUT_ID EXERCISE_INSTANCE_ID', method: 'PATCH', input: "required",
    path: (workout, id) => `/workouts/${workout}/exercises/${id}/notes` },
  'clear': { ids: 1, shape: 'WORKOUT_ID', method: 'POST', input: null,
    path: (workout) => `/workouts/${workout}/clear` },
};

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args[0] === 'configure') {
    const { values, positional } = parseArgs(args.slice(1), new Set(['--account-id', '--rebind-from-account']));
    exactly(positional, 0, 'configure --account-id ACCOUNT_ID [--rebind-from-account CURRENT_ACCOUNT_ID]');
    process.stdout.write(JSON.stringify(await configure(required(values, '--account-id'), optional(values, '--rebind-from-account'))) + '\n');
    return;
  }
  const context = await connection();
  if (args[0] === 'doctor') {
    if (args.length !== 2 || args[1] !== '--json') throw new Error('Use aifit doctor --json');
    const identity = await call(context, 'GET', '/identity');
    if (identity.account_id !== context.account_id || identity.tenant_id !== context.tenant_id) throw new Error('AIFit credential does not match its tenant pin');
    process.stdout.write(JSON.stringify({ ok: true, ...identity }) + '\n');
    return;
  }
  const [area, action, ...rest] = args;
  let result;
  if (area === 'exercise' && action === 'list') {
    const { values, positional } = parseArgs(rest, new Set(['--after', '--limit']));
    exactly(positional, 0, 'exercise list [--after EXERCISE_ID] [--limit N]');
    result = await call(context, 'GET', '/exercises', undefined, {
      after: optional(values, '--after'),
      limit: optional(values, '--limit') ? positiveInteger(values['--limit'], '--limit') : undefined,
    });
  } else if (area === 'exercise' && action === 'show') {
    const { values, positional } = parseArgs(rest, new Set(['--revision']));
    const [exerciseId] = exactly(positional, 1, 'exercise show EXERCISE_ID');
    result = await call(context, 'GET', `/exercises/${exerciseId}`, undefined, { revision: optional(values, '--revision') });
  } else if (area === 'exercise' && action === 'history') {
    const { values, positional } = parseArgs(rest, new Set(['--before', '--limit']));
    const [exerciseId] = exactly(positional, 1, 'exercise history EXERCISE_ID');
    result = await call(context, 'GET', `/exercises/${exerciseId}/history`, undefined, {
      before: optional(values, '--before') ? date(values['--before'], '--before') : undefined,
      limit: optional(values, '--limit') ? positiveInteger(values['--limit'], '--limit') : undefined,
    });
  } else if (area === 'exercise' && action === 'related-history') {
    const { values, positional } = parseArgs(rest, new Set(['--limit']));
    const [exerciseId] = exactly(positional, 1, 'exercise related-history EXERCISE_ID');
    result = await call(context, 'GET', `/exercises/${exerciseId}/related-history`, undefined, {
      limit: optional(values, '--limit') ? positiveInteger(values['--limit'], '--limit') : undefined,
    });
  } else if (area === 'exercise' && action === 'create') {
    const { values } = parseArgs(rest, new Set(['--input', '--expected-revision', '--request-id']));
    result = await call(context, 'POST', '/exercises', {
      definition: await jsonFile(required(values, '--input'), jsonShape('exercise definition', ['expected_revision', 'request_id'])),
      expected_revision: optional(values, '--expected-revision') || null,
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'blueprint' && action === 'active') {
    const { values } = parseArgs(rest, new Set(['--date']));
    result = await call(context, 'GET', '/blueprints/active', undefined, {
      date: optional(values, '--date') ? date(values['--date'], '--date') : undefined,
    });
  } else if (area === 'blueprint' && action === 'draft') {
    const { values } = parseArgs(rest, new Set(['--input', '--blueprint-id', '--expected-revision', '--request-id']));
    result = await call(context, 'POST', '/blueprints/draft', {
      ...await jsonFile(required(values, '--input'), jsonShape('blueprint object', ['blueprint_id', 'expected_revision', 'request_id'])),
      blueprint_id: optional(values, '--blueprint-id') || null,
      expected_revision: optional(values, '--expected-revision') || null,
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'blueprint' && action === 'solidify') {
    const { values } = parseArgs(rest, new Set(['--input', '--blueprint-id', '--expected-revision', '--request-id']));
    result = await call(context, 'POST', '/blueprints/solidify', {
      ...await jsonFile(required(values, '--input'), jsonShape('blueprint object', ['blueprint_id', 'expected_revision', 'request_id'])),
      blueprint_id: optional(values, '--blueprint-id') || null,
      expected_revision: optional(values, '--expected-revision') || null,
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'exercise-repertoire') {
    const { positional } = parseArgs(rest, new Set());
    const [workoutId] = exactly(positional, 1, 'workout exercise-repertoire WORKOUT_ID');
    result = await call(context, 'GET', `/workouts/${encodeURIComponent(workoutId)}/exercise-repertoire`);
  } else if (area === 'workout' && action === 'swap-candidates') {
    const { positional } = parseArgs(rest, new Set());
    const [workoutId, instanceId] = exactly(positional, 2, 'workout swap-candidates WORKOUT_ID EXERCISE_INSTANCE_ID');
    result = await call(context, 'GET', `/workouts/${encodeURIComponent(workoutId)}/exercises/${encodeURIComponent(instanceId)}/swap-candidates`);
  } else if (area === 'workout' && action === 'progression') {
    const { positional } = parseArgs(rest, new Set());
    const [workoutId] = exactly(positional, 1, 'workout progression WORKOUT_ID');
    result = await call(context, 'GET', `/workouts/${encodeURIComponent(workoutId)}/progression`);
  } else if (area === 'workout' && action === 'show') {
    const { positional } = parseArgs(rest, new Set());
    const [workoutId] = exactly(positional, 1, 'workout show WORKOUT_ID');
    result = await call(context, 'GET', `/workouts/${workoutId}`);
  } else if (area === 'workout' && action === 'list') {
    const { values } = parseArgs(rest, new Set(['--start', '--end']));
    result = await call(context, 'GET', '/workouts', undefined, {
      start: date(required(values, '--start'), '--start'),
      end: date(required(values, '--end'), '--end'),
    });
  } else if (area === 'workout' && action === 'generate') {
    const { values } = parseArgs(rest, new Set(['--date', '--source', '--request-id']));
    result = await call(context, 'POST', '/workouts/generate', {
      date: date(required(values, '--date'), '--date'),
      source: optional(values, '--source') ? oneOf(values['--source'], '--source', ['default', 'jev']) : 'default',
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'add-set') {
    const { values, positional } = parseArgs(rest, new Set(['--expected-revision', '--request-id']));
    const [workoutId, instanceId] = exactly(positional, 2, 'workout add-set WORKOUT_ID EXERCISE_INSTANCE_ID');
    result = await call(context, 'POST', `/workouts/${encodeURIComponent(workoutId)}/exercises/${encodeURIComponent(instanceId)}/sets`, {
      expected_revision: required(values, '--expected-revision'),
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'remove-set') {
    const { values, positional } = parseArgs(rest, new Set(['--expected-revision', '--request-id']));
    const [workoutId, setId] = exactly(positional, 2, 'workout remove-set WORKOUT_ID SET_ID');
    result = await call(context, 'POST', `/workouts/${encodeURIComponent(workoutId)}/sets/${encodeURIComponent(setId)}/remove`, {
      expected_revision: required(values, '--expected-revision'),
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'log-set') {
    const { values, positional } = parseArgs(rest, new Set(['--input', '--expected-revision', '--request-id']));
    const [workoutId, setId] = exactly(positional, 2, 'workout log-set WORKOUT_ID SET_ID');
    result = await call(context, 'PATCH', `/workouts/${workoutId}/sets/${setId}`, {
      actual: await jsonFile(required(values, '--input'), jsonShape('set actual', ['expected_revision', 'request_id'])),
      expected_revision: required(values, '--expected-revision'),
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'set-target') {
    const { values, positional } = parseArgs(rest, new Set(['--input', '--expected-revision', '--request-id']));
    const [workoutId, setId] = exactly(positional, 2, 'workout set-target WORKOUT_ID SET_ID');
    result = await call(context, 'PATCH', `/workouts/${encodeURIComponent(workoutId)}/sets/${encodeURIComponent(setId)}/target`, {
      ...await jsonFile(required(values, '--input'), jsonShape('set target object', ['expected_revision', 'request_id'])),
      expected_revision: required(values, '--expected-revision'),
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && Object.hasOwn(workoutEdits, action)) {
    const edit = workoutEdits[action];
    const { values, positional } = parseArgs(rest, new Set([
      '--expected-revision', '--request-id', ...(edit.input ? ['--input'] : []),
    ]));
    const ids = exactly(positional, edit.ids, `workout ${action} ${edit.shape}`).map(encodeURIComponent);
    const input = edit.input === 'optional' && !values['--input'] ? {}
      : edit.input ? await jsonFile(required(values, '--input'), jsonShape(`${action} object`, ['expected_revision', 'request_id'])) : {};
    result = await call(context, edit.method, edit.path(...ids), {
      ...input,
      expected_revision: required(values, '--expected-revision'),
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'copy') {
    const { values, positional } = parseArgs(rest, new Set(['--from', '--date', '--source-revision', '--expected-revision', '--request-id']));
    exactly(positional, 0, 'workout copy --from DATE --date DATE --source-revision REV [--expected-revision REV] --request-id KEY');
    result = await call(context, 'POST', '/workouts/copy', {
      source_date: date(required(values, '--from'), '--from'),
      date: date(required(values, '--date'), '--date'),
      expected_source_revision: required(values, '--source-revision'),
      expected_revision: optional(values, '--expected-revision') || null,
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'override') {
    const { values } = parseArgs(rest, new Set(['--input', '--expected-revision', '--request-id']));
    result = await call(context, 'POST', '/workouts/override', {
      ...await jsonFile(required(values, '--input'), jsonShape('workout override object', ['expected_revision', 'request_id'])),
      expected_revision: optional(values, '--expected-revision') || null,
      request_id: required(values, '--request-id'),
    });
  } else if (area === 'workout' && action === 'swap') {
    const { values } = parseArgs(rest, new Set(['--input', '--expected-revision', '--request-id', '--source', '--target-candidate']));
    const targetCandidate = optional(values, '--target-candidate');
    if (targetCandidate !== undefined && !/^cand_[a-z0-9_]{3,120}$/.test(targetCandidate)) {
      throw new Error('--target-candidate must match ^cand_[a-z0-9_]{3,120}$');
    }
    result = await call(context, 'POST', '/workouts/swap', {
      ...await jsonFile(required(values, '--input'), jsonShape('swap intent', ['expected_revision', 'request_id', 'source', 'target_candidate_id'])),
      expected_revision: required(values, '--expected-revision'),
      request_id: required(values, '--request-id'),
      source: optional(values, '--source') ? oneOf(values['--source'], '--source', ['default', 'jev']) : 'jev',
      ...(targetCandidate === undefined ? {} : { target_candidate_id: targetCandidate }),
    });
  } else {
    throw new Error('Unknown AIFit command. Run aifit --help.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => fail(error));
