import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredFiles = [
  'README.md',
  'SKILL.md',
  'bin/aifit.mjs',
  'ez-plugin.json',
  'ez-deployment.json',
  'Dockerfile',
  '.dockerignore',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'pnpm-lock.yaml',
];
const packageData = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginData = JSON.parse(await readFile(join(root, 'ez-plugin.json'), 'utf8'));
const deploymentData = JSON.parse(await readFile(join(root, 'ez-deployment.json'), 'utf8'));
const failures = [];

for (const relativePath of requiredFiles) {
  try {
    await stat(join(root, relativePath));
  } catch {
    failures.push(`missing required file: ${relativePath}`);
  }
}

const packageFiles = new Set(packageData.files || []);
for (const relativePath of requiredFiles) {
  if (!packageFiles.has(relativePath) && relativePath !== 'bin/aifit.mjs') {
    const topLevelPath = relativePath.split('/')[0];
    if (!packageFiles.has(topLevelPath)) failures.push(`not in package files: ${relativePath}`);
  }
}

if (packageData.version !== pluginData.version) failures.push('package and plugin versions differ');
if (packageData.name !== '@aifit/ez-plugin') failures.push('unexpected npm package name');
if (packageData.license !== 'MIT') failures.push('package license must be MIT');
if (packageData.engines?.node !== '>=22') failures.push('Node 22 engine requirement is missing');
if (packageData.packageManager !== 'pnpm@10.30.3') failures.push('pnpm package-manager pin is missing');
if (!pluginData.skills?.includes('SKILL.md')) failures.push('plugin skill path is missing');
if (!pluginData.commands?.aifit?.executable) failures.push('plugin command executable is missing');
if (pluginData.commands?.aifit?.exposure?.changesRecords !== true) failures.push('record-change exposure is missing');
if (deploymentData.commands?.aifit?.service !== 'aifit') failures.push('deployment command service is missing');
if (deploymentData.services?.aifit?.buildTarget !== 'runtime') failures.push('runtime build target is missing');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    package: packageData.name,
    version: packageData.version,
    files: requiredFiles.length,
  }));
}
