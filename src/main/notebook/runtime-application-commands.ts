import type { NotebookLanguage } from '../../shared/notebook'
import type {
  DiscoveredInterpreter,
  EnvPackage,
  RuntimeEnablement,
  RuntimeSelection,
  RuntimeSurvey,
  RuntimeUsage
} from '../../shared/notebook-runtime'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { CallerContext } from '../caller-context'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { RuntimeSelectionWorkflows } from './runtime-selection-workflows'

const log = createLogger('notebook:runtime-commands')

type RuntimeLanguageRequest = Readonly<{ language: NotebookLanguage }>
type RuntimeEnvironmentRequest = Readonly<{ language: NotebookLanguage; envId: string }>
type RuntimeSelectionRequest = Readonly<{
  language: NotebookLanguage
  selection: RuntimeSelection | null
}>
type RuntimeEnvironmentEnablementRequest = Readonly<{
  language: NotebookLanguage
  envId: string
  enabled: boolean
  force?: boolean
}>
type RuntimeInstallAuthorizationRequest = Readonly<{
  language: NotebookLanguage
  envId: string
  authorized: boolean
}>
type RuntimeInterpreterRequest = Readonly<{ language: NotebookLanguage; path: string }>
type RuntimeAgentEnvironmentCreationRequest = Readonly<{ enabled: boolean }>

const runtimeApplicationCommands = Object.freeze({
  survey: defineApplicationCommand<'runtime:survey', readonly [], RuntimeSurvey[]>(
    'runtime:survey'
  ),
  listEnvironments: defineApplicationCommand<
    'runtime:list-environments',
    readonly [],
    Readonly<{ python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }>
  >('runtime:list-environments'),
  listPackages: defineApplicationCommand<
    'runtime:list-packages',
    readonly [request: RuntimeEnvironmentRequest],
    EnvPackage[]
  >('runtime:list-packages'),
  listPackageCounts: defineApplicationCommand<
    'runtime:list-package-counts',
    readonly [request: RuntimeLanguageRequest],
    Record<string, number | null>
  >('runtime:list-package-counts'),
  setSelection: defineApplicationCommand<
    'runtime:set-selection',
    readonly [request: RuntimeSelectionRequest],
    RuntimeSurvey
  >('runtime:set-selection'),
  getEnablement: defineApplicationCommand<
    'runtime:get-enablement',
    readonly [request: RuntimeLanguageRequest],
    RuntimeEnablement
  >('runtime:get-enablement'),
  getAgentEnvironmentCreationEnabled: defineApplicationCommand<
    'runtime:get-agent-environment-creation-enabled',
    readonly [],
    boolean
  >('runtime:get-agent-environment-creation-enabled'),
  describeUsage: defineApplicationCommand<
    'runtime:describe-usage',
    readonly [request: RuntimeEnvironmentRequest],
    RuntimeUsage
  >('runtime:describe-usage'),
  setEnvironmentEnabled: defineApplicationCommand<
    'runtime:set-environment-enabled',
    readonly [request: RuntimeEnvironmentEnablementRequest],
    RuntimeEnablement
  >('runtime:set-environment-enabled'),
  setInstallAuthorized: defineApplicationCommand<
    'runtime:set-install-authorized',
    readonly [request: RuntimeInstallAuthorizationRequest],
    RuntimeEnablement
  >('runtime:set-install-authorized'),
  setAgentEnvironmentCreationEnabled: defineApplicationCommand<
    'runtime:set-agent-environment-creation-enabled',
    readonly [request: RuntimeAgentEnvironmentCreationRequest],
    boolean
  >('runtime:set-agent-environment-creation-enabled'),
  pickInterpreter: defineApplicationCommand<'runtime:pick-interpreter', readonly [], string | null>(
    'runtime:pick-interpreter'
  ),
  registerInterpreter: defineApplicationCommand<
    'runtime:register-interpreter',
    readonly [request: RuntimeInterpreterRequest],
    string[]
  >('runtime:register-interpreter'),
  unregisterInterpreter: defineApplicationCommand<
    'runtime:unregister-interpreter',
    readonly [request: RuntimeInterpreterRequest],
    string[]
  >('runtime:unregister-interpreter')
})

