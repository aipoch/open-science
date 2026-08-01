type Awaitable<T> = T | Promise<T>

export type ApplicationModule<Capability> = {
  capability: Capability
  start?: () => Awaitable<void>
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

type OwnedModule = Pick<ApplicationModule<unknown>, 'dispose'>

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

  dispose(): Promise<void> {
    this.acceptingModules = false
    this.disposePromise ??= this.disposeModules()
    return this.disposePromise
  }

  private async disposeModules(): Promise<void> {
    const failures: unknown[] = []
    for (const module of [...this.modules].reverse()) {
      try {
        await module.dispose?.()
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
      await modules.dispose()
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'Application runtime construction and disposal failed.'
      )
    }
    throw error
  }
}
