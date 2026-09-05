import type { DeleteProviderRequest } from '../../shared/settings'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { CallerContext } from '../caller-context'
import {
  readAgentRouting,
  readIsolatedClaudeToken,
  readReasoningEffort
} from './transport-validation'
import type { SettingsSnapshotCommitOwner } from './settings-snapshot-commit-owner'
import type { RuntimeSettingsWorkflows } from './workflows/runtime'

type RuntimeSettingsCommandWorkflows = Pick<
  RuntimeSettingsWorkflows,
  | 'deleteProvider'
  | 'loginClaudeShared'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'loginIsolatedCodex'
  | 'logoutClaudeShared'
  | 'logoutIsolatedClaude'
  | 'logoutIsolatedCodex'
  | 'beginXaiOAuthLogin'
  | 'waitXaiOAuthLogin'
  | 'cancelXaiOAuthLogin'
  | 'logoutXaiOAuth'
  | 'setActiveProvider'
  | 'setAgentFramework'
  | 'setAgentRouting'
  | 'setReasoningEffort'
  | 'uninstallRuntime'
  | 'upsertProvider'
>

type WorkflowArgs<Method extends keyof RuntimeSettingsCommandWorkflows> =
  RuntimeSettingsCommandWorkflows[Method] extends (...args: infer Args) => unknown
    ? Readonly<Args>
    : never

type WorkflowResult<Method extends keyof RuntimeSettingsCommandWorkflows> =
  RuntimeSettingsCommandWorkflows[Method] extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never

const settingsRuntimeApplicationCommands = Object.freeze({
  uninstallClaude: defineApplicationCommand<
    'settings:uninstall-claude',
    readonly [],
    WorkflowResult<'uninstallRuntime'>
  >('settings:uninstall-claude'),
  uninstallCodex: defineApplicationCommand<
    'settings:uninstall-codex',
    readonly [],
    WorkflowResult<'uninstallRuntime'>
  >('settings:uninstall-codex'),
  uninstallCodeBuddy: defineApplicationCommand<
    'settings:uninstall-codebuddy',
    readonly [],
    WorkflowResult<'uninstallRuntime'>
  >('settings:uninstall-codebuddy'),
  uninstallOpencode: defineApplicationCommand<
    'settings:uninstall-opencode',
    readonly [],
    WorkflowResult<'uninstallRuntime'>
  >('settings:uninstall-opencode'),
  upsertProvider: defineApplicationCommand<
    'settings:upsert-provider',
    WorkflowArgs<'upsertProvider'>,
    WorkflowResult<'upsertProvider'>
  >('settings:upsert-provider'),
  deleteProvider: defineApplicationCommand<
    'settings:delete-provider',
    readonly [request: DeleteProviderRequest],
    WorkflowResult<'deleteProvider'>
  >('settings:delete-provider'),
  setActiveProvider: defineApplicationCommand<
    'settings:set-active-provider',
    WorkflowArgs<'setActiveProvider'>,
    WorkflowResult<'setActiveProvider'>
  >('settings:set-active-provider'),
  setAgentFramework: defineApplicationCommand<
    'settings:set-agent-framework',
    WorkflowArgs<'setAgentFramework'>,
    WorkflowResult<'setAgentFramework'>
  >('settings:set-agent-framework'),
  setAgentRouting: defineApplicationCommand<
    'settings:set-agent-routing',
    WorkflowArgs<'setAgentRouting'>,
    WorkflowResult<'setAgentRouting'>
  >('settings:set-agent-routing'),
  setReasoningEffort: defineApplicationCommand<
    'settings:set-reasoning-effort',
    WorkflowArgs<'setReasoningEffort'>,
    WorkflowResult<'setReasoningEffort'>
  >('settings:set-reasoning-effort'),
  loginSharedClaude: defineApplicationCommand<
    'settings:login-shared-claude',
    readonly [],
    WorkflowResult<'loginClaudeShared'>
  >('settings:login-shared-claude'),
  logoutSharedClaude: defineApplicationCommand<
    'settings:logout-shared-claude',
    readonly [],
    WorkflowResult<'logoutClaudeShared'>
  >('settings:logout-shared-claude'),
  loginIsolatedClaude: defineApplicationCommand<
    'settings:login-isolated-claude',
    WorkflowArgs<'loginIsolatedClaude'>,
    WorkflowResult<'loginIsolatedClaude'>
  >('settings:login-isolated-claude'),
  loginIsolatedClaudeBrowser: defineApplicationCommand<
    'settings:login-isolated-claude-browser',
    readonly [],
    WorkflowResult<'loginIsolatedClaudeBrowser'>
  >('settings:login-isolated-claude-browser'),
  logoutIsolatedClaude: defineApplicationCommand<
    'settings:logout-isolated-claude',
    readonly [],
    WorkflowResult<'logoutIsolatedClaude'>
  >('settings:logout-isolated-claude'),
  loginIsolatedCodex: defineApplicationCommand<
    'settings:login-isolated-codex',
    readonly [],
    WorkflowResult<'loginIsolatedCodex'>
  >('settings:login-isolated-codex'),
  logoutIsolatedCodex: defineApplicationCommand<
    'settings:logout-isolated-codex',
    readonly [],
    WorkflowResult<'logoutIsolatedCodex'>
  >('settings:logout-isolated-codex'),
  beginXaiOAuthLogin: defineApplicationCommand<
    'settings:begin-xai-oauth-login',
    readonly [],
    WorkflowResult<'beginXaiOAuthLogin'>
  >('settings:begin-xai-oauth-login'),
  waitXaiOAuthLogin: defineApplicationCommand<
    'settings:wait-xai-oauth-login',
    readonly [],
    WorkflowResult<'waitXaiOAuthLogin'>
  >('settings:wait-xai-oauth-login'),
  cancelXaiOAuthLogin: defineApplicationCommand<
    'settings:cancel-xai-oauth-login',
    readonly [],
    void
  >('settings:cancel-xai-oauth-login'),
  logoutXaiOAuth: defineApplicationCommand<
    'settings:logout-xai-oauth',
    readonly [],
    WorkflowResult<'logoutXaiOAuth'>
  >('settings:logout-xai-oauth')
})

