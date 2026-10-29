/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the native binding with Node's CommonJS test runner. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { getDarwinProcessArguments, getDarwinProcess } = require('..')

test(
  'reads native argv without splitting spaces, option text or empty arguments',
  { skip: process.platform !== 'darwin' },
  async () => {
    const args = [
      '--database=/profiles/current --backup/Crashpad',
      '',
      'quotes " and backslash \\',
      '--annotation=openScienceInstance=test'
    ]
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready");process.stdin.resume()', '--', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const exited = once(child, 'exit')
    try {
      await once(child.stdout, 'data')
      const parentIdentity = getDarwinProcess(process.pid)
      const childIdentity = getDarwinProcess(child.pid)
      assert.match(parentIdentity.coalitionId, /^[1-9][0-9]*$/)
      assert.equal(childIdentity.coalitionId, parentIdentity.coalitionId)
      assert.deepEqual(getDarwinProcessArguments(child.pid).slice(-args.length), args)
      assert.equal(getDarwinProcessArguments(-1), null)
    } finally {
      child.stdin.end()
      await exited
    }
    assert.equal(getDarwinProcessArguments(child.pid), null)
  }
)
