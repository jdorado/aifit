#!/usr/bin/env node

// AIFit is the coach's full application surface: canonical record reads and
// deterministic domain writes. The agent owns the surrounding context; these
// commands only transport typed artifacts and ids to the AIFit API, scoped to
// the current Ez run by the capability Ez delivers to this container.

import { readFile } from 'node:fs/promises';

function fail(message) {
  const payload = message && typeof message === 'object' && message.payload
    ? message.payload
    : { error: { code: 'cli_error', message: message instanceof Error ? message.message : String(message) } };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}

class ApiError extends Error {
  constructor(payload) {
    super(payload?.error?.message || 'AIFit API request failed');
    this.payload = payload;
  }
}

function usage() {
  return `AIFit native agent tool

Read:
  aifit exercise show EXERCISE_ID [--revision REV]
  aifit exercise history EXERCISE_ID [--before DATE] [--limit N]
  aifit blueprint active [--date DATE]
  aifit workout show WORKOUT_ID
  aifit workout list --start DATE --end DATE

Write (all require --request-id):
  aifit exercise create --input FILE|- [--expected-revision REV]
  aifit blueprint draft --input FILE|- [--blueprint-id ID --expected-revision REV]
  aifit blueprint solidify --input FILE|- [--blueprint-id ID --expected-revision REV]
  aifit workout generate --date DATE [--source default|jev]
  aifit workout log-set WORKOUT_ID SET_ID --input FILE|- --expected-revision REV
  aifit workout override --input FILE|- [--expected-revision REV]
  aifit workout swap --input FILE|- --expected-revision REV [--source default|jev]

Artifacts (full typed schema and rules are in the installed aifit skill):
  exercise definition: exercise_id, name, movement_pattern, primary_muscles,
    secondary_muscles, equipment_kind, laterality, load_basis, metrics,
    instructions_md
  blueprint: schema_version=1, timezone, start_date, end_date, hard_constraints,
    days[{day_id,date,kind,title,intent_md,segments[{segment_id,order,kind,rounds,
    rest_after_round_seconds,slots[{slot_id,order,role,selection_count,candidates[
    {candidate_id,exercise_id,exercise_revision,priority,rationale_md,
    equipment_profile_id,prescription{metric,target{reps|duration_seconds,load,rpe},
    rest_seconds,tempo},progression}]}]}]}]
  override: date, title, reason_md, segments (every slot exactly one candidate)
  set actual: status, reps, duration_seconds, load, rpe, completed_at
  swap: workout_id, exercise_instance_id, expected_blueprint_revision, reason

Reads print canonical JSON records. Writes print one receipt. Use stdin
(--input -) because Ez runs the plugin in an isolated container.
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

async function runContext() {
  let aifit;
  try {
    aifit = JSON.parse(process.env.EZ_PLUGIN_CONTEXT || 'null');
  } catch {
    throw new Error('Ez supplied invalid AIFit plugin context');
  }
  if (!aifit || typeof aifit.api_base_url !== 'string' || typeof aifit.capability !== 'string') {
    throw new Error('This AIFit plugin has no scoped application context. Start from AIFit chat or mini-chat.');
  }
  return aifit;
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

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const context = await runContext();
  const [area, action, ...rest] = args;
  let result;
  if (area === 'exercise' && action === 'show') {
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
  } else if (area === 'workout' && action === 'log-set') {
    const { values, positional } = parseArgs(rest, new Set(['--input', '--expected-revision', '--request-id']));
    const [workoutId, setId] = exactly(positional, 2, 'workout log-set WORKOUT_ID SET_ID');
    result = await call(context, 'PATCH', `/workouts/${workoutId}/sets/${setId}`, {
      actual: await jsonFile(required(values, '--input'), jsonShape('set actual', ['expected_revision', 'request_id'])),
      expected_revision: required(values, '--expected-revision'),
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
    const { values } = parseArgs(rest, new Set(['--input', '--expected-revision', '--request-id', '--source']));
    result = await call(context, 'POST', '/workouts/swap', {
      ...await jsonFile(required(values, '--input'), jsonShape('swap intent', ['expected_revision', 'request_id', 'source'])),
      expected_revision: required(values, '--expected-revision'),
      request_id: required(values, '--request-id'),
      source: optional(values, '--source') ? oneOf(values['--source'], '--source', ['default', 'jev']) : 'jev',
    });
  } else {
    throw new Error('Unknown AIFit command. Run aifit --help.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => fail(error));
