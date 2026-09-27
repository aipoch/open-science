import type { ApplicationModuleBuilder } from '../application-runtime'
import {
  createApplicationCommandComposition,
  type ApplicationCommandComposition,
  type ApplicationCommandCompositionDependencies
} from '../application-command-composition'
import { registerApplicationCommandElectronAdapter } from '../application-command-electron-adapter'

type ApplicationCommandCompositionRegistration = Readonly<{
  modules: ApplicationModuleBuilder
  dependencies: ApplicationCommandCompositionDependencies
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
}>

export const registerApplicationCommandComposition = async ({
  modules,
  dependencies,
  declareElectronAdapter
}: ApplicationCommandCompositionRegistration): Promise<ApplicationCommandComposition> => {
  const applicationCommandComposition = await modules.add(dependencies, (moduleDependencies) => {
    const capability = createApplicationCommandComposition(moduleDependencies)
    return {
      name: 'application-command-composition',
      capability,
      dispose: () => capability.dispose()
    }
  })
  declareElectronAdapter('application-projects', () =>
    registerApplicationCommandElectronAdapter(applicationCommandComposition.electron)
  )
  return applicationCommandComposition
}
