import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(pluginRoot, 'bin', 'aifit.mjs');
const fetchStubPath = join(pluginRoot, 'test-support', 'fetch-stub.mjs');

function runCli(args, { context = null, fetchOutput = '', input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        EZ_PLUGIN_CONTEXT: context === null ? '' : JSON.stringify(context),
        AIFIT_TEST_FETCH_OUTPUT: fetchOutput,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchStubPath}`]
          .filter(Boolean)
          .join(' '),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fetchRequest(outputPath) {
  try {
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function errorPayload(result) {
  assert.equal(result.code, 1, result.stderr);
  return JSON.parse(result.stderr);
}

async function withFetchOutput(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'aifit-plugin-test-'));
  try {
    return await callback(join(directory, 'fetch.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const scopedContext = { api_base_url: 'https://aifit.test', capability: 'capability-test' };

test('help exposes the canonical reads and the full write surface', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.code, 0, result.stderr);
  for (const command of [
    'aifit exercise show',
    'aifit exercise history',
    'aifit exercise create',
    'aifit blueprint active',
    'aifit blueprint draft',
    'aifit blueprint solidify',
    'aifit workout show',
    'aifit workout list',
    'aifit workout generate',
    'aifit workout log-set',
    'aifit workout override',
    'aifit workout swap',
  ]) {
    assert.ok(result.stdout.includes(command), `help is missing ${command}`);
  }
});

test('help and skill carry the artifact schema the agent must author', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /schema_version=1/);
  assert.match(result.stdout, /exercise_revision/);
  assert.match(result.stdout, /set actual/);

  const skill = await readFile(join(pluginRoot, 'SKILL.md'), 'utf8');
  for (const marker of [
    '"schema_version": 1',
    '"exercise_revision"',
    '"selection_count"',
    '"progression"',
    '"expected_blueprint_revision"',
    'aifit workout show',
    'aifit exercise create',
    'aifit workout log-set',
    'Receipts and errors',
  ]) {
    assert.ok(skill.includes(marker), `skill is missing ${marker}`);
  }
});

test('a command without Ez-scoped context fails before any API call', async () => {
  const result = await runCli(['profile', 'show']);
  const payload = errorPayload(result);

  assert.equal(payload.error.code, 'cli_error');
  assert.match(payload.error.message, /scoped application context/);
});

test('reads transport only the capability, path, and query', async () => {
  await withFetchOutput(async (fetchOutput) => {
    const show = await runCli(['exercise', 'show', 'ex_bench_press', '--revision', 'rev_test'], {
      context: scopedContext, fetchOutput,
    });
    assert.equal(show.code, 0, show.stderr);
    assert.deepEqual(await fetchRequest(fetchOutput), {
      url: 'https://aifit.test/v1/agent/exercises/ex_bench_press?revision=rev_test',
      method: 'GET',
      headers: { authorization: 'Bearer capability-test' },
      body: null,
    });

    const list = await runCli(['workout', 'list', '--start', '2026-09-21', '--end', '2026-09-27'], {
      context: scopedContext, fetchOutput,
    });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(await fetchRequest(fetchOutput), {
      url: 'https://aifit.test/v1/agent/workouts?start=2026-09-21&end=2026-09-27',
      method: 'GET',
      headers: { authorization: 'Bearer capability-test' },
      body: null,
    });
  });
});

test('a read without the record uses the canonical path only', async () => {
  await withFetchOutput(async (fetchOutput) => {
    const result = await runCli(['workout', 'show', 'wrk_0123456789abcdef0123456789abcdef'], {
      context: scopedContext, fetchOutput,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await fetchRequest(fetchOutput), {
      url: 'https://aifit.test/v1/agent/workouts/wrk_0123456789abcdef0123456789abcdef',
      method: 'GET',
      headers: { authorization: 'Bearer capability-test' },
      body: null,
    });
  });
});

test('valid input is transported with only the Ez capability and typed options', async () => {
  await withFetchOutput(async (fetchOutput) => {
    const blueprint = { title: 'Offline contract fixture', weeks: [] };
    const result = await runCli([
      'blueprint', 'solidify', '--input', '-', '--request-id', 'blueprint-test',
      '--blueprint-id', 'bp_test', '--expected-revision', 'rev_test',
    ], {
      context: scopedContext,
      fetchOutput,
      input: JSON.stringify(blueprint),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'saved', request_id: 'stub-request' });
    assert.deepEqual(await fetchRequest(fetchOutput), {
      url: 'https://aifit.test/v1/agent/blueprints/solidify',
      method: 'POST',
      headers: {
        authorization: 'Bearer capability-test',
        'content-type': 'application/json',
      },
      body: {
        ...blueprint,
        blueprint_id: 'bp_test',
        expected_revision: 'rev_test',
        request_id: 'blueprint-test',
      },
    });
  });
});

test('exercise, log-set, generate, and swap transport their typed payloads', async () => {
  await withFetchOutput(async (fetchOutput) => {
    const definition = { exercise_id: 'ex_goblet_squat', name: 'Goblet squat' };
    const created = await runCli(['exercise', 'create', '--input', '-', '--request-id', 'exercise-test'], {
      context: scopedContext, fetchOutput, input: JSON.stringify(definition),
    });
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual((await fetchRequest(fetchOutput)).body, {
      definition, expected_revision: null, request_id: 'exercise-test',
    });

    const actual = { status: 'completed', reps: 8, load: { value: 40, unit: 'kg' } };
    const logged = await runCli([
      'workout', 'log-set', 'wrk_0123456789abcdef0123456789abcdef', 'wst_0123456789abcdef0123456789abcdef',
      '--input', '-', '--expected-revision', 'rev_test', '--request-id', 'set-test',
    ], { context: scopedContext, fetchOutput, input: JSON.stringify(actual) });
    assert.equal(logged.code, 0, logged.stderr);
    assert.deepEqual(await fetchRequest(fetchOutput), {
      url: 'https://aifit.test/v1/agent/workouts/wrk_0123456789abcdef0123456789abcdef/sets/wst_0123456789abcdef0123456789abcdef',
      method: 'PATCH',
      headers: { authorization: 'Bearer capability-test', 'content-type': 'application/json' },
      body: { actual, expected_revision: 'rev_test', request_id: 'set-test' },
    });

    const generated = await runCli(['workout', 'generate', '--date', '2026-09-21', '--request-id', 'generate-test'], {
      context: scopedContext, fetchOutput,
    });
    assert.equal(generated.code, 0, generated.stderr);
    assert.deepEqual((await fetchRequest(fetchOutput)).body, {
      date: '2026-09-21', source: 'default', request_id: 'generate-test',
    });

    const swap = await runCli([
      'workout', 'swap', '--input', '-', '--request-id', 'swap-test',
      '--expected-revision', 'rev_0123456789abcdef0123456789abcdef', '--source', 'default',
    ], {
      context: scopedContext,
      fetchOutput,
      input: JSON.stringify({
        workout_id: 'wrk_0123456789abcdef0123456789abcdef',
        exercise_instance_id: 'wex_0123456789abcdef0123456789abcdef',
        expected_blueprint_revision: 'rev_abcdef0123456789abcdef0123456789',
        reason: 'The machine is occupied.',
      }),
    });
    assert.equal(swap.code, 0, swap.stderr);
    assert.deepEqual((await fetchRequest(fetchOutput)).body, {
      workout_id: 'wrk_0123456789abcdef0123456789abcdef',
      exercise_instance_id: 'wex_0123456789abcdef0123456789abcdef',
      expected_blueprint_revision: 'rev_abcdef0123456789abcdef0123456789',
      reason: 'The machine is occupied.',
      expected_revision: 'rev_0123456789abcdef0123456789abcdef',
      request_id: 'swap-test',
      source: 'default',
    });
  });
});

test('artifact inputs cannot smuggle CLI metadata into the API payload', async () => {
  for (const [name, field, args, payload] of [
    ['blueprint', 'request_id', ['blueprint', 'solidify', '--input', '-', '--request-id', 'blueprint-test'], { title: 'invalid', request_id: 'smuggled' }],
    ['override', 'expected_revision', ['workout', 'override', '--input', '-', '--request-id', 'override-test'], { date: '2026-09-21', expected_revision: 'smuggled' }],
    ['swap', 'source', ['workout', 'swap', '--input', '-', '--request-id', 'swap-test', '--expected-revision', 'rev_0123456789abcdef0123456789abcdef'], { source: 'default' }],
    ['set actual', 'request_id', ['workout', 'log-set', 'wrk_x', 'wst_x', '--input', '-', '--expected-revision', 'rev_x', '--request-id', 'set-test'], { status: 'completed', request_id: 'smuggled' }],
    ['exercise definition', 'expected_revision', ['exercise', 'create', '--input', '-', '--request-id', 'exercise-test'], { exercise_id: 'ex_x', expected_revision: 'smuggled' }],
  ]) {
    await withFetchOutput(async (fetchOutput) => {
      const result = await runCli(args, { context: scopedContext, fetchOutput, input: JSON.stringify(payload) });
      const failure = errorPayload(result);
      assert.match(failure.error.message, new RegExp(`pass ${field} as a CLI option`), name);
      assert.equal(await fetchRequest(fetchOutput), null, name);
    });
  }
});

test('unknown commands, options, and missing required values fail closed', async () => {
  const unknown = await runCli(['plan', 'show'], { context: scopedContext, fetchOutput: '/dev/null' });
  assert.match(errorPayload(unknown).error.message, /Unknown AIFit command/);

  const option = await runCli(['workout', 'list', '--start', '2026-09-21', '--end', '2026-09-27', '--days', '3'], {
    context: scopedContext, fetchOutput: '/dev/null',
  });
  assert.match(errorPayload(option).error.message, /Unknown option --days/);

  const missing = await runCli(['workout', 'list', '--start', '2026-09-21'], {
    context: scopedContext, fetchOutput: '/dev/null',
  });
  assert.match(errorPayload(missing).error.message, /--end is required/);

  const shape = await runCli(['workout', 'show'], { context: scopedContext, fetchOutput: '/dev/null' });
  assert.match(errorPayload(shape).error.message, /Use workout show WORKOUT_ID/);
});
