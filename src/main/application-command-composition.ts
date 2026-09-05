import { ApplicationCommandError } from '../shared/application-command-contract'
import {
  ELECTRON_APPLICATION_COMMAND_CHANNELS,
  RENDERER_CONTRACT_CATALOG
} from '../shared/renderer-contract-catalog'
import {
  acpApplicationCommands,
  registerAcpCommands,
  type AcpApplicationCommandDependencies
} from './acp/application-commands'
import {
  createApplicationCommandRouter,
  type ApplicationCommand,
  type ApplicationCommandDiagnostic,
  type ApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationInvocation,
  type ApplicationCommandRegistrar
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
import {
  registerTagApplicationCommands,
  tagApplicationCommandGroup,
  type TagCommandOwner
} from './tags/application-commands'
import {
  memoryApplicationCommandGroup,
  registerMemoryApplicationCommands,
  type MemoryCommandOwner
} from './memory/application-commands'

type AnyApplicationCommand = ApplicationCommand<string, readonly unknown[], unknown>
type AnyApplicationCommandGroup = ApplicationCommandGroup<string, readonly AnyApplicationCommand[]>
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

type ApplicationCommandModuleDescriptor = Readonly<{
  groups: readonly AnyApplicationCommandGroup[]
  install: (registrar: ApplicationCommandRegistrar) => ApplicationCommandInstallation
}>

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
  tags: TagCommandOwner
  memory: MemoryCommandOwner
  dataContent: DataContentApplicationCommandDependencies
  host: Omit<HostApplicationCommandDependencies, 'remoteAccess'>
}>

type ApplicationCommandComposition = Readonly<{
  electron: ApplicationCommandByNameDispatcher
  localWeb: ApplicationCommandByNameDispatcher
  remoteWeb: RemoteWebApplicationCommandDispatcher
  task: ApplicationCommandByNameDispatcher
  bindRemoteAccess: (owner: RemoteAccessOwner) => void
  dispose: () => void
}>

const ELECTRON_NATIVE_COMMAND_NAMES = Object.freeze([
  'remote-access:detect',
  'remote-access:disable',
  'remote-access:set-mode',
  'sessions:export-conversation',
  'uploads:stage-local-file'
])

const TASK_NATIVE_COMMAND_NAMES = Object.freeze([
  'projects:update-session-defaults',
  'reviewer:abort',
  'settings:set-agent-routing',
  'sessions:fail-task-run',
  'sessions:settle-task-completion',
  'sessions:stage-task-completion',
  'sessions:update-configuration'
])

