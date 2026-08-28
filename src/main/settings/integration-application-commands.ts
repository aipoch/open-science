import type {
  ConversationSkillImportApprovalResponse,
  RespondApprovalRequest
} from '../../shared/settings'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import { canSatisfyHumanApproval, type CallerContext } from '../caller-context'
import type { ApprovalBroker } from '../connectors/approval-broker'
import type { SkillImportApprovalBroker } from '../skills/conversation-import'
import { readConversationSkillImportEnabled } from './transport-validation'
import type { ConnectorSettingsWorkflows } from './workflows/connectors'
import type { SkillSettingsWorkflows } from './workflows/skills'

type SkillIntegrationWorkflows = Pick<
  SkillSettingsWorkflows,
  | 'setConversationSkillImportEnabled'
  | 'setSkillEnabled'
  | 'setSkillsEnabled'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'importSkill'
  | 'importSkillZip'
  | 'importSkillZipBatch'
>

type ConnectorIntegrationWorkflows = Pick<
  ConnectorSettingsWorkflows,
  | 'setConnectorEnabled'
  | 'setConnectorAutoAllow'
  | 'setToolPermission'
  | 'setNcbiCredentials'
  | 'setOpenAlexCredential'
  | 'validateOpenAlexCredential'
  | 'addCustomServer'
  | 'setCustomServerEnabled'
  | 'removeCustomServer'
  | 'updateCustomServer'
  | 'authenticateCustomServer'
  | 'cancelCustomServerAuthentication'
  | 'retryCustomServer'
>

type OwnerArgs<Owner, Method extends keyof Owner> = Owner[Method] extends (
  ...args: infer Args
) => unknown
  ? Readonly<Args>
  : never

type OwnerResult<Owner, Method extends keyof Owner> = Owner[Method] extends (
  ...args: never[]
) => infer Result
  ? Awaited<Result>
  : never

const requireLocalCaller = (context: CallerContext, channel: string): void => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
}

