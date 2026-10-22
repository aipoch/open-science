import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LifecycleObserver, isSameProcess, processTable } from './observer.mjs'
import {
  runObserved,
  validateCoreEvidence,
  validateDetectorTap,
  CORE_SCENARIOS,
  CORE_CHECKPOINTS,
  DETECTOR_COUNT
} from './run.mjs'

for (const kind of ['clean', 'borrowed', 'leak', 'orphan', 'timeout']) {
  test(`canary ${kind} checks before cleanup`, { timeout: 30000 }, async () => {
    const output = await mkdtemp(join(tmpdir(), 'lifecycle-canary-'))
    try {
      const child = spawn(
        process.execPath,
        [resolve('scripts/ci/process-lifecycle/canary.mjs'), kind],
        {
          env: { ...process.env, LIFECYCLE_OUTPUT: output },
          stdio: 'ignore'
        }
      )
      const status = await new Promise((fulfill, reject) => {
        child.once('error', reject)
        child.once('exit', fulfill)
      })
      assert.equal(status, ['clean', 'borrowed'].includes(kind) ? 0 : 1)
      const files = await readdir(output)
      assert.equal(files.length, 1)
      const evidence = JSON.parse(await readFile(join(output, files[0]), 'utf8'))
      assert.ok(evidence.identities.length >= (kind === 'orphan' ? 2 : 1))
      assert.deepEqual(evidence.cleanupRemaining, [])
      assert.ok(evidence.sourceSha.match(/^[a-f0-9]{40}$/))
      if (kind === 'leak' || kind === 'orphan') {
        assert.equal(evidence.checkpoints.at(-1).status, 'failed')
        assert.ok(evidence.checkpoints.at(-1).leaks.length)
        assert.ok(evidence.cleanup.some((item) => item.action === 'kill-requested'))
      }
      if (kind === 'timeout') assert.ok(evidence.errors.includes('checkpoint-not-executed'))
      // The child report is corroborated by a fresh independent OS snapshot after it exited.
      const current = await processTable()
      assert.ok(
        evidence.identities.every(
          (item) => !current.some((now) => isSameProcess(item, now) && now.status !== 'zombie')
        )
      )
      if (process.env.LIFECYCLE_OUTPUT) {
        const { mkdir, copyFile } = await import('node:fs/promises')
        const destination = join(process.env.LIFECYCLE_OUTPUT, 'canaries')
        await mkdir(destination, { recursive: true })
        await copyFile(join(output, files[0]), join(destination, files[0]))
      }
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  })
}

test('PID reuse, unreadable evidence and missing execution fail closed', async () => {
  const output = await mkdtemp(join(tmpdir(), 'lifecycle-identity-'))
  const unrelated = { pid: 1, parentPid: 0, created: 1, status: 'running' }
  const original = { pid: 999999, parentPid: 1, created: 10, status: 'running' }
  // Windows retains a parent's PID after exit; the owned root can later reuse that PID.
  const baselineChild = { pid: 2, parentPid: original.pid, created: 2, status: 'running' }
  const unrelatedChild = { pid: 3, parentPid: baselineChild.pid, created: 11, status: 'running' }
  let table = [unrelated, baselineChild]
  const observer = new LifecycleObserver('identity-test', { output, readTable: async () => table })
  try {
    await observer.start()
    await assert.rejects(observer.checkpoint('not-executed', { timeoutMs: 0 }), /blocked/)
    table = [unrelated, baselineChild, original, unrelatedChild]
    await observer.observe(original.pid)
    assert.equal(observer.seen.size, 1, 'do not adopt descendants through a baseline process')
    table = [unrelated, { ...original, created: 11 }]
    assert.equal(isSameProcess(original, table[1]), false)
    await observer.checkpoint('reused-is-not-original', { timeoutMs: 0 })
    assert.equal(observer.seen.size, 1, 'do not claim a recycled root PID')
    table = [unrelated, { pid: original.pid, unknown: true }]
    await assert.rejects(observer.checkpoint('unknown-is-not-exit', { timeoutMs: 0 }), /failed/)
    observer.readTable = async () => {
      throw new Error('private command SECRET must not be stored')
    }
    await assert.rejects(observer.checkpoint('snapshot-failure', { timeoutMs: 0 }), /blocked/)
    const report = await readFile(join(output, (await readdir(output))[0]), 'utf8')
    assert.ok(!report.includes('SECRET'))
    const cleanup = await processTable({
      operation: 'cleanup',
      identities: [{ pid: process.pid, created: 0 }]
    })
    assert.equal(cleanup[0].action, 'reused-preserved')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('runner timeout fails before killing its own process tree', { timeout: 30000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'lifecycle-timeout-'))
  const marker = join(output, 'started')
  try {
    await assert.rejects(
      runObserved(
        process.execPath,
        [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(()=>{},1000)`
        ],
        'timeout',
        { ...process.env, LIFECYCLE_OUTPUT: output },
        10000
      ),
      /incomplete/
    )
    assert.equal(await readFile(marker, 'utf8'), 'started')
    const evidence = JSON.parse(
      await readFile(
        join(
          output,
          (await readdir(output)).find((name) => name.endsWith('.json'))
        ),
        'utf8'
      )
    )
    assert.equal(evidence.checkpoints[0].status, 'failed')
    assert.ok(evidence.checkpoints[0].leaks.length)
    assert.deepEqual(evidence.cleanupRemaining, [])
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('capture deadline never releases a late workload', { timeout: 30000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'lifecycle-capture-timeout-'))
  const marker = join(output, 'started')
  let calls = 0
  try {
    await assert.rejects(
      runObserved(
        process.execPath,
        [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(()=>{},1000)`
        ],
        'capture-timeout',
        { ...process.env, LIFECYCLE_OUTPUT: output },
        100,
        {
          readTable: async () => {
            if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 500))
            return processTable()
          }
        }
      ),
      /incomplete/
    )
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
    const report = JSON.parse(await readFile(join(output, (await readdir(output))[0]), 'utf8'))
    assert.ok(report.errors.includes('runner-not-started'))
    assert.deepEqual(report.cleanupRemaining, [])
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('runner rejects missing, skipped, stale, duplicate and incomplete scenario evidence', () => {
  const tap = `# tests ${DETECTOR_COUNT}\n# pass ${DETECTOR_COUNT}\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n`
  assert.equal(validateDetectorTap(tap), true)
  for (const bad of [
    '',
    tap.replace(`tests ${DETECTOR_COUNT}`, 'tests 0'),
    tap.replace('skipped 0', 'skipped 1'),
    tap.replace('fail 0', 'fail 1')
  ])
    assert.equal(validateDetectorTap(bad), false)
  const provenance = { runId: 'run', sourceSha: 'a'.repeat(40), harnessSha256: 'b'.repeat(64) }
  const reports = CORE_SCENARIOS.map((scenario) => ({
    ...provenance,
    scenario,
    runId: 'run',
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    platform: process.platform,
    identities: [{ pid: 1, created: 1 }],
    checkpoints: CORE_CHECKPOINTS[scenario].map((label) => ({ label, status: 'passed' })),
    errors: [],
    cleanup: [{ pid: 1, created: 1, action: 'absent' }],
    cleanupRemaining: []
  }))
  assert.ok(validateCoreEvidence(reports, provenance).every((item) => item.status === 'passed'))
  assert.ok(
    validateCoreEvidence(reports, { ...provenance, runId: 'stale-run' }).every(
      (item) => item.status === 'not-executed'
    )
  )
  for (const replacement of [
    undefined,
    { ...reports[0], sourceSha: 'c'.repeat(40) },
    { ...reports[0], harnessSha256: 'c'.repeat(64) },
    { ...reports[0], platform: 'other-platform' },
    { ...reports[0], checkpoints: [] },
    { ...reports[0], checkpoints: [{ label: 'unrelated', status: 'passed' }] },
    { ...reports[0], checkpoints: [...reports[0].checkpoints, ...reports[0].checkpoints] },
    { ...reports[0], checkpoints: [{ status: 'skipped' }] },
    { ...reports[0], cleanupRemaining: [{ pid: 1 }] },
    { ...reports[0], errors: ['blocked'] },
    { ...reports[0], cleanup: undefined }
  ]) {
    const changed = reports.slice(1)
    if (replacement) changed.push(replacement)
    assert.notEqual(validateCoreEvidence(changed, provenance)[0].status, 'passed')
  }
  assert.equal(validateCoreEvidence([...reports, reports[0]], provenance)[0].status, 'failed')
})

test(
  'runner waits for initial capture before releasing the workload',
  { timeout: 30000 },
  async () => {
    const output = await mkdtemp(join(tmpdir(), 'lifecycle-capture-'))
    const marker = join(output, 'started')
    let calls = 0
    try {
      const baseline = await processTable()
      assert.equal(
        await runObserved(
          process.execPath,
          ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
          'delayed-capture',
          { ...process.env, LIFECYCLE_OUTPUT: output },
          10000,
          {
            readTable: async () => {
              if (++calls <= 3) {
                await assert.rejects(readFile(marker), { code: 'ENOENT' })
                return baseline
              }
              return processTable()
            }
          }
        ),
        true
      )
      assert.ok(calls > 3)
      assert.equal(await readFile(marker, 'utf8'), 'started')
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }
)

test(
  'failed initial capture reaps the gate without starting descendants',
  { timeout: 30000 },
  async () => {
    const output = await mkdtemp(join(tmpdir(), 'lifecycle-capture-failure-'))
    const marker = join(output, 'started')
    let calls = 0
    let captured = []
    try {
      await assert.rejects(
        runObserved(
          process.execPath,
          [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(()=>{},1000)`
          ],
          'capture-failure',
          { ...process.env, LIFECYCLE_OUTPUT: output },
          10000,
          {
            readTable: async () => {
              const table = await processTable()
              if (++calls === 2) {
                captured = table.filter((item) => item.parentPid === process.pid)
                throw new Error('initial-observation-failed')
              }
              return table
            }
          }
        ),
        /incomplete/
      )
      await assert.rejects(readFile(marker), { code: 'ENOENT' })
      assert.ok(captured.length > 0)
      const current = await processTable()
      assert.ok(
        captured.every(
          (item) => !current.some((now) => isSameProcess(item, now) && now.status !== 'zombie')
        )
      )
      const report = JSON.parse(await readFile(join(output, (await readdir(output))[0]), 'utf8'))
      assert.ok(report.errors.includes('runner-not-started'))
      assert.deepEqual(report.cleanupRemaining, [])
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }
)

test(
  'missing workload executable fails and leaves no observed process',
  { timeout: 30000 },
  async () => {
    const output = await mkdtemp(join(tmpdir(), 'lifecycle-spawn-failure-'))
    try {
      await assert.rejects(
        runObserved(
          join(output, 'missing-executable'),
          [],
          'spawn-failure',
          { ...process.env, LIFECYCLE_OUTPUT: output },
          10000
        ),
        /incomplete/
      )
      const report = JSON.parse(await readFile(join(output, (await readdir(output))[0]), 'utf8'))
      assert.ok(report.errors.includes('scenario-operation-failed'))
      assert.deepEqual(report.cleanupRemaining, [])
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }
)
