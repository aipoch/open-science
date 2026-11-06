import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configureRuntimeMetadata } from '../../runtime-metadata'
import {
  RuntimeDirectoryOwnership,
  configureRuntimeDirectoryOwnership
} from '../../runtime-ownership'
import { NotebookRuntimeService } from '../../notebook/runtime-service'
import { NotebookRunRepository } from '../../notebook/repository'
import { NotebookNetworkSandboxOwner } from '../../notebook/network-sandbox-owner'
import { NotebookKernelExecutor } from '../../notebook/kernel-executor'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../../shared/notebook-network'

const [root, repository, app] = process.argv.slice(2)
if (!root || !repository || !app)
  throw new Error('Explicit isolated root, application and source repository are required')
configureRuntimeMetadata(() => ({
  version: 'fixture',
  locale: 'en-US',
  packaged: false,
  applicationPath: repository,
  homePath: root,
  downloadsPath: root,
  resourcesPath: join(repository, 'resources')
}))
const ownership = new RuntimeDirectoryOwnership()
configureRuntimeDirectoryOwnership({
  acquireSync: (directory) => ownership.acquireSync(directory),
  acquire: (directory) => ownership.acquire(directory)
})
const sandbox = new NotebookNetworkSandboxOwner({
  resourceRoot: join(repository, 'packages/notebook-network-sandbox/vendor'),
  temporaryRoot: join(root, 'sandbox'),
  getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  requestDecision: async () => 'deny'
})
const python = '/usr/bin/python3'
const workspace = join(root, 'workspace')
const runtime = new NotebookRuntimeService({
  configRoot: join(root, 'config'),
  dataRoot: join(root, 'data'),
  projectId: 'native-close',
  repository: new NotebookRunRepository(join(root, 'data')),
  processSandbox: sandbox,
  backgroundExecutionEnabled: true,
  discoverRuntimes: async (language) =>
    language === 'python'
      ? [
          {
            language,
            provenance: 'user-own',
            envId: python,
            interpreterPath: python,
            label: python,
            version: 'system',
            runnable: true
          }
        ]
      : [],
  notebookRuntimeSettings: {
    getSnapshot: async (language) => ({
      language,
      runtimeEnablement: { enabled: { [python]: true }, installAuthorized: {} },
      manualInterpreters: [],
      packageMirror: {}
    })
  },
  executorFactory: (_session, lifecycle) =>
    new NotebookKernelExecutor({
      pythonLoopPath: join(app, 'Contents/Resources/resources/notebook/python_loop.py'),
      rLoopPath: join(app, 'Contents/Resources/resources/notebook/r_loop.R'),
      replLoopPath: join(app, 'Contents/Resources/resources/notebook/repl_loop.js'),
      processSandbox: sandbox,
      onTerminated: (kind, env) => void lifecycle.onTerminated(kind, env),
      onIdleShutdown: (kind, env) => void lifecycle.onIdleShutdown(kind, env)
    })
})
const scope = (kind: string): { projectId: string; sessionId: string; workspaceCwd: string } => ({
  projectId: 'native-close',
  sessionId: kind,
  workspaceCwd: workspace
})
async function main(): Promise<void> {
  await mkdir(root, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await runtime.bindRuntime({ ...scope('python'), language: 'python', runtimeId: python })
  const states = await Promise.all(
    ['python', 'repl', 'bash'].map((kind) => runtime.state(scope(kind)))
  )
  const paths = states.map((state, index) =>
    join(state.dataRoot, ['python', 'repl', 'shell'][index] + '.json')
  )
  const submissions = [
    await runtime.executeBackground({
      ...scope('python'),
      language: 'python',
      background: true,
      code: `import os,json,time\nwith open(${JSON.stringify(paths[0])},"w") as f: json.dump({"pid":os.getpid()},f)\ntime.sleep(300)`
    }),
    await runtime.executeControlBackground({
      ...scope('repl'),
      background: true,
      code: `require("node:fs").writeFileSync(${JSON.stringify(paths[1])},JSON.stringify({pid:process.pid})); await new Promise(resolve=>setTimeout(resolve,300000));`
    }),
    await runtime.executeShellBackground({
      ...scope('bash'),
      background: true,
      command: `printf '{"pid":%s}\\n' "$$" > ${JSON.stringify(paths[2])}; sleep 300`
    })
  ]
  for (let attempt = 0; attempt < 600; attempt++) {
    const statuses = await Promise.all(
      submissions.map((entry, index) =>
        runtime.getBackgroundRun({
          ...scope(['python', 'repl', 'bash'][index]),
          runId: entry.runId
        })
      )
    )
    if (statuses.some((entry) => entry.run?.status === 'failed'))
      throw new Error(
        'Real task failed before witness: ' +
          JSON.stringify(
            statuses.map((entry) => ({
              status: entry.run?.status,
              traceback: entry.run?.text.traceback
            }))
          )
      )
    try {
      const witnesses = await Promise.all(
        paths.map(async (path) => JSON.parse(await readFile(path, 'utf8')))
      )
      await writeFile(join(root, 'ready.json'), JSON.stringify({ submissions, witnesses }))
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('Real workload witnesses were not produced')
}
void main().catch(async (error) => {
  console.error(error.stack)
  await runtime.dispose().catch(() => undefined)
  await sandbox.dispose().catch(() => undefined)
  await ownership.close()
  process.exit(1)
})
setInterval(() => {}, 1000)
