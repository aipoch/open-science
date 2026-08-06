import { diagnosticErrorFields, type Logger } from './logger'
import { BackendShutdownOutcomeError, type ShutdownStepOutcome } from './lifecycle-shutdown'

type Awaitable<T> = T | Promise<T>

export const APPLICATION_MODULE_DISPOSAL_BUDGET_MS = 1000

export class ApplicationModuleDisposalTimeoutError extends Error {
  constructor(
    readonly moduleName: string,
    readonly timeoutMs: number
  ) {
    super(`Application runtime module "${moduleName}" disposal exceeded ${timeoutMs}ms.`)
    this.name = 'ApplicationModuleDisposalTimeoutError'
  }
}

export type ApplicationModule<Capability> = {
  name?: string
  capability: Capability
  start?: () => Awaitable<void>
  // Releases a partially-constructed module before runtime ownership has been fully established.
  // When omitted, normal disposal is also safe for rollback.
  rollback?: () => Awaitable<void>
  dispose?: () => Awaitable<void>
  disposeTimeoutMs?: number
}

export type ApplicationModuleFactory<Dependencies, Capability> = (
  dependencies: Dependencies
) => Awaitable<ApplicationModule<Capability>>

export type ApplicationModuleBuilder = {
  add<Dependencies, Capability>(
    dependencies: Dependencies,
    factory: ApplicationModuleFactory<Dependencies, Capability>
  ): Promise<Capability>
}

export type ApplicationRuntime<Interfaces> = {
  readonly interfaces: Interfaces
  dispose(): Promise<void>
}

export type ApplicationSurfaceShutdown = {
  disposeApplicationRuntime(): Awaitable<void>
  shutdownRemoteAccess(): Awaitable<void>
  disposeWebController(): Awaitable<void>
  disposeIpcHandlers(): Awaitable<void>
  log?: Pick<Logger, 'error'>
}

export type ApplicationLifecycleShutdownDependencies = {
  disposeApplicationRuntime: ApplicationSurfaceShutdown['disposeApplicationRuntime']
  remoteAccess: { shutdown(): Awaitable<void> }
  webController: { dispose(): Awaitable<void> }
  disposeIpcHandlers: ApplicationSurfaceShutdown['disposeIpcHandlers']
  log?: ApplicationSurfaceShutdown['log']
}

// Direct Web/Task adapters close before the application command router, which in turn closes before
// its underlying RemoteAccess owner. Closing Web first can publish RemoteAccess's stopped state, but
// this path runs only while the app is quitting. A failed surface still cannot strand a later one.
export const shutdownApplicationSurfaces = async ({
  disposeApplicationRuntime,
  shutdownRemoteAccess,
  disposeWebController,
  disposeIpcHandlers,
  log
}: ApplicationSurfaceShutdown): Promise<ShutdownStepOutcome> => {
  const flattenErrors = (error: unknown): unknown[] =>
    error instanceof AggregateError ? error.errors.flatMap(flattenErrors) : [error]
  const classifyError = (error: unknown): Exclude<ShutdownStepOutcome, 'completed'> => {
    if (error instanceof BackendShutdownOutcomeError) return error.outcome
    if (error instanceof ApplicationModuleDisposalTimeoutError) return 'timeout'
    return 'failed'
  }
  const combineOutcomes = (
    current: ShutdownStepOutcome,
    next: ShutdownStepOutcome
  ): ShutdownStepOutcome => {
    const priority: Record<ShutdownStepOutcome, number> = {
      completed: 0,
      degraded: 1,
      timeout: 2,
      failed: 3
    }
    return priority[next] > priority[current] ? next : current
  }
  let overallOutcome: ShutdownStepOutcome = 'completed'
  const dispose = async (surface: string, operation: () => Awaitable<void>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      for (const cause of flattenErrors(error)) {
        const result = classifyError(cause)
        overallOutcome = combineOutcomes(overallOutcome, result)
        try {
          log?.error('application surface shutdown failed', {
            surface,
            result,
            ...diagnosticErrorFields(cause)
          })
        } catch {
          // A diagnostic sink failure must not prevent the remaining surfaces from closing.
        }
      }
    }
  }

  await dispose('web-controller', disposeWebController)
  await dispose('application-runtime', disposeApplicationRuntime)
  await dispose('remote-access', shutdownRemoteAccess)
  await dispose('ipc-handlers', disposeIpcHandlers)
  return overallOutcome
}

