/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LifecycleObserver, isSameProcess, harnessDigest } from './process-lifecycle-observer.mjs'

export const CORE_SCENARIOS = [
  'verification-normal',
  'verification-failure',
  'verification-cancel',
  'verification-timeout',
  'mcp-normal',
  'mcp-cancel',
  'mcp-timeout',
  'agent-stop',
  'agent-recovery',
  'kernel-host-stop',
  'shell-recovery',
  'backend-startup-failure',
  'runtime-borrowed',
  'runtime-owned-generations'
]

export function validateDetectorTap(tap) {
  const count = (name) => Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1])
  return (
    count('tests') === 8 &&
    count('pass') === 8 &&
    count('fail') === 0 &&
    count('skipped') === 0 &&
    count('cancelled') === 0 &&
    count('todo') === 0
  )
}

export function validateCoreEvidence(reports, runId) {
  return CORE_SCENARIOS.map((scenario) => {
    const matching = reports.filter(
      (report) => report.runId === runId && report.scenario === scenario
    )
    const report = matching[0]
    const required =
      scenario === 'runtime-borrowed'
        ? ['borrowed-survives-detach', 'generation-0-exited']
        : scenario === 'runtime-owned-generations'
          ? ['generation-0-exited', 'generation-1-exited']
          : undefined
    const complete =
      matching.length === 1 &&
      report.schemaVersion === 1 &&
      /^[a-f0-9]{40}$/.test(report.sourceSha) &&
      report.platform === process.platform &&
      report.identities?.length > 0 &&
      report.identities.every(
        (identity) =>
          Number.isSafeInteger(identity.pid) &&
          identity.pid > 0 &&
          Number.isFinite(identity.created) &&
          identity.created > 0
      ) &&
      report.checkpoints?.length > 0 &&
      report.checkpoints.every((checkpoint) => checkpoint.status === 'passed') &&
      (!required ||
        required.every((label) =>
          report.checkpoints.some((checkpoint) => checkpoint.label === label)
        )) &&
      Array.isArray(report.errors) &&
      report.errors.length === 0 &&
      Array.isArray(report.cleanup) &&
      report.identities.every((identity) =>
        report.cleanup.some(
          (entry) =>
            isSameProcess(identity, entry) &&
            ['absent', 'reused-preserved', 'exited-zombie'].includes(entry.action)
        )
      ) &&
      Array.isArray(report.cleanupRemaining) &&
      report.cleanupRemaining.length === 0
    return { scenario, status: complete ? 'passed' : matching.length ? 'failed' : 'not-executed' }
  })
}

export async function runObserved(command, args, label, environment, timeoutMs) {
  const observer = new LifecycleObserver(`runner-${label}`, {
    output: environment.LIFECYCLE_OUTPUT
  })
  await observer.start()
  const child = spawn(command, args, {
    env: environment,
    stdio: 'inherit'
  })
  const completed = new Promise((fulfill) => {
    child.once('error', () => fulfill({ code: null, reason: 'spawn-failed' }))
    child.once('exit', (code) => fulfill({ code }))
  })
  let timer,
    sampling,
    stopped = false,
    observationFailed = false
  let result
  try {
    await observer.observe(child.pid)
    sampling = (async () => {
      while (!stopped) {
        try {
          await observer.sample()
        } catch {
          observationFailed = true
        }
        await new Promise((fulfill) => setTimeout(fulfill, 200))
      }
    })()
    result = await Promise.race([
      completed,
      new Promise((fulfill) => {
        timer = setTimeout(() => fulfill({ code: null, reason: 'timeout' }), timeoutMs)
      })
    ])
    stopped = true
    await sampling
    if (observationFailed) throw new Error('runner-observation-incomplete')
    // A hung/failed runner is recorded while it is still alive; cleanup follows in finally.
    await observer.checkpoint('runner-exited', { timeoutMs: result.reason ? 0 : 5000 })
    return result.code === 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    stopped = true
    await sampling
    await observer.finish(observationFailed || result?.code !== 0)
  }
}

