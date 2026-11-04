/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the native binding with Node's CommonJS test runner. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { sampleWindowsResources, readWindowsResourceBirth } = require('..')

test('returns Windows resource evidence or explicitly unsupported metrics', async () => {
  assert.equal(typeof sampleWindowsResources, 'function')
  assert.equal(typeof readWindowsResourceBirth, 'function')
  const systemOnly = await sampleWindowsResources(false, [])
  const family = await sampleWindowsResources(true, [])
  assert.deepEqual(systemOnly.processes, [])
  assert.ok(Number.isFinite(systemOnly.startedAt))
  assert.ok(Number.isFinite(systemOnly.endedAt))
  assert.equal(readWindowsResourceBirth(0), null)
  if (process.platform !== 'win32') {
    for (const result of [systemOnly, family]) {
      assert.equal(result.supported, false)
      assert.equal(result.system, undefined)
      assert.deepEqual(result.processes, [])
    }
    assert.equal(readWindowsResourceBirth(process.pid), null)
    return
  }
  assert.equal(systemOnly.supported, true)
  assert.ok(systemOnly.system.committedBytes > 0)
  assert.ok(systemOnly.system.commitLimitBytes >= systemOnly.system.committedBytes)
  assert.equal(family.supported, true)
  const self = family.processes.find((entry) => entry.pid === process.pid)
  assert.ok(self)
  assert.match(self.birth, /^\d{17,20}$/)
  assert.equal(self.birth, readWindowsResourceBirth(process.pid))
  assert.ok(self.privateBytes > 0)
  assert.ok(self.workingSetBytes > 0)
  assert.ok(self.handleCount > 0)
})

test('accepts the identity limit and rejects malformed or oversized requests', async () => {
  const identities = Array.from({ length: 4096 }, () => ({ pid: 1, birth: '1' }))
  assert.deepEqual((await sampleWindowsResources(false, identities)).processes, [])
  assert.throws(() => sampleWindowsResources('yes', []), TypeError)
  for (const birth of ['', '1e20', '1'.repeat(21)]) {
    assert.throws(() => sampleWindowsResources(true, [{ pid: process.pid, birth }]), TypeError)
  }
  assert.throws(() => sampleWindowsResources(true, [{ pid: 0, birth: '1' }]), TypeError)
  assert.throws(
    () => sampleWindowsResources(true, [...identities, { pid: 1, birth: '1' }]),
    TypeError
  )
})

test(
  'verifies a Windows child identity and drops it after exit',
  { skip: process.platform !== 'win32' },
  async () => {
    // Self-expiry also bounds the fixture if the test controller is forcibly stopped.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    let observed
    try {
      await once(child, 'spawn')
      const sample = await sampleWindowsResources(true, [])
      observed = sample.processes.find((entry) => entry.pid === child.pid)
      assert.ok(observed)
      assert.equal(observed.parentPid, process.pid)
      assert.equal(observed.birth, readWindowsResourceBirth(child.pid))
      assert.match(observed.birth, /^\d{17,20}$/)
    } finally {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
    const final = await sampleWindowsResources(true, [{ pid: child.pid, birth: observed.birth }])
    assert.equal(
      final.processes.some((entry) => entry.pid === child.pid && entry.birth === observed.birth),
      false
    )
  }
)
