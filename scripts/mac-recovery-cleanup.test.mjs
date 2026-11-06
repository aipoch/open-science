import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupOwnedFixture } from './fixtures/mac-recovery-entry/cleanup-owned.mjs'

for (const pathAfterSnapshot of [undefined, '/another-installation/app']) {
  test(`never declares a same-generation live fixture gone when its path is ${pathAfterSnapshot}`, async () => {
    let reads = 0
    let signaled = false
    const row = { pid: 12345, uniqueId: 'fixture-generation' }
    const native = {
      listDarwinProcesses: () => ({ complete: true, processes: [row] }),
      getDarwinProcess: () => row,
      getDarwinProcessExecutable: () =>
        reads++ === 0 ? '/unique-fixture-root/app' : pathAfterSnapshot,
      signalDarwinProcess: () => {
        signaled = true
      }
    }
    await assert.rejects(
      cleanupOwnedFixture('/unique-fixture-root', native),
      /still alive.*preserving/
    )
    assert.equal(signaled, false)
  })
}