const settingsIntegrationApplicationCommands = Object.freeze({
  setConversationSkillImportEnabled: defineApplicationCommand<
    'settings:set-conversation-skill-import-enabled',
    OwnerArgs<SkillIntegrationWorkflows, 'setConversationSkillImportEnabled'>,
    OwnerResult<SkillIntegrationWorkflows, 'setConversationSkillImportEnabled'>
  >('settings:set-conversation-skill-import-enabled'),
  setSkillEnabled: defineApplicationCommand<
    'settings:set-skill-enabled',
    OwnerArgs<SkillIntegrationWorkflows, 'setSkillEnabled'>,
    OwnerResult<SkillIntegrationWorkflows, 'setSkillEnabled'>
  >('settings:set-skill-enabled'),
  setSkillsEnabled: defineApplicationCommand<
    'settings:set-skills-enabled',
    OwnerArgs<SkillIntegrationWorkflows, 'setSkillsEnabled'>,
    OwnerResult<SkillIntegrationWorkflows, 'setSkillsEnabled'>
  >('settings:set-skills-enabled'),
  createSkill: defineApplicationCommand<
    'settings:create-skill',
    OwnerArgs<SkillIntegrationWorkflows, 'createSkill'>,
    OwnerResult<SkillIntegrationWorkflows, 'createSkill'>
  >('settings:create-skill'),
  updateSkill: defineApplicationCommand<
    'settings:update-skill',
    OwnerArgs<SkillIntegrationWorkflows, 'updateSkill'>,
    OwnerResult<SkillIntegrationWorkflows, 'updateSkill'>
  >('settings:update-skill'),
  deleteSkill: defineApplicationCommand<
    'settings:delete-skill',
    OwnerArgs<SkillIntegrationWorkflows, 'deleteSkill'>,
    OwnerResult<SkillIntegrationWorkflows, 'deleteSkill'>
  >('settings:delete-skill'),
  importSkill: defineApplicationCommand<
    'settings:import-skill',
    OwnerArgs<SkillIntegrationWorkflows, 'importSkill'>,
    OwnerResult<SkillIntegrationWorkflows, 'importSkill'>
  >('settings:import-skill'),
  importSkillZip: defineApplicationCommand<
    'settings:import-skill-zip',
    OwnerArgs<SkillIntegrationWorkflows, 'importSkillZip'>,
    OwnerResult<SkillIntegrationWorkflows, 'importSkillZip'>
  >('settings:import-skill-zip'),
  importSkillZipBatch: defineApplicationCommand<
    'settings:import-skill-zip-batch',
    OwnerArgs<SkillIntegrationWorkflows, 'importSkillZipBatch'>,
    OwnerResult<SkillIntegrationWorkflows, 'importSkillZipBatch'>
  >('settings:import-skill-zip-batch'),
  setConnectorEnabled: defineApplicationCommand<
    'settings:set-connector-enabled',
    OwnerArgs<ConnectorIntegrationWorkflows, 'setConnectorEnabled'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'setConnectorEnabled'>
  >('settings:set-connector-enabled'),
  setConnectorAutoAllow: defineApplicationCommand<
    'settings:set-connector-auto-allow',
    OwnerArgs<ConnectorIntegrationWorkflows, 'setConnectorAutoAllow'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'setConnectorAutoAllow'>
  >('settings:set-connector-auto-allow'),
  setToolPermission: defineApplicationCommand<
    'settings:set-tool-permission',
    OwnerArgs<ConnectorIntegrationWorkflows, 'setToolPermission'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'setToolPermission'>
  >('settings:set-tool-permission'),
  setNcbiCredentials: defineApplicationCommand<
    'settings:set-ncbi-credentials',
    OwnerArgs<ConnectorIntegrationWorkflows, 'setNcbiCredentials'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'setNcbiCredentials'>
  >('settings:set-ncbi-credentials'),
  setOpenAlexCredential: defineApplicationCommand<
    'settings:set-openalex-credential',
    OwnerArgs<ConnectorIntegrationWorkflows, 'setOpenAlexCredential'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'setOpenAlexCredential'>
  >('settings:set-openalex-credential'),
  validateOpenAlexCredential: defineApplicationCommand<
    'settings:validate-openalex-credential',
    OwnerArgs<ConnectorIntegrationWorkflows, 'validateOpenAlexCredential'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'validateOpenAlexCredential'>
  >('settings:validate-openalex-credential'),
  addCustomServer: defineApplicationCommand<
    'settings:add-custom-server',
    OwnerArgs<ConnectorIntegrationWorkflows, 'addCustomServer'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'addCustomServer'>
  >('settings:add-custom-server'),
  setCustomServerEnabled: defineApplicationCommand<
    'settings:set-custom-server-enabled',
    OwnerArgs<ConnectorIntegrationWorkflows, 'setCustomServerEnabled'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'setCustomServerEnabled'>
  >('settings:set-custom-server-enabled'),
  removeCustomServer: defineApplicationCommand<
    'settings:remove-custom-server',
    OwnerArgs<ConnectorIntegrationWorkflows, 'removeCustomServer'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'removeCustomServer'>
  >('settings:remove-custom-server'),
  updateCustomServer: defineApplicationCommand<
    'settings:update-custom-server',
    OwnerArgs<ConnectorIntegrationWorkflows, 'updateCustomServer'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'updateCustomServer'>
  >('settings:update-custom-server'),
  authenticateCustomServer: defineApplicationCommand<
    'settings:authenticate-custom-server',
    OwnerArgs<ConnectorIntegrationWorkflows, 'authenticateCustomServer'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'authenticateCustomServer'>
  >('settings:authenticate-custom-server'),
  cancelCustomServerAuthentication: defineApplicationCommand<
    'settings:cancel-custom-server-authentication',
    OwnerArgs<ConnectorIntegrationWorkflows, 'cancelCustomServerAuthentication'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'cancelCustomServerAuthentication'>
  >('settings:cancel-custom-server-authentication'),
  retryCustomServer: defineApplicationCommand<
    'settings:retry-custom-server',
    OwnerArgs<ConnectorIntegrationWorkflows, 'retryCustomServer'>,
    OwnerResult<ConnectorIntegrationWorkflows, 'retryCustomServer'>
  >('settings:retry-custom-server'),
  respondConnectorApproval: defineApplicationCommand<
    'connectors:approval-respond',
    readonly [request: RespondApprovalRequest],
    ReturnType<ApprovalBroker['respond']>
  >('connectors:approval-respond'),
  replayConnectorApproval: defineApplicationCommand<
    'connectors:approval-replay',
    readonly [id: string],
    ReturnType<ApprovalBroker['getPending']>
  >('connectors:approval-replay'),
  replayPendingConnectorApprovals: defineApplicationCommand<
    'connectors:approval-replay-pending',
    readonly [],
    ReturnType<ApprovalBroker['replayPending']>
  >('connectors:approval-replay-pending'),
  respondSkillImportApproval: defineApplicationCommand<
    'skills:conversation-import-respond',
    readonly [response: ConversationSkillImportApprovalResponse],
    ReturnType<SkillImportApprovalBroker['respond']>
  >('skills:conversation-import-respond'),
  replayPendingSkillImportApprovals: defineApplicationCommand<
    'skills:conversation-import-replay-pending',
    readonly [],
    ReturnType<SkillImportApprovalBroker['replayPending']>
  >('skills:conversation-import-replay-pending')
})

