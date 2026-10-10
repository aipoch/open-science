import { researchRunCommandGroup, registerResearchRunCommands } from './research-runs/ipc'
import type { ResearchRunInspectionPort } from './research-runs/inspection'
import { researchDemoCommandGroup, registerResearchDemoCommands } from './research-demos/ipc'
import type { ResearchDemoOwner } from './research-demos/owner'
import { runObservationCommandGroup, registerRunObservationCommands } from './run-observation/ipc'
import type { RunObservationExternalPort } from './run-observation-external-port'
import {
  browserRecordingCommandGroup,
  registerBrowserRecordingCommands
} from './browser-recordings/ipc'
import type { BrowserRecordingExternalPort } from './browser-recordings/external-port'
import {
  researchExecutionProfileCommandGroup,
  registerResearchExecutionProfileCommands,
  type ResearchExecutionProfileCommands
} from './research-execution-profiles/ipc'
import {
  pdfTranslationApplicationCommandGroup,
  registerPdfTranslationApplicationCommands
} from './literature/pdf-translation/application-commands'
import type { PdfTranslationOwner } from './literature/pdf-translation/index'
import { specialistDesktopCommandGroup } from './specialist/desktop-commands'
import {
  sideChatApplicationCommandGroup,
  registerSideChatApplicationCommands
} from './side-chat/application-commands'
import type { SideChatCommandOwner } from './side-chat/command-owner'
import {
  bootstrapApplicationCommandGroup,
  registerBootstrapApplicationCommands
} from './settings/bootstrap-application-commands'
import {
  specialistApplicationCommandGroup,
  registerSpecialistApplicationCommands,
  type SpecialistApplicationOwner
} from './specialist/application-commands'
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
import {
  literatureApplicationCommandGroup,
  registerLiteratureApplicationCommands,
  type LiteratureCommandOwner
} from './literature/application-commands'
import {
  pdfAnnotationApplicationCommandGroup,
  registerPdfAnnotationApplicationCommands,
  type PdfAnnotationCommandOwner
} from './pdf-annotations/application-commands'
import {
  bookmarkApplicationCommandGroup,
  registerBookmarkApplicationCommands,
  type BookmarkCommandOwner
} from './bookmarks/application-commands'
import {
  sessionReplayCommandGroup,
  registerSessionReplayCommands,
  type SessionReplayCommandOwner
} from './session-replay/application-commands'

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
  runObservation: RunObservationExternalPort
  browserRecording: BrowserRecordingExternalPort
  researchRuns: ResearchRunInspectionPort
  researchDemos: ResearchDemoOwner
  researchExecutionProfiles: ResearchExecutionProfileCommands
  pdfTranslation: PdfTranslationOwner
  sideChat: SideChatCommandOwner
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
  specialist: SpecialistApplicationOwner
  literature: LiteratureCommandOwner
  bookmarks: BookmarkCommandOwner
  sessionReplay: SessionReplayCommandOwner
  pdfAnnotations: PdfAnnotationCommandOwner
  dataContent: DataContentApplicationCommandDependencies
  host: Omit<HostApplicationCommandDependencies, 'remoteAccess'>
}>

type ApplicationCommandComposition = Readonly<{
  desktop: ApplicationCommandByNameDispatcher
  electron: ApplicationCommandByNameDispatcher
  localWeb: ApplicationCommandByNameDispatcher
  remoteWeb: RemoteWebApplicationCommandDispatcher
  task: ApplicationCommandByNameDispatcher
  bindRemoteAccess: (owner: RemoteAccessOwner) => void
  dispose: () => void
}>

const ELECTRON_NATIVE_COMMAND_NAMES = Object.freeze([
  ...runObservationCommandGroup.commands.map(({ name }) => name),
  ...browserRecordingCommandGroup.commands.map(({ name }) => name),
  ...researchRunCommandGroup.commands.map(({ name }) => name),
  ...researchDemoCommandGroup.commands.map(({ name }) => name),
  ...researchExecutionProfileCommandGroup.commands.map(({ name }) => name),
  ...pdfTranslationApplicationCommandGroup.commands.map(({ name }) => name),
  'office-preview:open',
  'office-preview:attach-frame',
  'office-preview:close',
  'office-preview:report-state',

  'sessions:open-recovery-folder',
  'specialist:get-handoff-events',
  'specialist:retry-handoff',
  'specialist:cancel-handoff',
  'file:save-blob',
  'file:save-managed',
  'file:save-session-artifacts',
  'file:save-project-artifacts',
  'specialist:create',
  'specialist:duplicate',
  'specialist:delete',
  'specialist:delete-preview',
  'specialist:export-preview',
  'specialist:export-save',
  'specialist:package-select',
  'specialist:package-report-save',
  'specialist:export-contribution-template',
  'specialist:resolve-session-specialist',
  'specialist:marketplace-source-inspect-github',
  'specialist:marketplace-source-add',
  'specialist:marketplace-source-remove',
  'specialist:marketplace-install-prepare',
  'specialist:marketplace-install',
  'specialist:marketplace-candidate-cancel',
  'settings:export-skill',
  'settings:select-custom-server-template',
  'settings:export-custom-server-template',

  'settings:resolve-skill-document',
  'settings:list-agent-home-skills',
  'settings:preview-custom-server-template-export',
  'settings:import-agent-home-skills',
  'connectors:credential-respond',
  'connectors:credential-replay-pending',
  'notifications:get-desktop-availability',
  'notifications:send-test',
  'artifacts:session-reproducibility',
  'artifacts:get-reproducibility-output-storage',
  'artifacts:clear-reproducibility-outputs',
  'artifacts:read-reproducibility-output',
  'artifacts:describe-environment-lock',
  'artifacts:create-environment-from-lock',
  'artifacts:export-environment-lock',
  'artifacts:export-reproducibility-receipt',
  'artifacts:import-environment-lock',
  'artifacts:get-reproducibility-check',
  'artifacts:get-reproducibility-check-log',
  'artifacts:list-reproducibility-receipts',
  'artifacts:start-reproducibility-check',
  'artifacts:cancel-reproducibility-check',

  'locale:initialize',
  'locale:set-preference',
  'network:get-info',
  'network:check-connectivity',
  'managed-file-versions:inspect',
  'managed-file-versions:save-text-edit',
  'managed-file-versions:diff-text',
  'managed-file-versions:cancel-diff',
  'background-result-delivery:session-activity',
  'background-result-delivery:project-activity',
  ...sideChatApplicationCommandGroup.commands.map(({ name }) => name),
  'remote-access:detect',
  'remote-access:disable',
  'remote-access:set-mode',
  'sessions:export-conversation',
  'sessions:fork',
  'sessions:inspect-diagnostics',
  'sessions:export-diagnostics',
  'sessions:cancel-diagnostics',
  'sessions:export-package',
  'sessions:import-package',
  'sessions:package-operation',
  'uploads:stage-local-file'
])

