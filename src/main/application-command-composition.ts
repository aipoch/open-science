import { RENDERER_CONTRACT_CATALOG } from '../shared/renderer-contract-catalog'
import {
  acpApplicationCommands,
  registerAcpCommands,
  type AcpApplicationCommandDependencies
} from './acp/application-commands'
import {
  createApplicationCommandRouter,
  type ApplicationCommand,
  type ApplicationCommandDiagnostic,
  type ApplicationCommandInstallation,
  type ApplicationInvocation
} from './application-command-router'
import {
  computeApplicationCommandGroup,
  registerComputeApplicationCommands,
  type ComputeApplicationCommandDependencies
} from './compute/application-commands'
import {
  dataContentApplicationCommandGroups,
  registerDataContentApplicationCommands,
  type DataContentApplicationCommandDependencies
} from './data-content-application-commands'
import {
  hostApplicationCommandGroups,
  registerHostApplicationCommands,
  type HostApplicationCommandDependencies
} from './host-application-commands'
import {
  installNotebookApplicationCommands,
  notebookApplicationCommands,
  type NotebookApplicationCommandDependencies
} from './notebook/application-commands'
import {
  installNotebookEnvironmentApplicationCommands,
  notebookEnvironmentApplicationCommands
} from './notebook/environment-application-commands'
import {
  registerRuntimeApplicationCommands,
  runtimeApplicationCommandGroup,
  type RuntimeApplicationCommandDependencies
} from './notebook/runtime-application-commands'
import {
  permissionGrantApplicationCommandGroup,
  registerPermissionGrantApplicationCommands
} from './permission-grants/application-commands'
import {
  registerCoreSettingsApplicationCommands,
  settingsCoreApplicationCommandGroup,
  type CoreSettingsApplicationCommandDependencies
} from './settings/application-commands'
import {
  registerIntegrationSettingsApplicationCommands,
  settingsApprovalApplicationCommandGroup,
  settingsConnectorApplicationCommandGroup,
  settingsSkillApplicationCommandGroup,
  type IntegrationSettingsApplicationCommandDependencies
} from './settings/integration-application-commands'
import {
  registerRuntimeSettingsApplicationCommands,
  settingsRuntimeApplicationCommandGroup,
  type RuntimeSettingsApplicationCommandDependencies
} from './settings/runtime-application-commands'

type AnyApplicationCommand = ApplicationCommand<string, readonly unknown[], unknown>
type NotebookEnvironmentDependencies = Parameters<
  typeof installNotebookEnvironmentApplicationCommands
>[1]
type PermissionGrantDependencies = Parameters<typeof registerPermissionGrantApplicationCommands>[1]
type RemoteAccessOwner = HostApplicationCommandDependencies['remoteAccess']

type ApplicationCommandByNameDispatcher = Readonly<{
  invoke: (
    commandName: string,
    invocation: ApplicationInvocation<readonly unknown[]>
  ) => Promise<unknown>
  commandNames: () => readonly string[]
}>

type RemoteWebApplicationCommandDispatcher = ApplicationCommandByNameDispatcher &
  Readonly<{ rejectedCommandNames: () => readonly string[] }>

type ApplicationCommandCompositionDependencies = Readonly<{
  acp: AcpApplicationCommandDependencies
  notebook: NotebookApplicationCommandDependencies
  notebookEnvironment: NotebookEnvironmentDependencies
  notebookRuntime: RuntimeApplicationCommandDependencies
  settingsCore: CoreSettingsApplicationCommandDependencies
  settingsIntegration: IntegrationSettingsApplicationCommandDependencies
  settingsRuntime: RuntimeSettingsApplicationCommandDependencies
  compute: ComputeApplicationCommandDependencies
  permissionGrants: PermissionGrantDependencies
  dataContent: DataContentApplicationCommandDependencies
  host: Omit<HostApplicationCommandDependencies, 'remoteAccess'>
}>

type ApplicationCommandComposition = Readonly<{
  localWeb: ApplicationCommandByNameDispatcher
  remoteWeb: RemoteWebApplicationCommandDispatcher
  task: ApplicationCommandByNameDispatcher
  bindRemoteAccess: (owner: RemoteAccessOwner) => void
  dispose: () => void
}>

const GROUP_COUNT = 28
const INTERNAL_COMMAND_COUNT = 219
const LOCAL_WEB_COMMAND_COUNT = 217
const REMOTE_WEB_COMMAND_COUNT = 161
const REMOTE_REJECTED_COMMAND_COUNT = 56
const TASK_COMMAND_COUNT = 7

const ELECTRON_NATIVE_COMMAND_NAMES = Object.freeze([
  'sessions:export-conversation',
  'uploads:stage-local-file'
])