async function main() {
  const mode = process.argv[2] ?? 'core'
  if (!['core', 'detector'].includes(mode)) throw new Error('Mode must be core or detector')
  const output = resolve(process.env.LIFECYCLE_OUTPUT || 'test-results/process-lifecycle')
  const runId = randomUUID()
  process.env.LIFECYCLE_RUN_ID = runId
  const environment = {
    ...process.env,
    LIFECYCLE_OUTPUT: output,
    LIFECYCLE_RUN_ID: runId,
    RUN_PROCESS_LIFECYCLE: '1'
  }
  await mkdir(output, { recursive: true })
  const temporary = await mkdtemp(join(tmpdir(), 'lifecycle-run-'))
  const summary = {
    schemaVersion: 1,
    runId,
    mode,
    platform: process.platform,
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    harnessSha256: harnessDigest(),
    status: 'not-completed',
    scenarios: []
  }
  const save = () => writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2))
  await save()
  try {
    const tapPath = join(temporary, 'detector.tap')
    summary.detectorPassed = await runObserved(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        `--test-reporter-destination=${tapPath}`,
        'scripts/ci/process-lifecycle-observer.node-test.mjs'
      ],
      'detector',
      environment,
      120000
    )
    summary.detectorPassed &&= validateDetectorTap(await readFile(tapPath, 'utf8'))
    if (!summary.detectorPassed) throw new Error('detector-failed')
    if (mode === 'core') {
      const resultPath = join(temporary, 'vitest.json')
      // Run npm's JavaScript entry with Node: Windows .cmd + shell concatenation loses argument
      // boundaries when the checkout or temporary report path contains spaces.
      const npmCommand = execFileSync(
        process.platform === 'win32' ? 'where.exe' : 'which',
        ['npm'],
        { encoding: 'utf8' }
      )
        .trim()
        .split(/\r?\n/)[0]
      const npmCli =
        process.platform === 'win32'
          ? join(dirname(npmCommand), 'node_modules/npm/bin/npm-cli.js')
          : realpathSync(npmCommand)
      try {
        summary.testsPassed = await runObserved(
          process.execPath,
          [
            npmCli,
            'test',
            '--',
            'scripts/ci/process-lifecycle.integration.test.ts',
            '--reporter=default',
            '--reporter=json',
            `--outputFile=${resultPath}`
          ],
          'core',
          environment,
          15 * 60000
        )
      } catch {
        summary.testsPassed = false
      }
      const reports = []
      for (const name of await readdir(output)) {
        if (name.endsWith('.json') && name !== 'summary.json')
          reports.push(JSON.parse(await readFile(join(output, name), 'utf8')))
      }
      summary.scenarios = validateCoreEvidence(reports, runId)
      const vitest = JSON.parse(await readFile(resultPath, 'utf8'))
      summary.testCounts = {
        total: vitest.numTotalTests,
        passed: vitest.numPassedTests,
        pending: vitest.numPendingTests
      }
      summary.failedTests = vitest.testResults.flatMap((file) =>
        file.assertionResults
          .filter((test) => test.status !== 'passed')
          .map((test) => ({ name: test.title, status: test.status }))
      )
      if (
        !summary.testsPassed ||
        vitest.numTotalTests !== CORE_SCENARIOS.length ||
        vitest.numPassedTests !== CORE_SCENARIOS.length ||
        vitest.numPendingTests !== 0 ||
        summary.scenarios.some((scenario) => scenario.status !== 'passed')
      )
        throw new Error('core-incomplete')
    }
    summary.status = 'passed'
  } catch {
    summary.status = 'failed-or-blocked'
    process.exitCode = 1
  } finally {
    await save()
    await rm(temporary, { recursive: true, force: true })
    console.log(`Process lifecycle ${mode}: ${summary.status}; evidence: ${output}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main()
