import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { selectOwnedProcesses, snapshotInstallation, waitForRecordedExit } from './owned-processes.mjs'

test('selects only the exact installation directory and its later descendants', () => {
  const records = [
    { pid: 1, parent: 0, path: 'C:\\test\\app\\open-science.exe', started: '2026-01-01T00:00:01Z' },
    { pid: 2, parent: 1, path: 'C:\\Node\\node.exe', started: '2026-01-01T00:00:02Z' },
    { pid: 3, parent: 2, path: 'C:\\Node\\node.exe', started: '2026-01-01T00:00:03Z' },
    { pid: 4, parent: 0, path: 'C:\\test\\app-other\\open-science.exe', started: '2026-01-01T00:00:01Z' },
    { pid: 5, parent: 0, path: 'C:\\Installed\\open-science.exe', started: '2026-01-01T00:00:01Z' },
    { pid: 6, parent: 1, path: 'C:\\Node\\node.exe', started: '2025-01-01T00:00:01Z' }
  ]
  assert.deepEqual(selectOwnedProcesses(records, 'C:\\test\\app').map((p) => p.pid), [1, 2, 3])
  assert.throws(() => selectOwnedProcesses(records, 'app'), /absolute/)
})

test('actual Windows wait fails on a live process, ignores reused identity and only kills the owned fixture', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const parent = resolve('tmp')
  const root = await mkdtemp(join(parent, 'upgrade-process-fixture-'))
  assert.ok(root.startsWith(parent + '\\'))
  const executable = join(root, 'owned-fixture.exe')
  await copyFile(process.execPath, executable)
  const launch = (exe) => spawn(exe, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { windowsHide: true })
  const owned = launch(executable)
  const unrelated = launch(process.execPath)
  const ready = (child) => new Promise((yes, no) => { child.stdout.once('data', yes); child.once('error', no) })
  const exit = (child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((yes) => child.once('close', yes))
  try {
    await Promise.all([ready(owned), ready(unrelated)])
    const records = await snapshotInstallation(root)
    assert.ok(records.some((p) => p.pid === owned.pid))
    assert.ok(records.every((p) => p.pid === owned.pid || (p.parent === owned.pid && /\\conhost\.exe$/i.test(p.path))))
    assert.ok(!records.some((p) => p.pid === unrelated.pid))
    await assert.rejects(waitForRecordedExit(records, { timeoutMs: 100 }), /did not exit/)
    await waitForRecordedExit([{ ...records.find((p) => p.pid === owned.pid), started: '2000-01-01T00:00:00.0000000Z' }], { force: true, timeoutMs: 100 })
    assert.doesNotThrow(() => process.kill(owned.pid, 0))
    const result = await waitForRecordedExit(records, { force: true, timeoutMs: 10000 })
    assert.equal(result[0].exited, true)
    assert.equal(result[0].forced, true)
    await exit(owned)
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
  } finally {
    for (const child of [owned, unrelated]) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.all([exit(owned), exit(unrelated)])
    await rm(root, { recursive: true })
  }
})
