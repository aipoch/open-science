/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the native binding with Node's CommonJS test runner. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const { closeSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const native = require('..')

const windows = { skip: process.platform !== 'win32' }

test(
  'reads live process identity without a subprocess and reports exited processes as missing',
  windows,
  async () => {
    const args = ['arg with space', '"quoted"', 'ünïcode']
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready");process.stdin.resume()', '--', ...args],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    )
    const exited = once(child, 'exit')
    try {
      await once(child.stdout, 'data')
      assert.match(native.getWindowsProcessCreationTime(child.pid), /^[1-9][0-9]*$/)
      assert.equal(
        native.getWindowsProcessCreationTime(child.pid),
        native.getWindowsProcessCreationTime(child.pid)
      )
      assert.equal(native.getWindowsParentProcessId(child.pid), process.pid)
      const commandLine = native.getWindowsProcessCommandLine(child.pid)
      assert.ok(commandLine.endsWith('"arg with space" "\\"quoted\\"" ünïcode'), commandLine)
    } finally {
      child.stdin.end()
      await exited
    }
    // Node still holds the exited process handle, so the kernel object remains openable.
    assert.equal(native.getWindowsProcessCreationTime(child.pid), null)
    assert.equal(native.getWindowsProcessCommandLine(child.pid), null)
    assert.equal(native.getWindowsParentProcessId(child.pid), null)
  }
)

test('rejects invalid process identifiers', windows, () => {
  for (const pid of [0, -1, 1.5, 2 ** 33, Number.NaN, '1'])
    assert.throws(() => native.getWindowsProcessCreationTime(pid), TypeError)
})

test('lists the members of a retained owned Job', windows, async () => {
  const jobName = `Local\\OpenScience.Delegation.${randomUUID()}`
  const launched = native.spawnWindowsOwnedProcess(
    jobName,
    process.execPath,
    ['-e', 'setTimeout(()=>{},30000)'],
    Object.entries(process.env).map(([key, value]) => `${key}=${value}`),
    process.cwd(),
    false
  )
  try {
    assert.ok(native.windowsOwnedJobProcessIds(launched.handle).includes(launched.pid))
  } finally {
    assert.equal(native.reapWindowsOwnedJob(jobName), true)
    for (const fd of launched.fds) closeSync(fd)
  }
  assert.deepEqual(native.windowsOwnedJobProcessIds(launched.handle), [])
  assert.throws(() => native.windowsOwnedJobProcessIds({}), TypeError)
})

test('waits for an owned process exit without polling', windows, async () => {
  const jobName = `Local\\OpenScience.Delegation.${randomUUID()}`
  const launched = native.spawnWindowsOwnedProcess(
    jobName,
    process.execPath,
    ['-e', 'process.exit(7)'],
    Object.entries(process.env).map(([key, value]) => `${key}=${value}`),
    process.cwd(),
    false
  )
  try {
    const wait = native.windowsOwnedProcessExitCodeAsync(launched.handle)
    native.windowsOwnedProcessExitCodeUnref(launched.handle)
    native.windowsOwnedProcessExitCodeUnref(launched.handle)
    native.windowsOwnedProcessExitCodeRef(launched.handle)
    native.windowsOwnedProcessExitCodeRef(launched.handle)
    assert.equal(await wait, 7)
  } finally {
    native.reapWindowsOwnedJob(jobName)
    for (const fd of launched.fds) closeSync(fd)
  }
})

test(
  'lists Restart Manager users of installation files and the process snapshot',
  windows,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'process-tree-native-occupancy-'))
    const file = join(root, 'data ü.json')
    writeFileSync(file, '{}')
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `require('node:fs').openSync(${JSON.stringify(file)}, 'r');process.stdout.write('ready');process.stdin.resume()`
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    )
    const exited = once(holder, 'exit')
    try {
      await once(holder.stdout, 'data')
      assert.ok(native.listWindowsInstallationOccupants([file]).includes(holder.pid))
      assert.ok((await native.listWindowsInstallationOccupantsAsync([file])).includes(holder.pid))
      assert.deepEqual(native.listWindowsInstallationOccupants([]), [])
      const self = native.listWindowsProcesses().find((row) => row.pid === process.pid)
      assert.equal(self.executablePath.toLowerCase(), process.execPath.toLowerCase())
      const child = native.listWindowsProcesses().find((row) => row.pid === holder.pid)
      assert.equal(child.ppid, process.pid)
    } finally {
      holder.stdin.end()
      await exited
      rmSync(root, { recursive: true, force: true })
    }
    assert.throws(() => native.listWindowsInstallationOccupants(['']), TypeError)
    assert.throws(() => native.listWindowsInstallationOccupantsAsync('file'), TypeError)
  }
)

