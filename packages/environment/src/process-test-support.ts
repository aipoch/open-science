import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInstallSpawn } from './package-manager'
import { createExecutableVerifier, createMicromambaExecutor } from './provisioner-runtime'

// These fixtures launch only a single Node process. Production tree ownership is a host contract;
// environment tests exercise cancellation, journaling and result handling through this capability.
const terminateTree = async (child: ChildProcess): Promise<{ reaped: boolean }> => {
  if (child.exitCode !== null || child.signalCode !== null) return { reaped: false }
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
  return { reaped: true }
}
export const defaultSpawn = createInstallSpawn({
  createOwnership: (env) => ({ env, token: undefined }),
  trackOwnership: () => undefined,
  terminateTree
})
export const runMicromamba = createMicromambaExecutor({ terminateTree })
export const verifyExecutable = createExecutableVerifier(runMicromamba)
