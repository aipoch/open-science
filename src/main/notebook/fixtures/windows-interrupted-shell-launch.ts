// Run in a disposable Windows process: the harmless workload deliberately ends its owning application.
import { join } from 'node:path'
import { NotebookShellProcessAdapter } from '../shell-process'
import { ShellProcessOwnershipRegistry } from '../shell-process-ownership.windows-posix'
import { windowsSupervisedLaunch } from '../../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'

const [root, hostPath, processHostPath] = process.argv.slice(2)
if (!root || !hostPath || !processHostPath) throw new Error('Missing isolated fixture paths')
const marker = join(root, 'workload-started')
const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.kill(${process.pid});`
const registry = new ShellProcessOwnershipRegistry(root, {
  processHostPath,
  processStartIdentity: () => {
    // Keep the old parent-owned identity query in flight until the workload interrupts the owner.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)
    return undefined
  }
})
const adapter = new NotebookShellProcessAdapter(
  'win32',
  {
    wrap: async (invocation) => {
      const launch = windowsSupervisedLaunch({
        executable: process.execPath,
        args: ['-e', code],
        command: '',
        cwd: root,
        env: { ...invocation.env, TEMP: root, ELECTRON_RUN_AS_NODE: '1' },
        gatewayPort: 1,
        gatewayCredentials: { username: 'unused', password: 'unused' },
        hostPath
      })
      return {
        executable: launch.argv[0],
        args: launch.argv.slice(1),
        env: launch.env,
        confirmProcessTreeTermination: launch.confirmProcessTreeTermination,
        annotateStderr: (stderr) => stderr,
        cleanup: async (_reason, outcome) => ({
          processesTerminated: outcome.processesTerminated,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
      }
    }
  },
  registry
)
void adapter
  .execute({
    runId: 'notebook-run-interrupted-owner',
    command: 'interrupt isolated fixture owner',
    cwd: root,
    handoffDir: root,
    runtimeRoot: root,
    projectId: 'project',
    sessionId: 'session',
    runtimeBinding: { kind: 'powershell', version: '5.1' },
    timeoutMs: 15_000
  })
  .then(() => {
    throw new Error('The fixture owner should have been interrupted')
  })
