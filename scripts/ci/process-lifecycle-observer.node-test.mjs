import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LifecycleObserver, isSameProcess, processTable } from './process-lifecycle-observer.mjs'
import {
  runObserved,
  validateCoreEvidence,
  validateDetectorTap,
  CORE_SCENARIOS
} from './run-process-lifecycle.mjs'

for (const kind of ['clean', 'borrowed', 'leak', 'orphan', 'timeout']) {
  test(`canary ${kind} checks before cleanup`, { timeout: 30000 }, async () => {
    const output = await mkdtemp(join(tmpdir(), 'lifecycle-canary-'))
    try {
      const child = spawn(
        process.execPath,
        [resolve('scripts/ci/process-lifecycle-canary.mjs'), kind],
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
  let table = [unrelated]
  const observer = new LifecycleObserver('identity-test', { output, readTable: async () => table })
  try {
    await observer.start()
    await assert.rejects(observer.checkpoint('not-executed', { timeoutMs: 0 }), /blocked/)
    table = [unrelated, original]
    await observer.observe(original.pid)
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
  try {
    await assert.rejects(
      runObserved(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        'timeout',
        { ...process.env, LIFECYCLE_OUTPUT: output },
        300
      ),
      /incomplete/
    )
    const evidence = JSON.parse(await readFile(join(output, (await readdir(output))[0]), 'utf8'))
    assert.equal(evidence.checkpoints[0].status, 'failed')
    assert.ok(evidence.checkpoints[0].leaks.length)
    assert.deepEqual(evidence.cleanupRemaining, [])
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('runner rejects missing, skipped, stale, duplicate and incomplete scenario evidence', () => {
  const tap = '# tests 8\n# pass 8\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n'
  assert.equal(validateDetectorTap(tap), true)
  for (const bad of [
    '',
    tap.replace('tests 8', 'tests 0'),
    tap.replace('skipped 0', 'skipped 1'),
    tap.replace('fail 0', 'fail 1')
  ])
    assert.equal(validateDetectorTap(bad), false)
  const reports = CORE_SCENARIOS.map((scenario) => ({
    scenario,
    runId: 'run',
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    platform: process.platform,
    identities: [{ pid: 1, created: 1 }],
    checkpoints: [
      'product-stop',
      'borrowed-survives-detach',
      'generation-0-exited',
      'generation-1-exited'
    ].map((label) => ({ label, status: 'passed' })),
    errors: [],
    cleanup: [{ pid: 1, created: 1, action: 'absent' }],
    cleanupRemaining: []
  }))
  assert.ok(validateCoreEvidence(reports, 'run').every((item) => item.status === 'passed'))
  assert.ok(
    validateCoreEvidence(reports, 'stale-run').every((item) => item.status === 'not-executed')
  )
  for (const replacement of [
    undefined,
    { ...reports[0], checkpoints: [] },
    { ...reports[0], checkpoints: [{ status: 'skipped' }] },
    { ...reports[0], cleanupRemaining: [{ pid: 1 }] },
    { ...reports[0], errors: ['blocked'] },
    { ...reports[0], cleanup: undefined }
  ]) {
    const changed = reports.slice(1)
    if (replacement) changed.push(replacement)
    assert.notEqual(validateCoreEvidence(changed, 'run')[0].status, 'passed')
  }
  assert.equal(validateCoreEvidence([...reports, reports[0]], 'run')[0].status, 'failed')
})
