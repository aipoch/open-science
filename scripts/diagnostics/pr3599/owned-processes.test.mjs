import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { selectOwnedProcesses, snapshotInstallation, waitForRecordedExit, sameRecordedProcess } from './owned-processes.mjs'

test('receipt cleanup distinguishes a reused old Electron PID from the successor MCP', () => {
  const old = { pid: 5148, started: '2026-10-18T07:10:59Z', path: 'D:\\app\\open-science.exe', ownerSid: 'isolated-account' }
  const mcp = { pid: 5148, started: '2026-10-18T07:13:15Z', path: 'C:\\node\\node.exe', ownerSid: old.ownerSid }
  assert.equal(sameRecordedProcess(mcp, old), false)
  assert.equal(sameRecordedProcess({ ...old, started: mcp.started }, old), false)
  assert.equal(sameRecordedProcess({ ...old, path: mcp.path }, old), false)
  assert.equal(sameRecordedProcess({ ...old, ownerSid: 'unrelated-account' }, old), false)
  assert.equal(sameRecordedProcess({ ...old, path: old.path.toUpperCase() }, old), true)
})

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
  const root = await mkdtemp(join(parent, 'upgrade-process-→-fixture-'))
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
    assert.equal(records.find((p) => p.pid === owned.pid).path.toLowerCase(), executable.toLowerCase())
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

test('confirms a real exit between the CIM snapshot and opening the process handle', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const parent = resolve('tmp')
  const root = await mkdtemp(join(parent, 'upgrade-exit-race-'))
  assert.ok(root.startsWith(parent + '\\'))
  const executable = join(root, 'owned-fixture.exe')
  await copyFile(process.execPath, executable)
  const child = spawn(executable, ['-e', 'require("fs").watch(process.argv[1],(_event,name)=>{if(name==="exit")process.exit(0)});console.log("ready")', root], { windowsHide: true })
  const closed = new Promise(resolve => child.once('close', resolve))
  const previous = process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    const records = (await snapshotInstallation(root)).filter(record => record.pid === child.pid)
    assert.equal(records.length, 1)
    let source = await readFile(new URL('./owned-processes.mjs', import.meta.url), 'utf8')
    const seam = '  try { $target = [Diagnostics.Process]::GetProcessById($record.pid); $null = $target.Handle }'
    assert.equal(source.split(seam).length, 2)
    source = source.replace(seam, `$race = [Diagnostics.Process]::GetProcessById($record.pid)
try {
  [IO.File]::WriteAllText($env:OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE,'exit')
  if (-not $race.WaitForExit(10000)) { throw 'Fixture did not voluntarily exit' }
} finally { $race.Dispose() }
${seam}`)
    process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE = join(root, 'exit')
    const injected = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
    const result = await injected.waitForRecordedExit(records, { timeoutMs: 15000 })
    assert.equal(result[0].observed, 'original identity absent after handle-open race')
    assert.equal(result[0].forced, false)
    assert.equal(await closed, 0)
  } finally {
    if (previous === undefined) delete process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE
    else process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE = previous
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
    await rm(root, { recursive: true })
  }
})

test('ownership lookup accepts a confirmed exit but propagates errors for a live identity', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const parent = resolve('tmp')
  const root = await mkdtemp(join(parent, 'upgrade-owner-race-'))
  assert.ok(root.startsWith(parent + '\\'))
  const executable = join(root, 'owned-fixture.exe')
  await copyFile(process.execPath, executable)
  const child = spawn(executable, ['-e', 'require("fs").watch(process.argv[1],(_event,name)=>{if(name==="exit")process.exit(0)});console.log("ready")', root], { windowsHide: true })
  const closed = new Promise(resolve => child.once('close', resolve))
  const previous = process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    const source = await readFile(new URL('./owned-processes.mjs', import.meta.url), 'utf8')
    const seam = '$owner = Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid'
    assert.equal(source.split(seam).length, 2)
    const injected = async replacement => import('data:text/javascript;base64,' + Buffer.from(source.replace(seam, replacement)).toString('base64'))
    const live = await injected("throw 'Synthetic ownership failure while identity remains alive'")
    await assert.rejects(live.snapshotInstallation(root), /Synthetic ownership failure while identity remains alive/)
    assert.doesNotThrow(() => process.kill(child.pid, 0))
    process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE = join(root, 'exit')
    const exiting = await injected(`$race = [Diagnostics.Process]::GetProcessById($record.pid)
try {
  [IO.File]::WriteAllText($env:OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE,'exit')
  if (-not $race.WaitForExit(10000)) { throw 'Fixture did not voluntarily exit' }
} finally { $race.Dispose() }
${seam}`)
    const records = await exiting.snapshotInstallation(root)
    assert.ok(!records.some(record => record.pid === child.pid))
    assert.equal(await closed, 0)
  } finally {
    if (previous === undefined) delete process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE
    else process.env.OPEN_SCIENCE_UPGRADE_TEST_EXIT_RACE_FILE = previous
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
    await rm(root, { recursive: true })
  }
})
