#!/usr/bin/env node

// A narrow native Ez tool. It obtains the per-run capability from Ez's opaque
// application context; neither an owner identifier nor a long-lived secret is
// accepted as an argument or read from the workspace.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function usage() {
  return `AIFit native agent tool

Read:
  aifit context
  aifit profile show
  aifit exercise show EXERCISE_ID [--revision REV]
  aifit history exercise EXERCISE_ID [--before YYYY-MM-DD] [--limit N]
  aifit program active [--date YYYY-MM-DD]
  aifit workout show WORKOUT_ID
  aifit workout list --start YYYY-MM-DD --end YYYY-MM-DD

Write (all require --request-id):
  aifit profile update --markdown FILE --expected-revision REV_OR_NONE --request-id KEY
  aifit exercise create --input FILE --request-id KEY
  aifit exercise revise --input FILE --expected-revision REV --request-id KEY
  aifit plan draft --markdown FILE --request-id KEY [--plan-id ID --expected-revision REV]
  aifit blueprint validate --input FILE
  aifit blueprint draft --input FILE --request-id KEY [--blueprint-id ID --expected-revision REV]
  aifit program publish --plan-id ID --plan-revision REV --blueprint-id ID --blueprint-revision REV --request-id KEY
  aifit workout generate --date YYYY-MM-DD --mode default|varied --request-id KEY
  aifit workout override --input FILE --expected-revision REV_OR_NONE --request-id KEY
  aifit workout log-set --workout-id ID --set-id ID --input FILE --request-id KEY --expected-revision REV
  aifit workout swap --workout-id ID --exercise-instance ID --reason TEXT --mode default|varied --request-id KEY --expected-revision REV

Input files contain only the documented AIFit JSON object. Do not include owner,
tenant, API URL, capability, or conversation content.`;
}

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function date(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error(`${name} must use YYYY-MM-DD`);
  return value;
}

async function runContext() {
  const { stdout } = await execute('ezenciel-agents-schedule', ['context'], {
    maxBuffer: 128 * 1024,
    env: process.env,
  });
  let context;
  try {
    context = JSON.parse(stdout);
  } catch {
    throw new Error('Ez returned invalid run context');
  }
  const aifit = context?.run?.application?.context?.aifit;
  if (!aifit || typeof aifit.api_base_url !== 'string' || typeof aifit.capability !== 'string') {
    throw new Error('This Ez run has no AIFit capability. Start from AIFit chat or mini-chat.');
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
    const detail = typeof parsed === 'object' && parsed?.detail
      ? (typeof parsed.detail === 'string' ? parsed.detail : parsed.detail.message || JSON.stringify(parsed.detail))
      : text;
    throw new Error(`AIFit API ${response.status}: ${detail || 'request failed'}`);
  }
  return parsed;
}

