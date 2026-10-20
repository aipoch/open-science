import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeProviderId, validateHostConnectionProfile } from '@aipoch/compute'
import { createComputeExecution, classifyFiles, resolveSshTarget } from '@aipoch/compute/node'

const require = createRequire(import.meta.url)
assert.equal(require('@aipoch/compute').computeProviderId('cluster'), computeProviderId('cluster'))
assert.equal(typeof require('@aipoch/compute/node').createComputeExecution, 'function')
assert.deepEqual(validateHostConnectionProfile({ sshAlias: ' cluster ', port: '22' }), {
  sshAlias: 'cluster',
  displayName: 'cluster',
  port: 22
})
assert.throws(() => validateHostConnectionProfile({ sshAlias: 'cluster', port: '22; rm' }))
for (const entry of ['src/index.js', 'dist/node.js', 'package.json']) {
  await assert.rejects(import(`@aipoch/compute/${entry}`), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  })
  assert.throws(() => require(`@aipoch/compute/${entry}`), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  })
}
// Each installed runtime owns its own leases; release is idempotent and waits for all holders.
const execution = createComputeExecution(),
  other = createComputeExecution()
const release = execution.holdDispatch('same-id'),
  second = execution.holdDispatch('same-id')
assert.equal(execution.isDispatching('same-id'), true)
assert.equal(other.isDispatching('same-id'), false)
let settled = false
const drained = execution.waitForDispatch(['same-id']).then(() => {
  settled = true
})
release()
release()
await Promise.resolve()
assert.equal(settled, false)
second()
await drained
assert.equal(settled, true)
// Real queue admission validates provider capacity with independently owned storage.
const jobs = {
  countActiveBySession: async () => 0,
  countActiveByProvider: async () => 1,
  countQueuedJobs: async () => 0
}
const queue = execution.createQueue({
  jobs,
  hosts: { get: async () => ({ concurrencyLimit: 1 }) },
  dispatch: async () => {
    throw Error('queued job must not dispatch')
  }
})
let committed
assert.equal(
  await queue.admit(
    { sessionId: 's', projectId: 'p', providerId: 'ssh:cluster' },
    async (status) => {
      committed = status
    }
  ),
  'queued'
)
assert.equal(committed, 'queued')
await queue.stopQueueReconciliation()
const target = await resolveSshTarget('cluster', undefined, async () => ({ user: 'scientist' }), {
  sshBinary: 'ssh'
})
assert.equal(target.host, 'cluster')
assert.ok(!target.extraArgs.some((x) => x.startsWith('ControlPath=')))
// Temporary state is caller-owned, not resolved relative to the build tree or process cwd.
const directory = await mkdtemp(join(tmpdir(), 'installed-compute-'))
try {
  const configured = await resolveSshTarget('cluster', undefined, async () => ({}), {
    sshBinary: 'ssh',
    controlDirectory: directory
  })
  if (process.platform !== 'win32')
    assert.ok(configured.extraArgs.some((x) => x.includes(directory)))
} finally {
  await rm(directory, { recursive: true, force: true })
}
assert.equal(typeof classifyFiles, 'function')
console.log('Compute packed CJS/ESM behavior and private exports passed')