const settingsRuntimeApplicationCommandGroup = defineApplicationCommandGroup('settings-runtime', [
  settingsRuntimeApplicationCommands.uninstallClaude,
  settingsRuntimeApplicationCommands.uninstallCodex,
  settingsRuntimeApplicationCommands.uninstallCodeBuddy,
  settingsRuntimeApplicationCommands.uninstallOpencode,
  settingsRuntimeApplicationCommands.upsertProvider,
  settingsRuntimeApplicationCommands.deleteProvider,
  settingsRuntimeApplicationCommands.setActiveProvider,
  settingsRuntimeApplicationCommands.setAgentFramework,
  settingsRuntimeApplicationCommands.setAgentRouting,
  settingsRuntimeApplicationCommands.setReasoningEffort,
  settingsRuntimeApplicationCommands.loginSharedClaude,
  settingsRuntimeApplicationCommands.logoutSharedClaude,
  settingsRuntimeApplicationCommands.loginIsolatedClaude,
  settingsRuntimeApplicationCommands.loginIsolatedClaudeBrowser,
  settingsRuntimeApplicationCommands.logoutIsolatedClaude,
  settingsRuntimeApplicationCommands.loginIsolatedCodex,
  settingsRuntimeApplicationCommands.logoutIsolatedCodex,
  settingsRuntimeApplicationCommands.beginXaiOAuthLogin,
  settingsRuntimeApplicationCommands.waitXaiOAuthLogin,
  settingsRuntimeApplicationCommands.cancelXaiOAuthLogin,
  settingsRuntimeApplicationCommands.logoutXaiOAuth
] as const)

type RuntimeSettingsApplicationCommandDependencies = Readonly<{
  workflows: RuntimeSettingsCommandWorkflows
  snapshotCommits: SettingsSnapshotCommitOwner
}>

const requireLocalCaller = (context: CallerContext, channel: string): void => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
}

const registerRuntimeSettingsApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: RuntimeSettingsApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()

  try {
    scope.registerGroup(settingsRuntimeApplicationCommandGroup, {
      'settings:uninstall-claude': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:uninstall-claude')
        return dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.uninstallRuntime('uninstallClaude', 'claude-code')
        )
      },
      'settings:uninstall-codex': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:uninstall-codex')
        return dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.uninstallRuntime('uninstallCodex', 'codex')
        )
      },
      'settings:uninstall-codebuddy': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:uninstall-codebuddy')
        return dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.uninstallRuntime('uninstallCodeBuddy', 'codebuddy')
        )
      },
      'settings:uninstall-opencode': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:uninstall-opencode')
        return dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.uninstallRuntime('uninstallOpencode', 'opencode')
        )
      },
      'settings:upsert-provider': ({ args }) =>
        dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.upsertProvider(args[0])
        ),
      'settings:delete-provider': ({ args }) =>
        dependencies.snapshotCommits.currentSnapshotAfter(
          args[0].scenarioModelHandling === undefined
            ? dependencies.workflows.deleteProvider(args[0].id)
            : dependencies.workflows.deleteProvider(args[0].id, args[0].scenarioModelHandling)
        ),
      'settings:set-active-provider': ({ args }) =>
        dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.setActiveProvider(args[0])
        ),
      'settings:set-agent-framework': ({ args }) =>
        dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.setAgentFramework(args[0])
        ),
      'settings:set-agent-routing': ({ args }) =>
        dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.setAgentRouting(readAgentRouting(args[0]))
        ),
      'settings:set-reasoning-effort': ({ args }) =>
        dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.setReasoningEffort({ effort: readReasoningEffort(args[0]) })
        ),
      'settings:login-shared-claude': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:login-shared-claude')
        return dependencies.snapshotCommits.projectAfter(dependencies.workflows.loginClaudeShared())
      },
      'settings:logout-shared-claude': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:logout-shared-claude')
        return dependencies.snapshotCommits.projectAfter(
          dependencies.workflows.logoutClaudeShared()
        )
      },
      'settings:login-isolated-claude': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:login-isolated-claude')
        return dependencies.snapshotCommits.projectAfter(
          dependencies.workflows.loginIsolatedClaude(readIsolatedClaudeToken(args[0]))
        )
      },
      'settings:login-isolated-claude-browser': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:login-isolated-claude-browser')
        return dependencies.snapshotCommits.projectAfter(
          dependencies.workflows.loginIsolatedClaudeBrowser()
        )
      },
      'settings:logout-isolated-claude': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:logout-isolated-claude')
        return dependencies.snapshotCommits.projectAfter(
          dependencies.workflows.logoutIsolatedClaude()
        )
      },
      'settings:login-isolated-codex': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:login-isolated-codex')
        return dependencies.snapshotCommits.projectAfter(
          dependencies.workflows.loginIsolatedCodex()
        )
      },
      'settings:logout-isolated-codex': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:logout-isolated-codex')
        return dependencies.snapshotCommits.projectAfter(
          dependencies.workflows.logoutIsolatedCodex()
        )
      },
      'settings:begin-xai-oauth-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:begin-xai-oauth-login')
        return dependencies.workflows.beginXaiOAuthLogin()
      },
      'settings:wait-xai-oauth-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:wait-xai-oauth-login')
        return dependencies.snapshotCommits.projectAfter(dependencies.workflows.waitXaiOAuthLogin())
      },
      'settings:cancel-xai-oauth-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-xai-oauth-login')
        dependencies.workflows.cancelXaiOAuthLogin()
      },
      'settings:logout-xai-oauth': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:logout-xai-oauth')
        return dependencies.snapshotCommits.currentSnapshotAfter(
          dependencies.workflows.logoutXaiOAuth()
        )
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  registerRuntimeSettingsApplicationCommands,
  settingsRuntimeApplicationCommandGroup,
  settingsRuntimeApplicationCommands
}
export type { RuntimeSettingsApplicationCommandDependencies, RuntimeSettingsCommandWorkflows }