const TASK_COMMAND_NAMES = Object.freeze([
  'projects:list',
  'projects:create',
  'sessions:load-all',
  'sessions:save-session',
  'artifacts:finalize-run',
  'preview-resources:acquire',
  'preview-resources:release'
])

const APPLICATION_COMMAND_GROUPS = Object.freeze([
  acpApplicationCommands,
  notebookApplicationCommands,
  notebookEnvironmentApplicationCommands,
  runtimeApplicationCommandGroup,
  settingsCoreApplicationCommandGroup,
  settingsSkillApplicationCommandGroup,
  settingsConnectorApplicationCommandGroup,
  settingsApprovalApplicationCommandGroup,
  settingsRuntimeApplicationCommandGroup,
  computeApplicationCommandGroup,
  permissionGrantApplicationCommandGroup,
  ...dataContentApplicationCommandGroups,
  ...hostApplicationCommandGroups
])

const failInventory = (detail: string): never => {
  throw new Error(`Application command inventory mismatch: ${detail}`)
}

const collectCatalogCommands = (
  installed: (
    installation: (typeof RENDERER_CONTRACT_CATALOG)[number]['surfaceInstallation']
  ) => boolean
): readonly string[] =>
  Object.freeze(
    RENDERER_CONTRACT_CATALOG.flatMap(({ channel, kind, surfaceInstallation }) =>
      channel !== null && kind === 'method' && installed(surfaceInstallation) ? [channel] : []
    ).sort()
  )

const createRemoteAccessSlot = (): Readonly<{
  owner: RemoteAccessOwner
  bind: (owner: RemoteAccessOwner) => void
  dispose: () => void
}> => {
  let bound: RemoteAccessOwner | undefined
  let disposed = false
  const current = (): RemoteAccessOwner => {
    if (disposed) throw new Error('Remote Access command owner slot is disposed.')
    if (!bound) throw new Error('Remote Access command owner is not bound.')
    return bound
  }
  const owner: RemoteAccessOwner = Object.freeze({
    snapshot: (...args) => current().snapshot(...args),
    detect: (...args) => current().detect(...args),
    setMode: (...args) => current().setMode(...args),
    disable: (...args) => current().disable(...args),
    approve: (...args) => current().approve(...args),
    reject: (...args) => current().reject(...args),
    revoke: (...args) => current().revoke(...args)
  })

  return Object.freeze({
    owner,
    bind: (next): void => {
      if (disposed) throw new Error('Remote Access command owner slot is disposed.')
      if (bound) throw new Error('Remote Access command owner is already bound.')
      bound = next
    },
    dispose: (): void => {
      disposed = true
      bound = undefined
    }
  })
}

const certifyInventory = (): Readonly<{
  commands: ReadonlyMap<string, AnyApplicationCommand>
  localWebNames: readonly string[]
  remoteWebNames: readonly string[]
  remoteRejectedNames: readonly string[]
}> => {
  if (APPLICATION_COMMAND_GROUPS.length !== GROUP_COUNT) {
    failInventory(`expected ${GROUP_COUNT} groups, received ${APPLICATION_COMMAND_GROUPS.length}`)
  }

  const groupNames = new Set<string>()
  const commands = new Map<string, AnyApplicationCommand>()
  for (const group of APPLICATION_COMMAND_GROUPS) {
    if (groupNames.has(group.name)) failInventory(`duplicate group ${group.name}`)
    groupNames.add(group.name)
    for (const command of group.commands) {
      if (commands.has(command.name)) failInventory(`duplicate command ${command.name}`)
      commands.set(command.name, command as AnyApplicationCommand)
    }
  }
  if (commands.size !== INTERNAL_COMMAND_COUNT) {
    failInventory(`expected ${INTERNAL_COMMAND_COUNT} commands, received ${commands.size}`)
  }

  const localWebNames = collectCatalogCommands(({ localWeb }) => localWeb === 'web-rpc')
  const remoteWebNames = collectCatalogCommands(({ remoteWeb }) => remoteWeb === 'web-rpc')
  const remoteRejectedNames = collectCatalogCommands(
    ({ localWeb, remoteWeb }) => localWeb === 'web-rpc' && remoteWeb === 'rejecting-stub'
  )
  const expectedCounts = [
    [localWebNames, LOCAL_WEB_COMMAND_COUNT, 'local Web commands'],
    [remoteWebNames, REMOTE_WEB_COMMAND_COUNT, 'remote Web commands'],
    [remoteRejectedNames, REMOTE_REJECTED_COMMAND_COUNT, 'remote Web rejections'],
    [TASK_COMMAND_NAMES, TASK_COMMAND_COUNT, 'Task commands']
  ] as const
  for (const [names, count, label] of expectedCounts) {
    if (names.length !== count)
      failInventory(`expected ${count} ${label}, received ${names.length}`)
    if (new Set(names).size !== names.length) failInventory(`${label} contains duplicate names`)
    for (const name of names) {
      if (!commands.has(name)) failInventory(`${label} contains unknown command ${name}`)
    }
  }

  const nonWebNames = [...commands.keys()].filter((name) => !localWebNames.includes(name)).sort()
  if (nonWebNames.join('\n') !== [...ELECTRON_NATIVE_COMMAND_NAMES].sort().join('\n')) {
    failInventory(`unexpected Electron-native commands ${nonWebNames.join(', ')}`)
  }
  const remotePartition = new Set([...remoteWebNames, ...remoteRejectedNames])
  if (
    remotePartition.size !== localWebNames.length ||
    localWebNames.some((name) => !remotePartition.has(name))
  ) {
    failInventory('remote dispatch and rejection inventories do not partition local Web')
  }

  return Object.freeze({ commands, localWebNames, remoteWebNames, remoteRejectedNames })
}

