import { resolve } from 'node:path'
import { NotebookNetworkSandbox } from '../../../../packages/notebook-network-sandbox/src/index'
import { NotebookNetworkRuntime } from '../../../../packages/notebook-network-sandbox/runtime/src/index'
import type { NotebookProcessSandbox } from '../process-sandbox'

// Source tests select standard mode through the public sandbox seam. The production supervisor
// still supplies every Job proof and cleanup result; no protected-runtime fixture is fabricated.
export async function createWindowsStandardProcessSandbox(): Promise<{
  port: NotebookProcessSandbox
  dispose: () => Promise<void>
}> {
  await NotebookNetworkRuntime.reset()
  const sandbox = new NotebookNetworkSandbox({
    resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
    policy: { allowedDomains: [], deniedDomains: [] }
  })
  return {
    port: {
      resolveWindowsRuntime: async () => null,
      wrap: async (invocation) => {
        await sandbox.initialize()
        const wrapped = await sandbox.wrap({
          command: '',
          executable: invocation.executable,
          args: invocation.args,
          cwd: invocation.cwd,
          env: invocation.env,
          superviseProcessTree: invocation.superviseProcessTree,
          windowsShellControlPipe: invocation.windowsShellControlPipe,
          filesystem: invocation.filesystem,
          onNetworkAccessRequest: async () => false
        })
        return {
          executable: wrapped.argv[0],
          args: wrapped.argv.slice(1),
          env: wrapped.env,
          processTreeProof: wrapped.processTreeProof,
          confirmProcessTreeTermination: wrapped.confirmProcessTreeTermination,
          requestProcessTreeTermination: wrapped.requestProcessTreeTermination,
          confirmProcessState: wrapped.confirmProcessState,
          beginSpawn: wrapped.beginSpawn,
          annotateStderr: wrapped.annotateStderr,
          cleanup: wrapped.cleanup
        }
      }
    },
    dispose: async () => {
      try {
        await sandbox.dispose()
      } finally {
        await NotebookNetworkRuntime.reset()
      }
    }
  }
}