const TASK_NATIVE_COMMAND_NAMES = Object.freeze([
  'settings:bootstrap',
  'settings:test-custom-server',
  'projects:update-session-defaults',
  'reviewer:abort',
  'settings:set-agent-routing',
  'sessions:fail-task-run',
  'sessions:settle-task-completion',
  'sessions:bind-task-session',
  'sessions:admit-task-turn',
  'sessions:stage-task-completion',
  'sessions:update-configuration'
])

const TASK_COMMAND_NAMES = Object.freeze([
  'settings:bootstrap',
  'cli:install',
  'settings:get-preflight',
  'settings:list-skills',
  'settings:list-connectors',
  'settings:get-connector-detail',
  'settings:set-connector-enabled',
  'settings:set-custom-server-enabled',
  'settings:add-custom-server',
  'settings:update-custom-server',
  'settings:remove-custom-server',
  'settings:test-custom-server',
  'settings:list-device-credentials',
  'settings:create-device-credential',
  'settings:update-device-credential',

  'projects:list',
  'projects:create',
  'projects:update',
  'projects:update-session-defaults',
  'settings:get-settings',
  'settings:set-agent-routing',
  'sessions:load-all',
  'sessions:save-session',
  'sessions:bind-task-session',
  'sessions:admit-task-turn',
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
  'artifacts:resolve-version-descriptors',
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
    defineApplicationCommandModule([runObservationCommandGroup], (registrar) =>
      registerRunObservationCommands(registrar, dependencies.runObservation)
    ),
    defineApplicationCommandModule([browserRecordingCommandGroup], (registrar) =>
      registerBrowserRecordingCommands(registrar, dependencies.browserRecording)
    ),
    defineApplicationCommandModule([researchRunCommandGroup], (registrar) =>
      registerResearchRunCommands(registrar, dependencies.researchRuns)
    ),
    defineApplicationCommandModule([researchDemoCommandGroup], (registrar) =>
      registerResearchDemoCommands(registrar, dependencies.researchDemos)
    ),
    defineApplicationCommandModule([researchExecutionProfileCommandGroup], (registrar) =>
      registerResearchExecutionProfileCommands(registrar, dependencies.researchExecutionProfiles)
    ),
    defineApplicationCommandModule([pdfTranslationApplicationCommandGroup], (registrar) =>
      registerPdfTranslationApplicationCommands(registrar, dependencies.pdfTranslation)
    ),
    defineApplicationCommandModule([sideChatApplicationCommandGroup], (registrar) =>
      registerSideChatApplicationCommands(registrar, dependencies.sideChat)
    ),
    defineApplicationCommandModule([bootstrapApplicationCommandGroup], (registrar) =>
      registerBootstrapApplicationCommands(registrar, dependencies.settingsCore)
    ),
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
    defineApplicationCommandModule(
      [specialistApplicationCommandGroup, specialistDesktopCommandGroup],
      (registrar) => registerSpecialistApplicationCommands(registrar, dependencies.specialist)
    ),
    defineApplicationCommandModule([literatureApplicationCommandGroup], (registrar) =>
      registerLiteratureApplicationCommands(registrar, dependencies.literature)
    ),
    defineApplicationCommandModule([bookmarkApplicationCommandGroup], (registrar) =>
      registerBookmarkApplicationCommands(registrar, dependencies.bookmarks)
    ),
    defineApplicationCommandModule([sessionReplayCommandGroup], (registrar) =>
      registerSessionReplayCommands(registrar, dependencies.sessionReplay)
    ),
    defineApplicationCommandModule([pdfAnnotationApplicationCommandGroup], (registrar) =>
      registerPdfAnnotationApplicationCommands(registrar, dependencies.pdfAnnotations)
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
    revoke: (...args) => current().revoke(...args),
    revokeBrowsers: (...args) => current().revokeBrowsers(...args)
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

  const desktop = view([
    ...new Set([
      ...certified.localWebNames,
      ...certified.electronNames,
      ...ELECTRON_NATIVE_COMMAND_NAMES
    ])
  ])
  const electron = view(certified.electronNames)
  const localWeb = view(certified.localWebNames)
  const remoteDispatcher = view(certified.remoteWebNames, certified.remoteRejectedNames)
  const remoteWeb = Object.freeze({
    ...remoteDispatcher,
    rejectedCommandNames: (): readonly string[] => certified.remoteRejectedNames
  })
  const task = view(TASK_COMMAND_NAMES)

  return Object.freeze({
    desktop,
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