async function jsonFile(file) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Could not read JSON input ${file}: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must contain one JSON object`);
  return parsed;
}

async function markdownFile(file) {
  const content = await readFile(file, 'utf8');
  if (!content.trim()) throw new Error(`${file} is empty`);
  return content;
}

function mutation(args) {
  return { request_id: required(args, '--request-id') };
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
  if (area === 'context' && action === undefined) {
    result = await call(context, 'GET', '/context');
  } else if (area === 'profile' && action === 'show') {
    result = await call(context, 'GET', '/profile');
  } else if (area === 'profile' && action === 'update') {
    const expected = required(rest, '--expected-revision');
    result = await call(context, 'PUT', '/profile', {
      content_md: await markdownFile(required(rest, '--markdown')),
      expected_revision: expected === 'NONE' ? null : expected,
      ...mutation(rest),
    });
  } else if (area === 'exercise' && action === 'show') {
    const id = rest[0];
    if (!id) throw new Error('exercise ID is required');
    const revision = option(rest, '--revision');
    result = await call(context, 'GET', `/exercises/${encodeURIComponent(id)}${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`);
  } else if (area === 'exercise' && (action === 'create' || action === 'revise')) {
    const definition = await jsonFile(required(rest, '--input'));
    result = await call(context, 'POST', '/exercises', {
      definition,
      expected_revision: action === 'revise' ? required(rest, '--expected-revision') : null,
      ...mutation(rest),
    });
  } else if (area === 'history' && action === 'exercise') {
    const id = rest[0];
    if (!id) throw new Error('exercise ID is required');
    const query = new URLSearchParams();
    const before = option(rest, '--before');
    if (before) query.set('before', date(before, '--before'));
    const limit = option(rest, '--limit');
    if (limit) query.set('limit', limit);
    result = await call(context, 'GET', `/exercises/${encodeURIComponent(id)}/history${query.size ? `?${query}` : ''}`);
  } else if (area === 'plan' && action === 'draft') {
    const content = await markdownFile(required(rest, '--markdown'));
    const title = option(rest, '--title', content.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Fitness Plan');
    result = await call(context, 'POST', '/plans/draft', {
      title, content_md: content, plan_id: option(rest, '--plan-id'),
      expected_revision: option(rest, '--expected-revision') || null,
      ...mutation(rest),
    });
  } else if (area === 'blueprint' && action === 'validate') {
    result = await call(context, 'POST', '/blueprints/validate', await jsonFile(required(rest, '--input')));
  } else if (area === 'blueprint' && action === 'draft') {
    result = await call(context, 'POST', '/blueprints/draft', {
      ...await jsonFile(required(rest, '--input')),
      blueprint_id: option(rest, '--blueprint-id'), expected_revision: option(rest, '--expected-revision') || null,
      ...mutation(rest),
    });
  } else if (area === 'program' && action === 'publish') {
    result = await call(context, 'POST', '/programs/publish', {
      plan_id: required(rest, '--plan-id'), plan_revision: required(rest, '--plan-revision'),
      blueprint_id: required(rest, '--blueprint-id'), blueprint_revision: required(rest, '--blueprint-revision'),
      ...mutation(rest),
    });
  } else if (area === 'program' && action === 'active') {
    const on = option(rest, '--date');
    result = await call(context, 'GET', `/programs/active${on ? `?date=${date(on, '--date')}` : ''}`);
  } else if (area === 'workout' && action === 'generate') {
    const mode = option(rest, '--mode', 'default');
    if (!['default', 'varied'].includes(mode)) throw new Error('--mode must be default or varied');
    result = await call(context, 'POST', '/workouts/generate', { date: date(required(rest, '--date'), '--date'), mode, ...mutation(rest) });
  } else if (area === 'workout' && action === 'override') {
    const expected = required(rest, '--expected-revision');
    result = await call(context, 'POST', '/workouts/override', {
      ...await jsonFile(required(rest, '--input')),
      expected_revision: expected === 'NONE' ? null : expected,
      ...mutation(rest),
    });
  } else if (area === 'workout' && action === 'show') {
    const id = rest[0];
    if (!id) throw new Error('workout ID is required');
    result = await call(context, 'GET', `/workouts/${encodeURIComponent(id)}`);
  } else if (area === 'workout' && action === 'list') {
    result = await call(context, 'GET', `/workouts?start=${date(required(rest, '--start'), '--start')}&end=${date(required(rest, '--end'), '--end')}`);
  } else if (area === 'workout' && action === 'log-set') {
    const input = await jsonFile(required(rest, '--input'));
    result = await call(context, 'PATCH', `/workouts/${encodeURIComponent(required(rest, '--workout-id'))}/sets/${encodeURIComponent(required(rest, '--set-id'))}`, {
      ...input, expected_revision: required(rest, '--expected-revision'), ...mutation(rest),
    });
  } else if (area === 'workout' && action === 'swap') {
    const mode = option(rest, '--mode', 'default');
    if (!['default', 'varied'].includes(mode)) throw new Error('--mode must be default or varied');
    result = await call(context, 'POST', `/workouts/${encodeURIComponent(required(rest, '--workout-id'))}/exercises/${encodeURIComponent(required(rest, '--exercise-instance'))}/swap`, {
      mode, reason: required(rest, '--reason'), expected_revision: required(rest, '--expected-revision'), ...mutation(rest),
    });
  } else {
    throw new Error('Unknown AIFit command. Run aifit --help.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
