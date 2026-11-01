import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { cpus, arch, platform } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  wistia: { type: 'string' },
  baseline: { type: 'string' },
  output: { type: 'string' },
  repetitions: { type: 'string', default: '3' },
  workers: { type: 'string', default: '4' },
} });
if (!values.wistia || !values.baseline || !values.output) {
  throw new Error('Usage: node bench/wistia-runtime.mjs --wistia PATH --baseline PATH --output PATH [--repetitions 3] [--workers 4]');
}
const wistia = resolve(values.wistia);
const baseline = resolve(values.baseline);
const fork = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(values.output);
const repetitions = Number(values.repetitions);
const workers = Number(values.workers);
if (!Number.isInteger(repetitions) || repetitions < 1 || !Number.isInteger(workers) || workers < 1) {
  throw new Error('Repetitions and workers must be positive integers');
}
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));
const selection = await readJSON(join(wistia, 'not_production/benchmarks/turbo_dom_results.json'));
const files = selection.benchmark_files;
const conditions = [
  { name: 'jsdom', environment: 'jsdom' },
  { name: 'turbo-dom-base', environment: join(baseline, 'src/environment/vitest.mjs') },
  { name: 'turbo-dom-fixed', environment: join(fork, 'src/environment/vitest.mjs') },
];
const config = join(wistia, `.vitest-runtime-${randomUUID()}.config.mts`);
const reporter = join(output, 'phases-reporter.mjs');
await mkdir(output, { recursive: true });
await writeFile(reporter, `import { writeFileSync } from 'node:fs';
export default class {
  modules = [];
  onTestModuleEnd(module) {
    const diagnostic = module.diagnostic();
    const phases = {};
    for (const key of ['environmentSetupDuration', 'prepareDuration', 'collectDuration', 'setupDuration', 'duration']) {
      phases[key] = diagnostic[key];
    }
    this.modules.push({ file: module.relativeModuleId, ...phases });
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
let expectedTests;
let expectedCases;
async function run(condition, iteration) {
  const name = `${iteration === 0 ? 'warmup' : 'run-' + iteration}-${condition.name}`;
  const report = join(output, name + '.json');
  const phasesFile = join(output, name + '-phases.json');
  const log = createWriteStream(join(output, name + '.log'));
  const command = ['test', '--config', config, '--project', 'frontend', `--maxWorkers=${workers}`,
    '--reporter=json', `--reporter=${reporter}`, `--outputFile=${report}`, ...files];
  const start = performance.now();
  const exitCode = await new Promise((accept, reject) => {
    const child = spawn('yarn', command, { cwd: wistia, env: {
      ...process.env, CI: '1', TZ: 'UTC', NODE_ENV: 'test',
      WISTIA_RUNTIME_ENV: condition.environment, WISTIA_RUNTIME_PHASES: phasesFile,
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
  expectedTests ??= result.numTotalTests;
  const cases = JSON.stringify(result.testResults.flatMap(file => file.assertionResults.map(test =>
    [file.name, test.fullName])).sort());
  expectedCases ??= cases;
  const record = { environment: condition.name, iteration, warmup: iteration === 0,
    wall_seconds: wallSeconds, exit_code: exitCode, files: result.testResults.length,
    passed_tests: result.numPassedTests, failed_tests: result.numFailedTests,
    summed_worker_phase_ms: totals };
  runs.push(record);
  await writeFile(join(output, 'runs.json'), JSON.stringify(runs, null, 2) + '\n');
  console.log(JSON.stringify(record));
  if (exitCode !== 0 || result.numFailedTests !== 0 || result.numPassedTests !== expectedTests || result.numTotalTests !== expectedTests || result.testResults.length !== files.length || cases !== expectedCases) {
    throw new Error(`Benchmark ${name} did not pass the identical test selection; inspect ${report}`);
  }
}
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const commit = (path) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
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
  const data = { date: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(),
    logical_cpus: cpus().length, workers, repetitions, expected_tests: expectedTests,
    commits: { wistia: commit(wistia), baseline: commit(baseline), fork: commit(fork) },
    versions: { jsdom: (await readJSON(join(wistia, 'node_modules/jsdom/package.json'))).version,
      turbo_dom_base: (await readJSON(join(baseline, 'package.json'))).version,
      turbo_dom_fixed: (await readJSON(join(fork, 'package.json'))).version,
      vitest: (await readJSON(join(wistia, 'node_modules/vitest/package.json'))).version },
    methodology: [`Same ${files.length}-file, ${expectedTests}-test selection that passed both environments in the original evaluation.`,
      'One excluded warmup per condition; sequential timed runs with rotating order.',
      'Wall time includes Yarn/Vitest process startup, setup, imports, tests and teardown.',
      'Phase times are summed across workers and must not be added to or compared directly with wall time.',
      'Dependency installation and GraphQL generation excluded; CI=1 uses already generated GraphQL outputs.',
      'The sample was selected for compatibility and is not a whole-suite performance estimate.',
      'Original and fixed turbo-dom both use the same published 0.5.8 native parser artifact.'],
    comparisons: {
      fixed_wall_time_reduction_percent_vs_jsdom: 100 * (1 - summary['turbo-dom-fixed'].median_wall_seconds / summary.jsdom.median_wall_seconds),
      fixed_wall_time_reduction_percent_vs_base: 100 * (1 - summary['turbo-dom-fixed'].median_wall_seconds / summary['turbo-dom-base'].median_wall_seconds),
      base_and_fixed_ranges_overlap: summary['turbo-dom-fixed'].min_wall_seconds <= summary['turbo-dom-base'].max_wall_seconds
        && summary['turbo-dom-base'].min_wall_seconds <= summary['turbo-dom-fixed'].max_wall_seconds,
    },
    files, summary, runs };
  await writeFile(join(output, 'summary.json'), JSON.stringify(data, null, 2) + '\n');
} finally {
  await unlink(config);
}
