import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  wistia: { type: 'string' }, files: { type: 'string' }, output: { type: 'string' },
  workers: { type: 'string', default: '3' },
} });
if (!values.wistia || !values.files || !values.output) {
  throw new Error('Usage: node bench/wistia-compatibility.mjs --wistia PATH --files SELECTION.json --output PATH [--workers 3]');
}
const wistia = resolve(values.wistia);
const fork = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(values.output);
const workers = Number(values.workers);
if (!Number.isInteger(workers) || workers < 1) throw new Error('Workers must be a positive integer');
const selection = JSON.parse(await readFile(resolve(values.files), 'utf8'));
const files = Array.isArray(selection) ? selection : selection.files;
if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string')) {
  throw new Error('Selection must contain a non-empty array of test file paths');
}
await mkdir(output, { recursive: true });
const config = join(wistia, `.vitest-compatibility-${randomUUID()}.config.mts`);
const reporter = join(output, 'progress-reporter.mjs');
await writeFile(reporter, `import { appendFileSync } from 'node:fs';
const errors = list => (list || []).map(error => ({ name: error.name, message: error.message, stack: error.stack }));
export default class {
  onTestModuleEnd(module) {
    const tests = Array.from(module.children.allTests(), test => ({
      name: test.fullName, state: test.result().state, errors: errors(test.result().errors),
    }));
    appendFileSync(process.env.WISTIA_AUDIT_PROGRESS, JSON.stringify({
      file: module.relativeModuleId, state: module.state(), errors: errors(module.errors()), tests,
    }) + '\\n');
  }
}
`);
await writeFile(config, `import base from './vitest.config.mts';
export default { ...base, test: { ...base.test, projects: base.test.projects.map(project => ({
  ...project, test: { ...project.test, environment: process.env.WISTIA_AUDIT_ENV },
})) }};
`);
async function run(name, environment) {
  const reportPath = join(output, name + '.json');
  const progressPath = join(output, name + '-progress.jsonl');
  await rm(reportPath, { force: true });
  await writeFile(progressPath, '');
  const log = createWriteStream(join(output, name + '.log'));
  let exitCode;
  try {
    exitCode = await new Promise((accept, reject) => {
      const child = spawn('yarn', ['test', '--config', config, '--project', 'frontend',
        `--maxWorkers=${workers}`, '--reporter=json', `--reporter=${reporter}`,
        `--outputFile=${reportPath}`, ...files], {
        cwd: wistia,
        env: { ...process.env, CI: '1', TZ: 'UTC', NODE_ENV: 'test',
          WISTIA_AUDIT_ENV: environment, WISTIA_AUDIT_PROGRESS: progressPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on('error', reject);
      child.on('close', accept);
    });
  } finally {
    log.end();
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const reportedFiles = new Set(report.testResults.map(file => relative(wistia, file.name)));
  const missingFiles = files.filter(file => !reportedFiles.has(file));
  if (missingFiles.length) throw new Error(`${name} did not report: ${missingFiles.join(', ')}`);
  const result = { name, exit_code: exitCode, files: report.testResults.length,
    additional_matched_files: [...reportedFiles].filter(file => !files.includes(file)),
    passed_files: report.testResults.filter(file => file.status === 'passed').length,
    total_tests: report.numTotalTests, passed_tests: report.numPassedTests,
    failed_tests: report.numFailedTests, pending_tests: report.numPendingTests };
  console.log(JSON.stringify(result));
  return result;
}
try {
  const results = await Promise.allSettled([
    run('jsdom', 'jsdom'), run('fork', join(fork, 'src/environment/vitest.mjs')),
  ]);
  const serialized = results.map(result => result.status === 'fulfilled' ? result : {
    status: result.status, reason: String(result.reason),
  });
  await writeFile(join(output, 'runs.json'), JSON.stringify(serialized, null, 2) + '\n');
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
} finally {
  await unlink(config);
}