const createApplicationCommandComposition = (
  dependencies: ApplicationCommandCompositionDependencies,
  onDiagnostic?: (diagnostic: ApplicationCommandDiagnostic) => void
): ApplicationCommandComposition => {
  const certified = certifyInventory()
  const router = createApplicationCommandRouter(onDiagnostic)
  const remoteAccess = createRemoteAccessSlot()
  const installations: ApplicationCommandInstallation[] = []
  let disposed = false

  const installers = [
    () => registerAcpCommands(router.registrar, dependencies.acp),
    () => installNotebookApplicationCommands(router.registrar, dependencies.notebook),
    () =>
      installNotebookEnvironmentApplicationCommands(
        router.registrar,
        dependencies.notebookEnvironment
      ),
    () => registerRuntimeApplicationCommands(router.registrar, dependencies.notebookRuntime),
    () => registerCoreSettingsApplicationCommands(router.registrar, dependencies.settingsCore),
    () =>
      registerIntegrationSettingsApplicationCommands(
        router.registrar,
        dependencies.settingsIntegration
      ),
    () =>
      registerRuntimeSettingsApplicationCommands(router.registrar, dependencies.settingsRuntime),
    () => registerComputeApplicationCommands(router.registrar, dependencies.compute),
    () =>
      registerPermissionGrantApplicationCommands(router.registrar, dependencies.permissionGrants),
    () => registerDataContentApplicationCommands(router.registrar, dependencies.dataContent),
    () =>
      registerHostApplicationCommands(router.registrar, {
        ...dependencies.host,
        remoteAccess: remoteAccess.owner
      })
  ] as const

  try {
    for (const install of installers) installations.push(install())
  } catch (error) {
    const failures: unknown[] = [error]
    for (const installation of [...installations].reverse()) {
      try {
        installation.uninstall()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    try {
      router.dispose()
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    remoteAccess.dispose()
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Application command composition failed.')
    }
    throw error
  }

  const view = (
    names: readonly string[],
    rejectedNames: readonly string[] = []
  ): ApplicationCommandByNameDispatcher => {
    const allowed = new Set(names)
    const rejected = new Set(rejectedNames)
    return Object.freeze({
      commandNames: (): readonly string[] => names,
      invoke: (commandName, invocation): Promise<unknown> => {
        if (rejected.has(commandName)) {
          return Promise.reject(
            new Error(`Application command is rejected before dispatch: ${commandName}`)
          )
        }
        if (!allowed.has(commandName)) {
          return Promise.reject(
            new Error(`Application command is unavailable in this view: ${commandName}`)
          )
        }
        return router.dispatcher.invoke(certified.commands.get(commandName)!, invocation)
      }
    })
  }

  const localWeb = view(certified.localWebNames)
  const remoteDispatcher = view(certified.remoteWebNames, certified.remoteRejectedNames)
  const remoteWeb = Object.freeze({
    ...remoteDispatcher,
    rejectedCommandNames: (): readonly string[] => certified.remoteRejectedNames
  })
  const task = view(TASK_COMMAND_NAMES)

  return Object.freeze({
    localWeb,
    remoteWeb,
    task,
    bindRemoteAccess: remoteAccess.bind,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      const failures: unknown[] = []
      for (const installation of [...installations].reverse()) {
        try {
          installation.uninstall()
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        router.dispose()
      } catch (error) {
        failures.push(error)
      }
      remoteAccess.dispose()
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Application command composition cleanup failed.')
      }
    }
  })
}

export { createApplicationCommandComposition }
export type {
  ApplicationCommandByNameDispatcher,
  ApplicationCommandComposition,
  ApplicationCommandCompositionDependencies,
  RemoteAccessOwner,
  RemoteWebApplicationCommandDispatcher
}