const settingsSkillApplicationCommandGroup = defineApplicationCommandGroup('settings-skills', [
  settingsIntegrationApplicationCommands.setConversationSkillImportEnabled,
  settingsIntegrationApplicationCommands.setSkillEnabled,
  settingsIntegrationApplicationCommands.setSkillsEnabled,
  settingsIntegrationApplicationCommands.createSkill,
  settingsIntegrationApplicationCommands.updateSkill,
  settingsIntegrationApplicationCommands.deleteSkill,
  settingsIntegrationApplicationCommands.importSkill,
  settingsIntegrationApplicationCommands.importSkillZip,
  settingsIntegrationApplicationCommands.importSkillZipBatch
] as const)

const settingsConnectorApplicationCommandGroup = defineApplicationCommandGroup(
  'settings-connectors',
  [
    settingsIntegrationApplicationCommands.setConnectorEnabled,
    settingsIntegrationApplicationCommands.setConnectorAutoAllow,
    settingsIntegrationApplicationCommands.setToolPermission,
    settingsIntegrationApplicationCommands.setNcbiCredentials,
    settingsIntegrationApplicationCommands.setOpenAlexCredential,
    settingsIntegrationApplicationCommands.validateOpenAlexCredential,
    settingsIntegrationApplicationCommands.addCustomServer,
    settingsIntegrationApplicationCommands.setCustomServerEnabled,
    settingsIntegrationApplicationCommands.removeCustomServer,
    settingsIntegrationApplicationCommands.updateCustomServer,
    settingsIntegrationApplicationCommands.authenticateCustomServer,
    settingsIntegrationApplicationCommands.cancelCustomServerAuthentication,
    settingsIntegrationApplicationCommands.retryCustomServer
  ] as const
)

const settingsApprovalApplicationCommandGroup = defineApplicationCommandGroup(
  'settings-approvals',
  [
    settingsIntegrationApplicationCommands.respondConnectorApproval,
    settingsIntegrationApplicationCommands.replayConnectorApproval,
    settingsIntegrationApplicationCommands.replayPendingConnectorApprovals,
    settingsIntegrationApplicationCommands.respondSkillImportApproval,
    settingsIntegrationApplicationCommands.replayPendingSkillImportApprovals
  ] as const
)

type IntegrationSettingsApplicationCommandDependencies = Readonly<{
  skills: SkillIntegrationWorkflows
  connectors: ConnectorIntegrationWorkflows
  connectorApprovals: Pick<ApprovalBroker, 'getPending' | 'replayPending' | 'respond'>
  skillImportApprovals: Pick<SkillImportApprovalBroker, 'respond' | 'replayPending'>
}>

const registerIntegrationSettingsApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: IntegrationSettingsApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()

  try {
    scope.registerGroup(settingsSkillApplicationCommandGroup, {
      'settings:set-conversation-skill-import-enabled': ({ args }) =>
        dependencies.skills.setConversationSkillImportEnabled({
          enabled: readConversationSkillImportEnabled(args[0])
        }),
      'settings:set-skill-enabled': ({ args }) => dependencies.skills.setSkillEnabled(args[0]),
      'settings:set-skills-enabled': ({ args }) => dependencies.skills.setSkillsEnabled(args[0]),
      'settings:create-skill': ({ args }) => dependencies.skills.createSkill(args[0]),
      'settings:update-skill': ({ args }) => dependencies.skills.updateSkill(args[0]),
      'settings:delete-skill': ({ args }) => dependencies.skills.deleteSkill(args[0]),
      'settings:import-skill': ({ args }) => dependencies.skills.importSkill(args[0]),
      'settings:import-skill-zip': ({ args }) => dependencies.skills.importSkillZip(args[0]),
      'settings:import-skill-zip-batch': ({ args }) =>
        dependencies.skills.importSkillZipBatch(args[0])
    })
    scope.registerGroup(settingsConnectorApplicationCommandGroup, {
      'settings:set-connector-enabled': ({ args }) =>
        dependencies.connectors.setConnectorEnabled(args[0]),
      'settings:set-connector-auto-allow': ({ args }) =>
        dependencies.connectors.setConnectorAutoAllow(args[0]),
      'settings:set-tool-permission': ({ args }) =>
        dependencies.connectors.setToolPermission(args[0]),
      'settings:set-ncbi-credentials': ({ args }) =>
        dependencies.connectors.setNcbiCredentials(args[0]),
      'settings:set-openalex-credential': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-openalex-credential')
        return dependencies.connectors.setOpenAlexCredential(args[0])
      },
      'settings:validate-openalex-credential': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:validate-openalex-credential')
        return dependencies.connectors.validateOpenAlexCredential(args[0])
      },
      'settings:add-custom-server': ({ args }) => dependencies.connectors.addCustomServer(args[0]),
      'settings:set-custom-server-enabled': ({ args }) =>
        dependencies.connectors.setCustomServerEnabled(args[0]),
      'settings:remove-custom-server': ({ args }) =>
        dependencies.connectors.removeCustomServer(args[0]),
      'settings:update-custom-server': ({ args }) =>
        dependencies.connectors.updateCustomServer(args[0]),
      'settings:authenticate-custom-server': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:authenticate-custom-server')
        return dependencies.connectors.authenticateCustomServer(args[0])
      },
      'settings:cancel-custom-server-authentication': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-custom-server-authentication')
        return dependencies.connectors.cancelCustomServerAuthentication(args[0])
      },
      'settings:retry-custom-server': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:retry-custom-server')
        return dependencies.connectors.retryCustomServer(args[0])
      }
    })
    scope.registerGroup(settingsApprovalApplicationCommandGroup, {
      'connectors:approval-respond': ({ args, callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error('Only a current human caller can respond to connector approval requests.')
        }
        return dependencies.connectorApprovals.respond(args[0].id, args[0].decision)
      },
      'connectors:approval-replay': ({ args, callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error('Only a current human caller can reopen connector approval requests.')
        }
        return dependencies.connectorApprovals.getPending(args[0])
      },
      'connectors:approval-replay-pending': ({ callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error('Only a current human caller can reopen connector approval requests.')
        }
        return dependencies.connectorApprovals.replayPending()
      },
      'skills:conversation-import-respond': ({ args, callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error(
            'Only a current human caller can respond to Skill import approval requests.'
          )
        }
        return dependencies.skillImportApprovals.respond(args[0])
      },
      'skills:conversation-import-replay-pending': () =>
        dependencies.skillImportApprovals.replayPending()
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  registerIntegrationSettingsApplicationCommands,
  settingsApprovalApplicationCommandGroup,
  settingsConnectorApplicationCommandGroup,
  settingsIntegrationApplicationCommands,
  settingsSkillApplicationCommandGroup
}
export type {
  ConnectorIntegrationWorkflows,
  IntegrationSettingsApplicationCommandDependencies,
  SkillIntegrationWorkflows
}
