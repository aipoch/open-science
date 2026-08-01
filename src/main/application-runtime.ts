type Awaitable<T> = T | Promise<T>

export type ApplicationModule<Capability> = {
  capability: Capability
  start?: () => Awaitable<void>
  // Releases a partially-constructed module before runtime ownership has been fully established.
  // When omitted, normal disposal is also safe for rollback.
  rollback?: () => Awaitable<void>
  dispose?: () => Awaitable<void>
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
  closeWebController(): Awaitable<void>
  disposeWebRpc(): Awaitable<void>
}

// Preserves the desktop quit order while guaranteeing that a failed surface cannot strand a later
// one. Backend shutdown is owned by the application runtime and remains bounded by its coordinator.
export const shutdownApplicationSurfaces = async ({
  disposeApplicationRuntime,
  shutdownRemoteAccess,
  closeWebController,
  disposeWebRpc
}: ApplicationSurfaceShutdown): Promise<void> => {
  try {
    await disposeApplicationRuntime()
  } finally {
    try {
      await shutdownRemoteAccess()
    } finally {
      try {
        await closeWebController()
      } finally {
        await disposeWebRpc()
      }
    }
  }
}

type OwnedModule = Pick<ApplicationModule<unknown>, 'dispose' | 'rollback'>

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
    for (const module of [...this.modules].reverse()) {
      try {
        await (mode === 'rollback' ? (module.rollback ?? module.dispose)?.() : module.dispose?.())
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Application runtime disposal failed.')
    }
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