const TASK_COMMAND_NAMES = Object.freeze([
  'projects:list',
  'projects:create',
  'projects:update',
  'projects:update-session-defaults',
  'settings:get-settings',
  'settings:set-agent-routing',
  'sessions:load-all',
  'sessions:save-session',
  'sessions:stage-task-completion',
  'sessions:settle-task-completion',
  'sessions:fail-task-run',
  'sessions:set-delegation-policy',
  'sessions:update-configuration',
  'acp:get-plan-projection',
  'acp:respond-plan',
  'reviewer:abort',
  'reviewer:get-for-session',
  'reviewer:run',
  'artifacts:finalize-run',
  'preview-resources:acquire',
  'preview-resources:release'
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

const defineApplicationCommandModule = (
  groups: readonly AnyApplicationCommandGroup[],
  install: ApplicationCommandModuleDescriptor['install']
): ApplicationCommandModuleDescriptor =>
  Object.freeze({ groups: Object.freeze([...groups]), install })

const createApplicationCommandModules = (
  dependencies: ApplicationCommandCompositionDependencies,
  remoteAccess: RemoteAccessOwner
): readonly ApplicationCommandModuleDescriptor[] =>
  Object.freeze([
    defineApplicationCommandModule([acpApplicationCommands], (registrar) =>
      registerAcpCommands(registrar, dependencies.acp)
    ),
    defineApplicationCommandModule([notebookApplicationCommands], (registrar) =>
      installNotebookApplicationCommands(registrar, dependencies.notebook)
    ),
    defineApplicationCommandModule([notebookEnvironmentApplicationCommands], (registrar) =>
      installNotebookEnvironmentApplicationCommands(registrar, dependencies.notebookEnvironment)
    ),
    defineApplicationCommandModule([runtimeApplicationCommandGroup], (registrar) =>
      registerRuntimeApplicationCommands(registrar, dependencies.notebookRuntime)
    ),
    defineApplicationCommandModule([settingsCoreApplicationCommandGroup], (registrar) =>
      registerCoreSettingsApplicationCommands(registrar, dependencies.settingsCore)
    ),
    defineApplicationCommandModule(
      [
        settingsSkillApplicationCommandGroup,
        settingsConnectorApplicationCommandGroup,
        settingsApprovalApplicationCommandGroup
      ],
      (registrar) =>
        registerIntegrationSettingsApplicationCommands(registrar, dependencies.settingsIntegration)
    ),
    defineApplicationCommandModule([settingsRuntimeApplicationCommandGroup], (registrar) =>
      registerRuntimeSettingsApplicationCommands(registrar, dependencies.settingsRuntime)
    ),
    defineApplicationCommandModule([computeApplicationCommandGroup], (registrar) =>
      registerComputeApplicationCommands(registrar, dependencies.compute)
    ),
    defineApplicationCommandModule([permissionGrantApplicationCommandGroup], (registrar) =>
      registerPermissionGrantApplicationCommands(registrar, dependencies.permissionGrants)
    ),
    defineApplicationCommandModule([tagApplicationCommandGroup], (registrar) =>
      registerTagApplicationCommands(registrar, dependencies.tags)
    ),
    defineApplicationCommandModule([memoryApplicationCommandGroup], (registrar) =>
      registerMemoryApplicationCommands(registrar, dependencies.memory)
    ),
    defineApplicationCommandModule(dataContentApplicationCommandGroups, (registrar) =>
      registerDataContentApplicationCommands(registrar, dependencies.dataContent)
    ),
    defineApplicationCommandModule(hostApplicationCommandGroups, (registrar) =>
      registerHostApplicationCommands(registrar, { ...dependencies.host, remoteAccess })
    )
  ])

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
    probe: (...args) => current().probe(...args),
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

const certifyInventory = (
  groups: readonly AnyApplicationCommandGroup[]
): Readonly<{
  commands: ReadonlyMap<string, AnyApplicationCommand>
  electronNames: readonly string[]
  localWebNames: readonly string[]
  remoteWebNames: readonly string[]
  remoteRejectedNames: readonly string[]
}> => {
  const groupNames = new Set<string>()
  const commands = new Map<string, AnyApplicationCommand>()
  for (const group of groups) {
    if (groupNames.has(group.name)) failInventory(`duplicate group ${group.name}`)
    groupNames.add(group.name)
    for (const command of group.commands) {
      if (commands.has(command.name)) failInventory(`duplicate command ${command.name}`)
      commands.set(command.name, command as AnyApplicationCommand)
    }
  }
  const localWebNames = collectCatalogCommands(({ localWeb }) => localWeb === 'web-rpc')
  const electronNames = ELECTRON_APPLICATION_COMMAND_CHANNELS
  const remoteWebNames = collectCatalogCommands(({ remoteWeb }) => remoteWeb === 'web-rpc')
  const remoteRejectedNames = collectCatalogCommands(
    ({ localWeb, remoteWeb }) => localWeb === 'web-rpc' && remoteWeb === 'rejecting-stub'
  )
  const surfaceInventories = [
    [electronNames, 'validated Electron commands'],
    [localWebNames, 'local Web commands'],
    [remoteWebNames, 'remote Web commands'],
    [remoteRejectedNames, 'remote Web rejections'],
    [TASK_COMMAND_NAMES, 'Task commands']
  ] as const
  for (const [names, label] of surfaceInventories) {
    if (new Set(names).size !== names.length) failInventory(`${label} contains duplicate names`)
    for (const name of names) {
      if (!commands.has(name)) failInventory(`${label} contains unknown command ${name}`)
    }
  }
  for (const name of electronNames) {
    if (!commands.get(name)?.contract) {
      failInventory(`validated Electron command has no runtime codec: ${name}`)
    }
  }

  const nonWebNames = [...commands.keys()].filter((name) => !localWebNames.includes(name)).sort()
  const nativeCommandNames = [...ELECTRON_NATIVE_COMMAND_NAMES, ...TASK_NATIVE_COMMAND_NAMES]
  if (nonWebNames.join('\n') !== nativeCommandNames.sort().join('\n')) {
    failInventory(`unexpected native commands ${nonWebNames.join(', ')}`)
  }
  const remotePartition = new Set([...remoteWebNames, ...remoteRejectedNames])
  if (
    remotePartition.size !== localWebNames.length ||
    localWebNames.some((name) => !remotePartition.has(name))
  ) {
    failInventory('remote dispatch and rejection inventories do not partition local Web')
  }

  return Object.freeze({
    commands,
    electronNames,
    localWebNames,
    remoteWebNames,
    remoteRejectedNames
  })
}

const certifyInstalledInventory = (
  declaredCommands: ReadonlyMap<string, AnyApplicationCommand>,
  installedNames: readonly string[]
): void => {
  const declared = new Set(declaredCommands.keys())
  const installed = new Set(installedNames)
  const missing = [...declaredCommands.keys()].filter((name) => !installed.has(name)).sort()
  const unexpected = [...installed].filter((name) => !declared.has(name)).sort()
  const differences = [
    ...(missing.length > 0 ? [`declared commands are not installed: ${missing.join(', ')}`] : []),
    ...(unexpected.length > 0
      ? [`installed commands are not declared: ${unexpected.join(', ')}`]
      : [])
  ]
  if (differences.length > 0) failInventory(differences.join('; '))
}

const createApplicationCommandComposition = (
  dependencies: ApplicationCommandCompositionDependencies,
  onDiagnostic?: (diagnostic: ApplicationCommandDiagnostic) => void
): ApplicationCommandComposition => {
  const remoteAccess = createRemoteAccessSlot()
  const modules = createApplicationCommandModules(dependencies, remoteAccess.owner)
  const certified = certifyInventory(modules.flatMap(({ groups }) => groups))
  const router = createApplicationCommandRouter(onDiagnostic)
  const installations: ApplicationCommandInstallation[] = []
  let disposed = false

  try {
    for (const module of modules) installations.push(module.install(router.registrar))
    certifyInstalledInventory(certified.commands, router.dispatcher.commandNames())
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
            new ApplicationCommandError(
              'command-unavailable',
              `Application command is rejected before dispatch: ${commandName}`
            )
          )
        }
        if (!allowed.has(commandName)) {
          return Promise.reject(
            new ApplicationCommandError(
              'command-unavailable',
              `Application command is unavailable in this view: ${commandName}`
            )
          )
        }
        return router.dispatcher.invoke(certified.commands.get(commandName)!, invocation)
      }
    })
  }

  const electron = view(certified.electronNames)
  const localWeb = view(certified.localWebNames)
  const remoteDispatcher = view(certified.remoteWebNames, certified.remoteRejectedNames)
  const remoteWeb = Object.freeze({
    ...remoteDispatcher,
    rejectedCommandNames: (): readonly string[] => certified.remoteRejectedNames
  })
  const task = view(TASK_COMMAND_NAMES)

  return Object.freeze({
    electron,
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
