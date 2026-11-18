/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the native binding through Node's public package entry. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const native = require('..')

test('reads a current macOS pressure level or returns explicit unsupported evidence', async () => {
  assert.equal(typeof native.sampleDarwinMemoryPressure, 'function')
  assert.equal(typeof native.subscribeDarwinMemoryPressure, 'function')
  assert.equal(typeof native.darwinMemoryPressureEventSequence, 'function')
  const subscription = native.subscribeDarwinMemoryPressure(() => {})
  try {
    const result = await native.sampleDarwinMemoryPressure()
    if (process.platform !== 'darwin') {
      assert.equal(subscription, null)
      assert.equal(result.supported, false)
      assert.equal(result.pressureLevel, undefined)
      return
    }
    assert.ok(subscription)
    assert.equal(result.supported, true)
    assert.equal(result.complete, true)
    assert.ok([1, 2, 4].includes(result.pressureLevel))
    assert.ok(Number.isSafeInteger(result.eventSequence))
    assert.ok(Number.isSafeInteger(result.pressureEventSequence))
    assert.equal(result.eventSequence, native.darwinMemoryPressureEventSequence())
  } finally {
    if (subscription) {
      native.stopDarwinMemoryPressureSubscription(subscription)
      native.stopDarwinMemoryPressureSubscription(subscription)
    }
  }
})

test('an active unreferenced subscription permits clean runtime shutdown', () => {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(require.resolve('..'))}).subscribeDarwinMemoryPressure(() => {})`
    ],
    {
      timeout: 5000,
      encoding: 'utf8'
    }
  )
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.signal, null)
})

test('bounds native subscription lifetime and rejects invalid subscription requests', () => {
  assert.throws(() => native.subscribeDarwinMemoryPressure('not a callback'), TypeError)
  assert.throws(() => native.stopDarwinMemoryPressureSubscription({}), TypeError)
  for (let index = 0; index < 20; index++) {
    const subscription = native.subscribeDarwinMemoryPressure(() => {})
    if (subscription) native.stopDarwinMemoryPressureSubscription(subscription)
  }
})