const runtimeApplicationCommandGroup = defineApplicationCommandGroup('runtime', [
  runtimeApplicationCommands.describeUsage,
  runtimeApplicationCommands.getAgentEnvironmentCreationEnabled,
  runtimeApplicationCommands.getEnablement,
  runtimeApplicationCommands.listEnvironments,
  runtimeApplicationCommands.listPackageCounts,
  runtimeApplicationCommands.listPackages,
  runtimeApplicationCommands.pickInterpreter,
  runtimeApplicationCommands.registerInterpreter,
  runtimeApplicationCommands.setAgentEnvironmentCreationEnabled,
  runtimeApplicationCommands.setEnvironmentEnabled,
  runtimeApplicationCommands.setInstallAuthorized,
  runtimeApplicationCommands.setSelection,
  runtimeApplicationCommands.survey,
  runtimeApplicationCommands.unregisterInterpreter
] as const)

type RuntimeApplicationCommandDependencies = Readonly<{
  workflows: RuntimeSelectionWorkflows
  pickInterpreter: () => Promise<string | null>
}>

const requireLocalCaller = (context: CallerContext): void => {
  if (context.location !== 'local') {
    throw new Error('Runtime command is only available to local callers.')
  }
}

const registerRuntimeApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: RuntimeApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()

  try {
    scope.registerGroup(runtimeApplicationCommandGroup, {
      'runtime:survey': () => dependencies.workflows.survey(),
      'runtime:list-environments': () => dependencies.workflows.listEnvironments(),
      'runtime:list-packages': (invocation) =>
        dependencies.workflows.listPackages(invocation.args[0]),
      'runtime:list-package-counts': (invocation) =>
        dependencies.workflows.listPackageCounts(invocation.args[0]),
      'runtime:set-selection': (invocation) => {
        requireLocalCaller(invocation.callerContext)
        return dependencies.workflows.setSelection(invocation.args[0])
      },
      'runtime:get-enablement': (invocation) =>
        dependencies.workflows.getEnablement(invocation.args[0]),
      'runtime:get-agent-environment-creation-enabled': () =>
        dependencies.workflows.getAgentEnvironmentCreationEnabled(),
      'runtime:describe-usage': (invocation) =>
        dependencies.workflows.describeUsage(invocation.args[0]),
      'runtime:set-environment-enabled': (invocation) => {
        requireLocalCaller(invocation.callerContext)
        return dependencies.workflows.setEnvironmentEnabled(invocation.args[0])
      },
      'runtime:set-install-authorized': (invocation) => {
        requireLocalCaller(invocation.callerContext)
        return dependencies.workflows.setInstallAuthorized(invocation.args[0])
      },
      'runtime:set-agent-environment-creation-enabled': (invocation) => {
        requireLocalCaller(invocation.callerContext)
        return dependencies.workflows.setAgentEnvironmentCreationEnabled(invocation.args[0])
      },
      'runtime:pick-interpreter': async ({ callerContext }) => {
        requireLocalCaller(callerContext)
        try {
          return await dependencies.pickInterpreter()
        } catch (error) {
          log.error('pick interpreter failed', diagnosticErrorFields(error))
          return null
        }
      },
      'runtime:register-interpreter': (invocation) => {
        requireLocalCaller(invocation.callerContext)
        return dependencies.workflows.register(invocation.args[0])
      },
      'runtime:unregister-interpreter': (invocation) => {
        requireLocalCaller(invocation.callerContext)
        return dependencies.workflows.unregister(invocation.args[0])
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  registerRuntimeApplicationCommands,
  runtimeApplicationCommandGroup,
  runtimeApplicationCommands
}
export type { RuntimeApplicationCommandDependencies }
