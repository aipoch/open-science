/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'

const usage = `Usage: npm run perf:runtime -- [options]

Options:
  --repeat=<count>       Comparable runs to record (default: 3)
  --phase-ms=<ms>        Idle and recovery phase duration (default: 10000)
  --interval-ms=<ms>     Sampling interval from 250 to 10000 (default: 1000)
  --stress-cycles=<n>    Sustained Session + Notebook cycles per run (default: 1)
  --output=<directory>   Local output root (default: test-results/performance)
  --skip-build           Reuse the existing Electron E2E build
  --help                 Show this help

The profiler records process identity categories, CPU, memory, counts, and phase markers only. It
does not record prompts, responses, command arguments, environment variables, paths, endpoints,
credentials, or file contents.`

const parsePositiveInteger = (name, value, fallback, { min = 1, max = 100 } = {}) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return parsed
}

const options = {
  repeat: 3,
  phaseMs: 10_000,
  intervalMs: 1_000,
  stressCycles: 1,
  output: undefined,
  skipBuild: false
}

for (const argument of process.argv.slice(2)) {
  if (argument === '--help') {
    console.log(usage)
    process.exit(0)
  } else if (argument === '--skip-build') {
    options.skipBuild = true
  } else if (argument.startsWith('--repeat=')) {
    options.repeat = parsePositiveInteger('--repeat', argument.slice('--repeat='.length), 3, {
      max: 20
    })
  } else if (argument.startsWith('--phase-ms=')) {
    options.phaseMs = parsePositiveInteger(
      '--phase-ms',
      argument.slice('--phase-ms='.length),
      10_000,
      { min: 1_000, max: 300_000 }
    )
  } else if (argument.startsWith('--interval-ms=')) {
    options.intervalMs = parsePositiveInteger(
      '--interval-ms',
      argument.slice('--interval-ms='.length),
      1_000,
      { min: 250, max: 10_000 }
    )
  } else if (argument.startsWith('--stress-cycles=')) {
    options.stressCycles = parsePositiveInteger(
      '--stress-cycles',
      argument.slice('--stress-cycles='.length),
      1,
      { max: 20 }
    )
  } else if (argument.startsWith('--output=')) {
    const value = argument.slice('--output='.length).trim()
    if (!value) throw new Error('--output must not be empty.')
    options.output = value
  } else {
    throw new Error(`Unknown option: ${argument}\n\n${usage}`)
  }
}

const npmCliPath = process.env.npm_execpath?.trim()
if (!npmCliPath) {
  throw new Error('npm_execpath is required. Run this profile through npm run perf:runtime.')
}
const run = (args, environment = process.env) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [npmCliPath, ...args], {
      env: environment,
      // npm and Playwright do not read this launcher's stdin. Inheriting a piped stdin from
      // spawnSync/Vitest keeps the Windows child alive until the outer timeout.
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`npm ${args.join(' ')} exited with ${code ?? signal}.`))
    })
  })

if (!options.skipBuild) await run(['run', 'build:e2e'])

const environment = {
  ...process.env,
  OPEN_SCIENCE_PERF_PHASE_MS: String(options.phaseMs),
  OPEN_SCIENCE_PERF_INTERVAL_MS: String(options.intervalMs),
  OPEN_SCIENCE_PERF_STRESS_CYCLES: String(options.stressCycles),
  ...(options.output ? { OPEN_SCIENCE_PERF_OUTPUT_ROOT: options.output } : {})
}

await run(
  [
    'exec',
    '--',
    'playwright',
    'test',
    'e2e/runtime-performance.spec.ts',
    '--workers=1',
    `--repeat-each=${options.repeat}`,
    '--reporter=list'
  ],
  environment
)
