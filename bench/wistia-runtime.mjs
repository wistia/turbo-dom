import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { cpus, arch, platform } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  wistia: { type: 'string' },
  baseline: { type: 'string' },
  files: { type: 'string' },
  output: { type: 'string' },
  repetitions: { type: 'string', default: '3' },
  workers: { type: 'string', default: '4' },
} });
if (!values.wistia || !values.output) {
  throw new Error('Usage: node bench/wistia-runtime.mjs --wistia PATH --output PATH [--files SELECTION.json] [--baseline PATH] [--repetitions 3] [--workers 4]');
}
const wistia = resolve(values.wistia);
const baseline = values.baseline ? resolve(values.baseline) : null;
const fork = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(values.output);
const repetitions = Number(values.repetitions);
const workers = Number(values.workers);
if (!Number.isInteger(repetitions) || repetitions < 1 || !Number.isInteger(workers) || workers < 1) {
  throw new Error('Repetitions and workers must be positive integers');
}
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));
const selection = await readJSON(values.files ? resolve(values.files) : join(wistia, 'not_production/benchmarks/turbo_dom_results.json'));
const files = Array.isArray(selection) ? selection : selection.files || selection.benchmark_files;
if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string') || new Set(files).size !== files.length) {
  throw new Error('Selection must contain unique test file paths');
}
const conditions = [
  { name: 'jsdom', environment: 'jsdom' },
  ...(baseline ? [{ name: 'turbo-dom-base', environment: join(baseline, 'src/environment/vitest.mjs') }] : []),
  { name: 'turbo-dom-fixed', environment: join(fork, 'src/environment/vitest.mjs') },
];
const config = join(wistia, `.vitest-runtime-${randomUUID()}.config.mts`);
const reporter = join(output, 'phases-reporter.mjs');
await mkdir(output, { recursive: true });
await writeFile(reporter, `import { writeFileSync, appendFileSync } from 'node:fs';
export default class {
  modules = [];
  onTestModuleEnd(module) {
    const diagnostic = module.diagnostic();
    const phases = {};
    for (const key of ['environmentSetupDuration', 'prepareDuration', 'collectDuration', 'setupDuration', 'duration']) {
      phases[key] = diagnostic[key];
    }
    this.modules.push({ file: module.relativeModuleId, ...phases });
    appendFileSync(process.env.WISTIA_RUNTIME_PROGRESS, JSON.stringify({
      file: module.relativeModuleId, state: module.state(),
      errors: (module.errors() || []).map(error => ({ name: error.name, message: error.message })),
      tests: Array.from(module.children.allTests(), test => ({ name: test.fullName, state: test.result().state })),
    }) + '\\n');
  }
  onTestRunEnd() {
    writeFileSync(process.env.WISTIA_RUNTIME_PHASES, JSON.stringify(this.modules));
  }
}
`);
await writeFile(config, `import base from './vitest.config.mts';
export default { ...base, test: { ...base.test, projects: base.test.projects.map(project => ({
  ...project, test: { ...project.test, environment: process.env.WISTIA_RUNTIME_ENV },
})) }};
`);
const runs = [];
let expectedCounts;
let expectedCases;
async function run(condition, iteration) {
  const name = `${iteration === 0 ? 'warmup' : 'run-' + iteration}-${condition.name}`;
  const report = join(output, name + '.json');
  const phasesFile = join(output, name + '-phases.json');
  const progressFile = join(output, name + '-progress.jsonl');
  await Promise.all([rm(report, { force: true }), rm(phasesFile, { force: true }), writeFile(progressFile, '')]);
  const log = createWriteStream(join(output, name + '.log'));
  const command = ['test', '--config', config, '--project', 'frontend', `--maxWorkers=${workers}`,
    '--reporter=json', `--reporter=${reporter}`, `--outputFile=${report}`, ...files];
  const start = performance.now();
  const exitCode = await new Promise((accept, reject) => {
    const child = spawn('yarn', command, { cwd: wistia, env: {
      ...process.env, CI: '1', TZ: 'UTC', NODE_ENV: 'test',
      WISTIA_RUNTIME_ENV: condition.environment, WISTIA_RUNTIME_PHASES: phasesFile,
      WISTIA_RUNTIME_PROGRESS: progressFile,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', reject);
    child.on('close', accept);
  });
  const wallSeconds = (performance.now() - start) / 1000;
  log.end();
  const result = await readJSON(report);
  const phases = await readJSON(phasesFile);
  const totals = {};
  for (const module of phases) {
    for (const [key, value] of Object.entries(module)) {
      if (key !== 'file') totals[key] = (totals[key] || 0) + value;
    }
  }
  const counts = { passed: result.numPassedTests, failed: result.numFailedTests,
    skipped: result.numPendingTests, todo: result.numTodoTests, total: result.numTotalTests };
  expectedCounts ??= counts;
  const cases = JSON.stringify(result.testResults.flatMap(file => file.assertionResults.map(test =>
    [relative(wistia, file.name), test.fullName, test.status])).sort());
  expectedCases ??= cases;
  const record = { environment: condition.name, iteration, warmup: iteration === 0,
    wall_seconds: wallSeconds, exit_code: exitCode, files: result.testResults.length,
    passed_tests: result.numPassedTests, failed_tests: result.numFailedTests,
    skipped_tests: result.numPendingTests, todo_tests: result.numTodoTests,
    summed_worker_phase_ms: totals };
  runs.push(record);
  await writeFile(join(output, 'runs.json'), JSON.stringify(runs, null, 2) + '\n');
  console.log(JSON.stringify(record));
  const reportedFiles = new Set(result.testResults.map(file => relative(wistia, file.name)));
  const sameFiles = reportedFiles.size === files.length && files.every(file => reportedFiles.has(file));
  if (exitCode !== 0 || counts.failed !== 0 || result.numFailedTestSuites !== 0 || JSON.stringify(counts) !== JSON.stringify(expectedCounts) || !sameFiles || cases !== expectedCases) {
    throw new Error(`Benchmark ${name} did not pass the identical test selection; inspect ${report}`);
  }
}
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const commit = (path) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
const commits = () => ({ wistia: commit(wistia), ...(baseline ? { baseline: commit(baseline) } : {}), fork: commit(fork) });
const initialCommits = commits();
try {
  for (const condition of conditions) await run(condition, 0);
  for (let iteration = 1; iteration <= repetitions; iteration++) {
    for (let offset = 0; offset < conditions.length; offset++) {
      await run(conditions[(iteration - 1 + offset) % conditions.length], iteration);
    }
  }
  const summary = {};
  for (const condition of conditions) {
    const selected = runs.filter(run => run.environment === condition.name && !run.warmup);
    const times = selected.map(run => run.wall_seconds);
    const phaseKeys = Object.keys(selected[0].summed_worker_phase_ms);
    summary[condition.name] = { median_wall_seconds: median(times), min_wall_seconds: Math.min(...times),
      max_wall_seconds: Math.max(...times), median_summed_worker_phase_ms: Object.fromEntries(
        phaseKeys.map(key => [key, median(selected.map(run => run.summed_worker_phase_ms[key]))])) };
  }
  if (JSON.stringify(commits()) !== JSON.stringify(initialCommits)) throw new Error('Repository commits changed during the benchmark');
  const data = { date: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(),
    logical_cpus: cpus().length, workers, repetitions, expected_tests: expectedCounts.total, expected_counts: expectedCounts,
    commits: initialCommits,
    versions: { jsdom: (await readJSON(join(wistia, 'node_modules/jsdom/package.json'))).version,
      ...(baseline ? { turbo_dom_base: (await readJSON(join(baseline, 'package.json'))).version } : {}),
      turbo_dom_fixed: (await readJSON(join(fork, 'package.json'))).version,
      vitest: (await readJSON(join(wistia, 'node_modules/vitest/package.json'))).version },
    methodology: [`Same ${files.length}-file, ${expectedCounts.total}-case selection; identical passing/skipped/todo case inventory is verified for every run.`,
      'One excluded warmup per condition; sequential timed runs with rotating order.',
      'Wall time includes Yarn/Vitest process startup, setup, imports, tests and teardown.',
      'Phase times are summed across workers and must not be added to or compared directly with wall time.',
      'Dependency installation and GraphQL generation excluded; CI=1 uses already generated GraphQL outputs.',
      'The sample was selected for compatibility and is not a whole-suite performance estimate.',
      'The fork uses the same published 0.5.8 native parser artifact as the compatibility audit.'],
    comparisons: {
      fixed_wall_time_reduction_percent_vs_jsdom: 100 * (1 - summary['turbo-dom-fixed'].median_wall_seconds / summary.jsdom.median_wall_seconds),
      ...(baseline ? {
        fixed_wall_time_reduction_percent_vs_base: 100 * (1 - summary['turbo-dom-fixed'].median_wall_seconds / summary['turbo-dom-base'].median_wall_seconds),
        base_and_fixed_ranges_overlap: summary['turbo-dom-fixed'].min_wall_seconds <= summary['turbo-dom-base'].max_wall_seconds
          && summary['turbo-dom-base'].min_wall_seconds <= summary['turbo-dom-fixed'].max_wall_seconds,
      } : {}),
    },
    files, summary, runs };
  await writeFile(join(output, 'summary.json'), JSON.stringify(data, null, 2) + '\n');
} finally {
  await unlink(config);
}
