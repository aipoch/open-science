import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertVerifiedReadyPause } from './mac-update-stale-startup-scenario.mjs'

test('installed-before-launch is not a verified-ready stale ticket', () => {
  const expected = {
    operationId: 'update',
    appBundle: '/isolated/Runtime.app',
    profile: '/original-profile',
    startedAt: 10
  }
  const receipt = {
    phase: 'verified-ready-before-cleanup',
    operationId: 'update',
    installationRoot: expected.appBundle,
    profilePath: expected.profile,
    pid: 42,
    time: 11
  }
  const ticket = { operationId: 'update' }
  assert.doesNotThrow(() => assertVerifiedReadyPause(receipt, ticket, expected))
  for (const changed of [
    { phase: 'native-recovery-installed' },
    { operationId: 'other' },
    { profilePath: '/wrong' },
    { pid: 0 },
    { time: 9 }
  ])
    assert.throws(() => assertVerifiedReadyPause({ ...receipt, ...changed }, ticket, expected))
  assert.throws(() => assertVerifiedReadyPause(receipt, undefined, expected))
  assert.throws(() => assertVerifiedReadyPause(receipt, { operationId: 'other' }, expected))
})
