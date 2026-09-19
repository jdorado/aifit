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

test('help exposes only the three bounded artifact writes', async () => {
  const result = await runCli(['--help']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /aifit blueprint solidify/);
  assert.match(result.stdout, /aifit workout override/);
  assert.match(result.stdout, /aifit workout swap/);
  assert.doesNotMatch(result.stdout, /profile|history|generate|list/i);
});

test('a command without Ez-scoped context fails before any API call', async () => {
  const result = await runCli([
    'blueprint', 'solidify', '--input', '-', '--request-id', 'blueprint-test',
  ], { input: '{}' });
  const payload = errorPayload(result);

  assert.equal(payload.error.code, 'cli_error');
  assert.match(payload.error.message, /scoped application context/);
});

test('valid input is transported with only the Ez capability and typed options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aifit-plugin-test-'));
  const fetchOutput = join(directory, 'fetch.json');
  try {
    const blueprint = { title: 'Offline contract fixture', weeks: [] };
    const result = await runCli([
      'blueprint', 'solidify', '--input', '-', '--request-id', 'blueprint-test',
      '--blueprint-id', 'bp_test', '--expected-revision', 'rev_test',
    ], {
      context: { api_base_url: 'https://aifit.test', capability: 'capability-test' },
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('blueprint input cannot smuggle CLI metadata into the API payload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aifit-plugin-test-'));
  const inputPath = join(directory, 'blueprint.json');
  const fetchOutput = join(directory, 'fetch.json');
  try {
    await writeFile(inputPath, JSON.stringify({ title: 'invalid', request_id: 'smuggled' }));
    const result = await runCli([
      'blueprint', 'solidify', '--input', inputPath, '--request-id', 'blueprint-test',
    ], {
      context: { api_base_url: 'https://aifit.test', capability: 'capability-test' },
      fetchOutput,
    });
    const payload = errorPayload(result);

    assert.match(payload.error.message, /only the blueprint object/);
    assert.equal(await fetchRequest(fetchOutput), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('swap input cannot override the native agent selection source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aifit-plugin-test-'));
  const fetchOutput = join(directory, 'fetch.json');
  try {
    const result = await runCli([
      'workout', 'swap', '--input', '-', '--request-id', 'swap-test',
      '--expected-revision', 'workout-rev',
    ], {
      context: { api_base_url: 'https://aifit.test', capability: 'capability-test' },
      fetchOutput,
      input: JSON.stringify({
        workout_id: 'wrk_test',
        exercise_instance_id: 'wex_test',
        expected_blueprint_revision: 'bp-rev-test',
        reason: 'The machine is occupied.',
        source: 'default',
      }),
    });
    const payload = errorPayload(result);

    assert.match(payload.error.message, /must not include source/);
    assert.equal(await fetchRequest(fetchOutput), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
