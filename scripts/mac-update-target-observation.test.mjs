import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertRuntimeOwner,
  assertBackendDescendant,
  assertStartupSettled
} from './mac-update-target-observation.mjs'

const expected = { profile: '/test/profile-B', configRoot: '/test/data', targetVersion: '2.0.0' }
const ownerRecord = { pid: 22, generation: 'new-runtime' }
const owner = {
  ...ownerRecord,
  lifetime: { apps: 1, stopping: false },
  startupOptions: { profilePath: expected.profile, configRoot: expected.configRoot }
}
const bootstrap = { configRoot: expected.configRoot, appVersion: '2.0.0', platform: 'darwin' }
test('live authenticated owner proves the actual initiating profile instead of echoing expected path', () => {
  assert.doesNotThrow(() => assertRuntimeOwner(ownerRecord, owner, bootstrap, expected))
  assert.throws(() =>
    assertRuntimeOwner(ownerRecord, { ...owner, lifetime: { apps: 0 } }, bootstrap, expected)
  )
  assert.throws(() =>
    assertRuntimeOwner(
      ownerRecord,
      { ...owner, startupOptions: { ...owner.startupOptions, profilePath: '/test/profile-A' } },
      bootstrap,
      expected
    )
  )
  assert.throws(() =>
    assertRuntimeOwner(ownerRecord, { ...owner, generation: 'old-runtime' }, bootstrap, expected)
  )
  assert.throws(() =>
    assertRuntimeOwner(ownerRecord, { ...owner, stopping: true }, bootstrap, expected)
  )
  assert.throws(() =>
    assertRuntimeOwner(ownerRecord, owner, { ...bootstrap, appVersion: '1.0.0' }, expected)
  )
})

test('backend from another installation or stale PID ancestry cannot prove target readiness', () => {
  const root = '/test/Science.app'
  const candidate = { pid: 11, executable: root + '/Contents/MacOS/main' }
  const main = { pid: 11, uniqueId: 'main-generation', ppid: 1, parentUniqueId: 'launchd' }
  const backend = {
    pid: 22,
    uniqueId: 'backend-generation',
    ppid: 11,
    parentUniqueId: main.uniqueId
  }
  const rows = new Map([
    [11, main],
    [22, backend]
  ])
  let backendExecutable = root + '/Contents/Resources/node'
  const native = {
    getDarwinProcess: (pid) => rows.get(pid),
    getDarwinProcessExecutable: (pid) => (pid === 11 ? candidate.executable : backendExecutable)
  }
  assert.equal(assertBackendDescendant(native, candidate, 22, root).backendPid, 22)
  backendExecutable = '/other/Science.app/Contents/Resources/node'
  assert.throws(() => assertBackendDescendant(native, candidate, 22, root))
  backendExecutable = root + '/Contents/Resources/node'
  rows.set(22, { ...backend, parentUniqueId: 'reused-pid' })
  assert.throws(() => assertBackendDescendant(native, candidate, 22, root))
  rows.delete(11)
  assert.throws(() => assertBackendDescendant(native, candidate, 22, root))
})

test('a visible Desktop with healthy backend/data cannot pass while verified startup is pending', () => {
  const target = { ...expected, appBundle: '/test/Science.app' }
  const admission = {
    record: {
      operationId: 'observed-operation',
      installationRoot: target.appBundle,
      targetVersion: target.targetVersion,
      requestSha256: 'observed-hash'
    },
    request: { profilePath: target.profile, startupOptions: { configRoot: target.configRoot } }
  }
  // Backend owner/data and a native window can all be healthy while Desktop displays a blocked
  // startup error. Only the product's successful verified startup chain clears its own ticket.
  assert.doesNotThrow(() => assertRuntimeOwner(ownerRecord, owner, bootstrap, target))
  assert.throws(
    () => assertStartupSettled(admission, undefined, { operationId: 'observed-operation' }, target),
    /not completed/
  )
  assert.throws(() => assertStartupSettled(undefined, undefined, undefined, target), /No observed/)
  assert.throws(
    () =>
      assertStartupSettled(admission, { operationId: 'different-operation' }, undefined, target),
    /Another update/
  )
  assert.deepEqual(assertStartupSettled(admission, undefined, undefined, target), {
    operationId: 'observed-operation',
    requestSha256: 'observed-hash'
  })
})

test('a previously verified target backend may be adopted only with the same live birth identity', () => {
  const appBundle = '/isolated/Runtime.app'
  const candidate = { pid: 50, executable: appBundle + '/Contents/MacOS/main' }
  const rows = new Map([
    [50, { pid: 50, uniqueId: 'new-desktop', ppid: 1, parentUniqueId: 'launchd' }],
    [22, { pid: 22, uniqueId: 'verified-backend', ppid: 1, parentUniqueId: 'launchd' }]
  ])
  const backendExecutable = appBundle + '/Contents/Resources/node'
  const native = {
    getDarwinProcess: (pid) => rows.get(pid),
    getDarwinProcessExecutable: (pid) => (pid === 50 ? candidate.executable : backendExecutable)
  }
  assert.throws(() => assertBackendDescendant(native, candidate, 22, appBundle))
  const prior = { backendPid: 22, backendUniqueId: 'verified-backend', backendExecutable }
  assert.equal(
    assertBackendDescendant(native, candidate, 22, appBundle, prior)
      .adoptedAfterVerifiedTargetInterruption,
    true
  )
  rows.set(22, { ...rows.get(22), uniqueId: 'reused-pid' })
  assert.throws(() => assertBackendDescendant(native, candidate, 22, appBundle, prior))
})
