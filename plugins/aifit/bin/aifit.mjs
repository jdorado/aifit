#!/usr/bin/env node

// AIFit exposes three explicit writes to Ez: blueprint solidification, a
// blueprint-constrained swap, and a resolved one-day workout override. The
// agent owns the surrounding context; these commands only transport typed
// artifacts to AIFit's authoritative API.

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

Write:
  aifit blueprint solidify --input FILE|- --request-id KEY \\
    [--blueprint-id ID --expected-revision REV]

  aifit workout override --input FILE|- --request-id KEY \\
    [--expected-revision REV]

  aifit workout swap --input FILE|- --request-id KEY --expected-revision REV

Artifacts (full typed schema and rules are in the installed aifit skill):
  blueprint: schema_version=1, timezone, start_date, end_date, hard_constraints,
    days[{day_id,date,kind,title,intent_md,segments[{segment_id,order,kind,rounds,
    rest_after_round_seconds,slots[{slot_id,order,role,selection_count,candidates[
    {candidate_id,exercise_id,exercise_revision,priority,rationale_md,
    equipment_profile_id,prescription{metric,target{reps|duration_seconds,load,rpe},
    rest_seconds,tempo},progression}]}]}]}]
  override: date, title, reason_md, segments (every slot exactly one candidate)
  swap: workout_id, exercise_instance_id, expected_blueprint_revision, reason

Do not include owner, tenant, API URL, capability, request_id, or conversation
content in an artifact.`;
}

function parseOptions(args) {
  const allowed = new Set(['--input', '--request-id', '--blueprint-id', '--expected-revision']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!allowed.has(name)) throw new Error(`Unknown option ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`${name} may be supplied only once`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values[name] = value;
  }
  return values;
}

function optional(options, name) {
  return options[name];
}

function required(options, name) {
  const value = optional(options, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
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

async function call(context, method, path, body) {
  const response = await fetch(`${context.api_base_url}/v1/agent${path}`, {
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

async function jsonFile(file) {
  let parsed;
  try {
    const source = file === '-' ? await readStdin() : await readFile(file, 'utf8');
    parsed = JSON.parse(source);
  }
  catch (error) { throw new Error(`Could not read JSON input ${file}: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must contain one JSON object`);
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function blueprintFile(file) {
  const parsed = await jsonFile(file);
  for (const field of ['blueprint_id', 'expected_revision', 'request_id']) {
    if (Object.hasOwn(parsed, field)) throw new Error(`${file} must contain only the blueprint object; pass ${field} as a CLI option`);
  }
  return parsed;
}

async function overrideFile(file) {
  const parsed = await jsonFile(file);
  for (const field of ['expected_revision', 'request_id']) {
    if (Object.hasOwn(parsed, field)) throw new Error(`${file} must contain only the workout override object; pass ${field} as a CLI option`);
  }
  return parsed;
}

async function swapFile(file) {
  const parsed = await jsonFile(file);
  for (const field of ['expected_revision', 'request_id']) {
    if (Object.hasOwn(parsed, field)) throw new Error(`${file} must contain only the swap intent; pass ${field} as a CLI option`);
  }
  if (Object.hasOwn(parsed, 'source')) throw new Error(`${file} must not include source; the agent swap path always uses JEV`);
  return parsed;
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
  if (area === 'blueprint' && action === 'solidify') {
    const options = parseOptions(rest);
    result = await call(context, 'POST', '/blueprints/solidify', {
      ...await blueprintFile(required(options, '--input')),
      blueprint_id: optional(options, '--blueprint-id'),
      expected_revision: optional(options, '--expected-revision') || null,
      request_id: required(options, '--request-id'),
    });
  } else if (area === 'workout' && action === 'override') {
    const options = parseOptions(rest);
    result = await call(context, 'POST', '/workouts/override', {
      ...await overrideFile(required(options, '--input')),
      expected_revision: optional(options, '--expected-revision') || null,
      request_id: required(options, '--request-id'),
    });
  } else if (area === 'workout' && action === 'swap') {
    const options = parseOptions(rest);
    result = await call(context, 'POST', '/workouts/swap', {
      ...await swapFile(required(options, '--input')),
      expected_revision: required(options, '--expected-revision'),
      request_id: required(options, '--request-id'),
    });
  } else {
    throw new Error('Unknown AIFit command. Run aifit --help.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => fail(error));