// Builds the exact callback passed to the Electron lifecycle. Requiring the application disposer here
// prevents index wiring from falling back to surface-only cleanup and orphaning backend ownership.
export const createApplicationLifecycleShutdown = ({
  disposeApplicationRuntime,
  remoteAccess,
  webController,
  disposeIpcHandlers,
  log
}: ApplicationLifecycleShutdownDependencies): (() => Promise<ShutdownStepOutcome>) => {
  return () =>
    shutdownApplicationSurfaces({
      disposeApplicationRuntime,
      shutdownRemoteAccess: () => remoteAccess.shutdown(),
      disposeWebController: () => webController.dispose(),
      disposeIpcHandlers,
      log
    })
}

export const withApplicationRuntimeShutdown = <Options extends object>(
  options: Options,
  dependencies: ApplicationLifecycleShutdownDependencies
): NoInfer<Options> & { shutdownBackends: () => Promise<ShutdownStepOutcome> } => ({
  ...options,
  shutdownBackends: createApplicationLifecycleShutdown(dependencies)
})

type OwnedModule = Pick<
  ApplicationModule<unknown>,
  'name' | 'dispose' | 'rollback' | 'disposeTimeoutMs'
>

class RuntimeModuleBuilder implements ApplicationModuleBuilder {
  private readonly modules: OwnedModule[] = []
  private disposePromise: Promise<void> | undefined
  private acceptingModules = true

  async add<Dependencies, Capability>(
    dependencies: Dependencies,
    factory: ApplicationModuleFactory<Dependencies, Capability>
  ): Promise<Capability> {
    if (!this.acceptingModules) {
      throw new Error('Application runtime composition is already complete.')
    }

    const module = await factory(dependencies)
    this.modules.push(module)
    await module.start?.()
    return module.capability
  }

  complete(): void {
    this.acceptingModules = false
  }

  dispose(mode: 'runtime' | 'rollback' = 'runtime'): Promise<void> {
    this.acceptingModules = false
    this.disposePromise ??= this.disposeModules(mode)
    return this.disposePromise
  }

  private async disposeModules(mode: 'runtime' | 'rollback'): Promise<void> {
    const failures: unknown[] = []
    for (const [index, module] of [...this.modules].reverse().entries()) {
      try {
        const dispose = mode === 'rollback' ? (module.rollback ?? module.dispose) : module.dispose
        if (dispose) {
          await this.disposeModule(
            module.name ?? `module-${this.modules.length - index}`,
            dispose,
            module.disposeTimeoutMs ?? APPLICATION_MODULE_DISPOSAL_BUDGET_MS
          )
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Application runtime disposal failed.')
    }
  }

  private async disposeModule(
    moduleName: string,
    dispose: () => Awaitable<void>,
    timeoutMs: number
  ): Promise<void> {
    const observed = Promise.resolve()
      .then(dispose)
      .then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
      timer.unref?.()
    })
    const outcome = await Promise.race([observed, timeout])
    if (timer) clearTimeout(timer)
    if (outcome.status === 'timeout') {
      throw new ApplicationModuleDisposalTimeoutError(moduleName, timeoutMs)
    }
    if (outcome.status === 'rejected') throw outcome.reason
  }
}

export const composeApplicationRuntime = async <Interfaces>(
  build: (modules: ApplicationModuleBuilder) => Awaitable<Interfaces>
): Promise<ApplicationRuntime<Interfaces>> => {
  const modules = new RuntimeModuleBuilder()
  try {
    const interfaces = await build(modules)
    modules.complete()
    return {
      interfaces,
      dispose: () => modules.dispose()
    }
  } catch (error) {
    try {
      await modules.dispose('rollback')
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'Application runtime construction and disposal failed.'
      )
    }
    throw error
  }
}

export const composeApplicationRuntimeWithAdapters = async <Interfaces extends object, Adapters>(
  createModules: (
    modules: ApplicationModuleBuilder
  ) => Awaitable<Interfaces & { electronAdapters: Adapters }>,
  installAdapters: (adapters: Adapters) => Awaitable<void | { uninstall(): Awaitable<void> }>
): Promise<ApplicationRuntime<Interfaces>> =>
  composeApplicationRuntime(async (modules) => {
    const built = await createModules(modules)
    const installation = await installAdapters(built.electronAdapters)
    if (installation) {
      await modules.add(installation, (installed) => ({
        name: 'electron-runtime-adapters',
        capability: undefined,
        rollback: () => installed.uninstall(),
        dispose: () => installed.uninstall()
      }))
    }
    const { electronAdapters: _electronAdapters, ...interfaces } = built
    void _electronAdapters
    return interfaces as Interfaces
  })
