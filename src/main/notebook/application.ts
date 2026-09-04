import type { ApplicationEventPublisher } from '../application-events'
import type { ApplicationModule } from '../application-runtime'
import type { NotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import type { NotebookLocalRpcCapability } from './local-rpc-notebook-adapter'
import { createNotebookCommandWorkflows, type NotebookCommandWorkflows } from './notebook-workflows'
import { NotebookRuntimeService, type NotebookRuntimeServiceOptions } from './runtime-service'
import type { ProjectIdScope } from '../../shared/project-scope'

type NotebookApplicationDeps = Pick<
  NotebookRuntimeServiceOptions,
  | 'configRoot'
  | 'dataRoot'
  | 'repository'
  | 'getPackageMirror'
  | 'notebookRuntimeSettings'
  | 'micromambaRunner'
  | 'locale'
  | 'appVersion'
  | 'translate'
  | 'helperModuleCatalog'
  | 'processSandbox'
> &
  ProjectIdScope & {
    events: ApplicationEventPublisher
  }

type NotebookApplication = {
  // Retained as the internal compatibility surface while later Notebook slices narrow remaining
  // application integrations. New transports consume the purpose-built capabilities below.
  runtime: NotebookRuntimeService
  commands: NotebookCommandWorkflows
  localRpc: NotebookLocalRpcCapability
}

type NotebookApplicationModuleDeps = NotebookApplicationDeps & {
  disposeTimeoutMs: number
  isBackendTeardownOwned: () => boolean
}

type NotebookLocalRpcLifecycle = {
  close(): Promise<void>
}

// Owns the single Notebook runtime generation and projects the narrow capabilities consumed by each
// transport. Host metadata and publication are injected so this module has no Electron or ACP
// dependency and cannot become a second renderer/event owner.
const createNotebookApplication = (deps: NotebookApplicationDeps): NotebookApplication => {
  const { events, ...runtimeOptions } = deps
  const runtime = new NotebookRuntimeService({
    ...runtimeOptions,
    callbacks: {
      onNotebookAvailable: (event) => events.publish('notebook:available', event),
      onNotebookChanged: (event) => events.publish('notebook:changed', event)
    }
  })
  const localRpc: NotebookLocalRpcCapability = runtime

  return {
    runtime,
    commands: createNotebookCommandWorkflows(runtime),
    localRpc
  }
}

// Partial construction has no coordinator to finish teardown, so rollback terminally disposes the
// runtime. Normal shutdown deliberately has no module disposer: the later-owned backend coordinator
// remains the sole owner and runs before supporting modules are released in reverse order.
const createNotebookApplicationModule = (
  deps: NotebookApplicationModuleDeps
): ApplicationModule<NotebookApplication> => {
  const { disposeTimeoutMs, isBackendTeardownOwned, ...applicationDeps } = deps
  const application = createNotebookApplication(applicationDeps)

  return {
    name: 'notebook-runtime',
    capability: application,
    disposeTimeoutMs,
    rollback: () =>
      isBackendTeardownOwned() ? undefined : application.runtime.dispose().then(() => undefined)
  }
}

// The local server remains an integration adapter constructed by the application root. This small
// descriptor only certifies lifecycle ownership: close on rollback and after later backends drain.
const createNotebookLocalRpcModule = <Server extends NotebookLocalRpcLifecycle>(
  server: Server
): ApplicationModule<Server> => ({
  name: 'notebook-local-rpc',
  capability: server,
  rollback: () => server.close(),
  dispose: () => server.close()
})

// Transport registration must complete before startup can publish progress or accept cancellation.
// Keeping this order in one tested composition seam prevents adapters from recreating the lifecycle.
const installNotebookEnvironmentSurface = (
  lifecycle: NotebookEnvironmentLifecycle,
  register: (lifecycle: NotebookEnvironmentLifecycle) => void
): Promise<void> => {
  register(lifecycle)
  return lifecycle.startup()
}

export {
  createNotebookApplication,
  createNotebookApplicationModule,
  createNotebookLocalRpcModule,
  installNotebookEnvironmentSurface
}
export type {
  NotebookApplication,
  NotebookApplicationDeps,
  NotebookApplicationModuleDeps,
  NotebookLocalRpcLifecycle
}