test(
  'returns every Restart Manager occupant after the initial result capacity is exceeded',
  windows,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'process-tree-native-many-occupants-'))
    const file = join(root, 'data.json')
    writeFileSync(file, '{}')
    const holders = []
    try {
      for (let index = 0; index < 33; index++) {
        const holder = spawn(
          process.execPath,
          [
            '-e',
            `require('node:fs').openSync(${JSON.stringify(file)}, 'r');process.stdout.write('ready');process.stdin.resume()`
          ],
          { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
        )
        holders.push(holder)
        await once(holder.stdout, 'data')
      }

      const occupants = native.listWindowsInstallationOccupants([file])
      assert.equal(
        holders.every((holder) => occupants.includes(holder.pid)),
        true,
        JSON.stringify({ expected: holders.map((holder) => holder.pid), occupants })
      )
    } finally {
      for (const holder of holders) holder.stdin.end()
      await Promise.all(holders.map((holder) => once(holder, 'exit')))
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('splits command lines with the Windows argv rules', windows, () => {
  assert.deepEqual(
    native.splitWindowsCommandLine(
      String.raw`"C:\a b\x.exe" "--database=C:\p q\Crashpad" a\"b "c""d" tail\\`
    ),
    // A doubled quote inside a quoted span emits one quote and stays in quoted mode.
    [String.raw`C:\a b\x.exe`, String.raw`--database=C:\p q\Crashpad`, 'a"b', 'c"d tail\\\\']
  )
  assert.throws(() => native.splitWindowsCommandLine(''), TypeError)
})

test('does not report terminated processes whose handles are still held', windows, async () => {
  const root = mkdtempSync(join(tmpdir(), 'process-tree-native-exited-'))
  const executable = join(root, 'node.exe')
  copyFileSync(process.execPath, executable)
  try {
    // Restart Manager keeps listing a killed process while a handle keeps its object alive; this
    // runtime holds the host handle, as terminateProcessTree's callers do. Repeat to cover timing.
    for (let round = 0; round < 5; round++) {
      const host = spawn(
        executable,
        [
          '-e',
          "const w=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(String(w.pid));setInterval(()=>{},1000)"
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
      const worker = Number((await once(host.stdout, 'data'))[0])
      const live = native.listWindowsInstallationOccupants([executable])
      assert.ok(live.includes(host.pid) && live.includes(worker), JSON.stringify(live))
      const killer = spawn('taskkill', ['/pid', String(host.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      await once(killer, 'exit')
      assert.deepEqual(native.listWindowsInstallationOccupants([executable]), [], `round ${round}`)
      assert.deepEqual(await native.listWindowsInstallationOccupantsAsync([executable]), [])
      if (host.exitCode === null && host.signalCode === null) await once(host, 'exit')
      host.stdout.destroy()
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200))
    rmSync(root, { recursive: true, force: true })
  }
})

for (const namespace of ['Delegation', 'Notebook'])
  test(
    `treats a ${namespace} process that exited with code 259 as missing while its handle is held`,
    windows,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'process-tree-native-exit259-'))
      const executable = join(root, 'node.exe')
      copyFileSync(process.execPath, executable)
      // 259 is STILL_ACTIVE: the exit code alone cannot prove that the process is still running.
      const jobName = `Local\\OpenScience.${namespace}.${randomUUID()}`
      const child = native.spawnWindowsOwnedProcess(
        jobName,
        executable,
        ['-e', 'process.exit(259)'],
        Object.entries(process.env).map(([key, value]) => `${key}=${value}`),
        process.cwd(),
        false
      )
      try {
        assert.equal(await native.windowsOwnedProcessExitCodeAsync(child.handle), 259)
        // The native external retains the process handle across every query, including async work.
        assert.equal(native.getWindowsProcessCreationTime(child.pid), null)
        assert.equal(native.getWindowsProcessCommandLine(child.pid), null)
        assert.equal(native.getWindowsParentProcessId(child.pid), null)
        assert.deepEqual(native.listWindowsInstallationOccupants([executable]), [])
        assert.deepEqual(await native.listWindowsInstallationOccupantsAsync([executable]), [])
        assert.equal(native.windowsOwnedProcessExitCode(child.handle), 259)
      } finally {
        native.reapWindowsOwnedJob(jobName)
        for (const fd of child.fds) closeSync(fd)
        await new Promise((resolve) => setTimeout(resolve, 200))
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
