import { computeAccountProviders } from '../../shared/compute-accounts'
import { type SetComputeJobRemoteCleanupRequest } from '@aipoch/compute'
import {
  normalizeComputeApprovalDecision,
  type ComputeApprovalDecisionInput,
  type DeleteComputeHostRequest
} from '../../shared/compute'

import {
  LIFECYCLE_CHANNELS,
  MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID
} from '../../shared/lifecycle-events'
import { encodeRemoteFsError, type SerializableRemoteFsError } from '../../shared/remote-fs'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { ApplicationEventPublisher } from '../application-events'
import { canSatisfyHumanApproval, type CallerContext } from '../caller-context'
import type { ComputeHandlers } from './handler-contract'

type ComputeCommandOwner = Pick<
  ComputeHandlers,
  | 'list'
  | 'listKubernetesTargets'
  | 'createKubernetesTarget'
  | 'listHostedTargets'
  | 'accountStatus'
  | 'connectAccount'
  | 'useLocalAccount'
  | 'cancelAccountConnection'
  | 'disconnectAccount'
  | 'listRayTokens'
  | 'setRayToken'
  | 'removeRayToken'
  | 'verifyTarget'
  | 'updateTarget'
  | 'createHostedTarget'
  | 'listRayTargets'
  | 'createRayTarget'
  | 'readOutputPreview'
  | 'listModalTargets'
  | 'createModalTarget'
  | 'get'
  | 'create'
  | 'createPassword'
  | 'resetPassword'
  | 'changeAuthentication'
  | 'passwordCapability'
  | 'delete'
  | 'deletionStatus'
  | 'sshConfigAliases'
  | 'probe'
  | 'detailsGet'
  | 'detailsSave'
  | 'scratchSet'
  | 'scratchClear'
  | 'concurrencySet'
  | 'executionModeSet'
  | 'listDir'
  | 'download'
  | 'revealInFolder'
  | 'approvalRespond'
  | 'approvalReplay'
  | 'approvalReplayPending'
  | 'jobsList'
  | 'jobsCancel'
  | 'jobsRetryHarvest'
  | 'jobsSetRemoteCleanup'
  | 'jobsPendingNotification'
  | 'jobsMarkConsumed'
  | 'jobsTransitionAnalysis'
>

type ComputeBookmarksOwner = Readonly<{
  get(providerId: string): Promise<string[]>
  set(providerId: string, folders: string[]): Promise<void>
}>

type ComputeEnabledHostsOwner = Readonly<{
  get(sessionId: string): string[]
  set(sessionId: string, providerIds: readonly string[]): Promise<PersistedChatSession>
  setHostEnabled(
    sessionId: string,
    providerId: string,
    enabled: boolean
  ): Promise<PersistedChatSession>
  setHostSelected(
    sessionId: string,
    providerId: string,
    selected: boolean
  ): Promise<PersistedChatSession>
}>

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

const computeApplicationCommands = Object.freeze({
  listKubernetesTargets: defineApplicationCommand<
    'compute:list-kubernetes-targets',
    OwnerArgs<ComputeCommandOwner, 'listKubernetesTargets'>,
    OwnerResult<ComputeCommandOwner, 'listKubernetesTargets'>
  >('compute:list-kubernetes-targets'),
  createKubernetesTarget: defineApplicationCommand<
    'compute:create-kubernetes-target',
    OwnerArgs<ComputeCommandOwner, 'createKubernetesTarget'>,
    OwnerResult<ComputeCommandOwner, 'createKubernetesTarget'>
  >('compute:create-kubernetes-target'),
  listHostedTargets: defineApplicationCommand<
    'compute:list-hosted-targets',
    OwnerArgs<ComputeCommandOwner, 'listHostedTargets'>,
    OwnerResult<ComputeCommandOwner, 'listHostedTargets'>
  >('compute:list-hosted-targets'),
  accountStatus: defineApplicationCommand<
    'compute:account-status',
    OwnerArgs<ComputeCommandOwner, 'accountStatus'>,
    OwnerResult<ComputeCommandOwner, 'accountStatus'>
  >('compute:account-status'),
  connectAccount: defineApplicationCommand<
    'compute:connect-account',
    OwnerArgs<ComputeCommandOwner, 'connectAccount'>,
    OwnerResult<ComputeCommandOwner, 'connectAccount'>
  >('compute:connect-account'),
  useLocalAccount: defineApplicationCommand<
    'compute:use-local-account',
    OwnerArgs<ComputeCommandOwner, 'useLocalAccount'>,
    OwnerResult<ComputeCommandOwner, 'useLocalAccount'>
  >('compute:use-local-account'),
  cancelAccountConnection: defineApplicationCommand<
    'compute:cancel-account-connection',
    OwnerArgs<ComputeCommandOwner, 'cancelAccountConnection'>,
    OwnerResult<ComputeCommandOwner, 'cancelAccountConnection'>
  >('compute:cancel-account-connection'),
  disconnectAccount: defineApplicationCommand<
    'compute:disconnect-account',
    OwnerArgs<ComputeCommandOwner, 'disconnectAccount'>,
    OwnerResult<ComputeCommandOwner, 'disconnectAccount'>
  >('compute:disconnect-account'),
  listRayTokens: defineApplicationCommand<
    'compute:list-ray-tokens',
    OwnerArgs<ComputeCommandOwner, 'listRayTokens'>,
    OwnerResult<ComputeCommandOwner, 'listRayTokens'>
  >('compute:list-ray-tokens'),
  setRayToken: defineApplicationCommand<
    'compute:set-ray-token',
    OwnerArgs<ComputeCommandOwner, 'setRayToken'>,
    OwnerResult<ComputeCommandOwner, 'setRayToken'>
  >('compute:set-ray-token'),
  removeRayToken: defineApplicationCommand<
    'compute:remove-ray-token',
    OwnerArgs<ComputeCommandOwner, 'removeRayToken'>,
    OwnerResult<ComputeCommandOwner, 'removeRayToken'>
  >('compute:remove-ray-token'),
  verifyTarget: defineApplicationCommand<
    'compute:verify-target',
    OwnerArgs<ComputeCommandOwner, 'verifyTarget'>,
    OwnerResult<ComputeCommandOwner, 'verifyTarget'>
  >('compute:verify-target'),
  updateTarget: defineApplicationCommand<
    'compute:update-target',
    OwnerArgs<ComputeCommandOwner, 'updateTarget'>,
    OwnerResult<ComputeCommandOwner, 'updateTarget'>
  >('compute:update-target'),
  createHostedTarget: defineApplicationCommand<
    'compute:create-hosted-target',
    OwnerArgs<ComputeCommandOwner, 'createHostedTarget'>,
    OwnerResult<ComputeCommandOwner, 'createHostedTarget'>
  >('compute:create-hosted-target'),
  listRayTargets: defineApplicationCommand<
    'compute:list-ray-targets',
    OwnerArgs<ComputeCommandOwner, 'listRayTargets'>,
    OwnerResult<ComputeCommandOwner, 'listRayTargets'>
  >('compute:list-ray-targets'),
  createRayTarget: defineApplicationCommand<
    'compute:create-ray-target',
    OwnerArgs<ComputeCommandOwner, 'createRayTarget'>,
    OwnerResult<ComputeCommandOwner, 'createRayTarget'>
  >('compute:create-ray-target'),
  readOutputPreview: defineApplicationCommand<
    'compute:read-output-preview',
    OwnerArgs<ComputeCommandOwner, 'readOutputPreview'>,
    OwnerResult<ComputeCommandOwner, 'readOutputPreview'>
  >('compute:read-output-preview'),
  listModalTargets: defineApplicationCommand<
    'compute:list-modal-targets',
    OwnerArgs<ComputeCommandOwner, 'listModalTargets'>,
    OwnerResult<ComputeCommandOwner, 'listModalTargets'>
  >('compute:list-modal-targets'),
  createModalTarget: defineApplicationCommand<
    'compute:create-modal-target',
    OwnerArgs<ComputeCommandOwner, 'createModalTarget'>,
    OwnerResult<ComputeCommandOwner, 'createModalTarget'>
  >('compute:create-modal-target'),
  list: defineApplicationCommand<
    'compute:list',
    OwnerArgs<ComputeCommandOwner, 'list'>,
    OwnerResult<ComputeCommandOwner, 'list'>
  >('compute:list'),
  get: defineApplicationCommand<
    'compute:get',
    OwnerArgs<ComputeCommandOwner, 'get'>,
    OwnerResult<ComputeCommandOwner, 'get'>
  >('compute:get'),
  create: defineApplicationCommand<
    'compute:create',
    OwnerArgs<ComputeCommandOwner, 'create'>,
    OwnerResult<ComputeCommandOwner, 'create'>
  >('compute:create'),
  createPassword: defineApplicationCommand<
    'compute:create-password',
    OwnerArgs<ComputeCommandOwner, 'createPassword'>,
    OwnerResult<ComputeCommandOwner, 'createPassword'>
  >('compute:create-password'),
  resetPassword: defineApplicationCommand<
    'compute:reset-password',
    OwnerArgs<ComputeCommandOwner, 'resetPassword'>,
    OwnerResult<ComputeCommandOwner, 'resetPassword'>
  >('compute:reset-password'),
  changeAuthentication: defineApplicationCommand<
    'compute:change-authentication',
    OwnerArgs<ComputeCommandOwner, 'changeAuthentication'>,
    OwnerResult<ComputeCommandOwner, 'changeAuthentication'>
  >('compute:change-authentication'),
  passwordCapability: defineApplicationCommand<
    'compute:password-capability',
    OwnerArgs<ComputeCommandOwner, 'passwordCapability'>,
    OwnerResult<ComputeCommandOwner, 'passwordCapability'>
  >('compute:password-capability'),
  delete: defineApplicationCommand<
    'compute:delete',
    readonly [DeleteComputeHostRequest],
    OwnerResult<ComputeCommandOwner, 'delete'>
  >('compute:delete'),
  deletionStatus: defineApplicationCommand<
    'compute:deletion-status',
    readonly [DeleteComputeHostRequest],
    OwnerResult<ComputeCommandOwner, 'deletionStatus'>
  >('compute:deletion-status'),
  sshConfigAliases: defineApplicationCommand<
    'compute:ssh-config-aliases',
    OwnerArgs<ComputeCommandOwner, 'sshConfigAliases'>,
    OwnerResult<ComputeCommandOwner, 'sshConfigAliases'>
  >('compute:ssh-config-aliases'),
  probe: defineApplicationCommand<
    'compute:probe',
    OwnerArgs<ComputeCommandOwner, 'probe'>,
    OwnerResult<ComputeCommandOwner, 'probe'>
  >('compute:probe'),
  detailsGet: defineApplicationCommand<
    'compute:details:get',
    OwnerArgs<ComputeCommandOwner, 'detailsGet'>,
    OwnerResult<ComputeCommandOwner, 'detailsGet'>
  >('compute:details:get'),
  detailsSave: defineApplicationCommand<
    'compute:details:save',
    OwnerArgs<ComputeCommandOwner, 'detailsSave'>,
    OwnerResult<ComputeCommandOwner, 'detailsSave'>
  >('compute:details:save'),
  scratchSet: defineApplicationCommand<
    'compute:scratch:set',
    OwnerArgs<ComputeCommandOwner, 'scratchSet'>,
    OwnerResult<ComputeCommandOwner, 'scratchSet'>
  >('compute:scratch:set'),
  scratchClear: defineApplicationCommand<
    'compute:scratch:clear',
    OwnerArgs<ComputeCommandOwner, 'scratchClear'>,
    OwnerResult<ComputeCommandOwner, 'scratchClear'>
  >('compute:scratch:clear'),
  concurrencySet: defineApplicationCommand<
    'compute:concurrency:set',
    OwnerArgs<ComputeCommandOwner, 'concurrencySet'>,
    OwnerResult<ComputeCommandOwner, 'concurrencySet'>
  >('compute:concurrency:set'),
  executionModeSet: defineApplicationCommand<
    'compute:execution-mode:set',
    OwnerArgs<ComputeCommandOwner, 'executionModeSet'>,
    OwnerResult<ComputeCommandOwner, 'executionModeSet'>
  >('compute:execution-mode:set'),
  listDir: defineApplicationCommand<
    'compute:list-dir',
    OwnerArgs<ComputeCommandOwner, 'listDir'>,
    OwnerResult<ComputeCommandOwner, 'listDir'>
  >('compute:list-dir'),
  download: defineApplicationCommand<
    'compute:download',
    OwnerArgs<ComputeCommandOwner, 'download'>,
    OwnerResult<ComputeCommandOwner, 'download'>
  >('compute:download'),
  revealInFolder: defineApplicationCommand<
    'compute:reveal-in-folder',
    OwnerArgs<ComputeCommandOwner, 'revealInFolder'>,
    OwnerResult<ComputeCommandOwner, 'revealInFolder'>
  >('compute:reveal-in-folder'),
  approvalRespond: defineApplicationCommand<
    'compute:approval-respond',
    readonly [{ id: string; decision: ComputeApprovalDecisionInput }],
    OwnerResult<ComputeCommandOwner, 'approvalRespond'>
  >('compute:approval-respond'),
  approvalReplay: defineApplicationCommand<
    'compute:approval-replay',
    readonly [id: string],
    OwnerResult<ComputeCommandOwner, 'approvalReplay'>
  >('compute:approval-replay'),
  approvalReplayPending: defineApplicationCommand<
    'compute:approval-replay-pending',
    readonly [],
    OwnerResult<ComputeCommandOwner, 'approvalReplayPending'>
  >('compute:approval-replay-pending'),
  jobsList: defineApplicationCommand<
    'compute:jobs:list',
    OwnerArgs<ComputeCommandOwner, 'jobsList'>,
    OwnerResult<ComputeCommandOwner, 'jobsList'>
  >('compute:jobs:list'),
  jobsCancel: defineApplicationCommand<
    'compute:jobs:cancel',
    OwnerArgs<ComputeCommandOwner, 'jobsCancel'>,
    OwnerResult<ComputeCommandOwner, 'jobsCancel'>
  >('compute:jobs:cancel'),
  jobsRetryHarvest: defineApplicationCommand<
    'compute:jobs:retry-harvest',
    OwnerArgs<ComputeCommandOwner, 'jobsRetryHarvest'>,
    OwnerResult<ComputeCommandOwner, 'jobsRetryHarvest'>
  >('compute:jobs:retry-harvest'),
  jobsSetRemoteCleanup: defineApplicationCommand<
    'compute:jobs:set-remote-cleanup',
    readonly [SetComputeJobRemoteCleanupRequest],
    OwnerResult<ComputeCommandOwner, 'jobsSetRemoteCleanup'>
  >('compute:jobs:set-remote-cleanup'),
  jobsPendingNotification: defineApplicationCommand<
    'compute:jobs:pending-notification',
    OwnerArgs<ComputeCommandOwner, 'jobsPendingNotification'>,
    OwnerResult<ComputeCommandOwner, 'jobsPendingNotification'>
  >('compute:jobs:pending-notification'),
  jobsMarkConsumed: defineApplicationCommand<
    'compute:jobs:mark-consumed',
    OwnerArgs<ComputeCommandOwner, 'jobsMarkConsumed'>,
    OwnerResult<ComputeCommandOwner, 'jobsMarkConsumed'>
  >('compute:jobs:mark-consumed'),
  jobsTransitionAnalysis: defineApplicationCommand<
    'compute:jobs:transition-analysis',
    OwnerArgs<ComputeCommandOwner, 'jobsTransitionAnalysis'>,
    OwnerResult<ComputeCommandOwner, 'jobsTransitionAnalysis'>
  >('compute:jobs:transition-analysis'),
  enabledHostsGet: defineApplicationCommand<
    'compute:enabled-hosts:get',
    OwnerArgs<ComputeEnabledHostsOwner, 'get'>,
    OwnerResult<ComputeEnabledHostsOwner, 'get'>
  >('compute:enabled-hosts:get'),
  enabledHostsSet: defineApplicationCommand<
    'compute:enabled-hosts:set',
    OwnerArgs<ComputeEnabledHostsOwner, 'set'>,
    OwnerResult<ComputeEnabledHostsOwner, 'set'>
  >('compute:enabled-hosts:set'),
  hostEnabledSet: defineApplicationCommand<
    'compute:host-enabled:set',
    OwnerArgs<ComputeEnabledHostsOwner, 'setHostEnabled'>,
    OwnerResult<ComputeEnabledHostsOwner, 'setHostEnabled'>
  >('compute:host-enabled:set'),
  hostSelectedSet: defineApplicationCommand<
    'compute:host-selected:set',
    OwnerArgs<ComputeEnabledHostsOwner, 'setHostSelected'>,
    OwnerResult<ComputeEnabledHostsOwner, 'setHostSelected'>
  >('compute:host-selected:set'),
  bookmarksGet: defineApplicationCommand<
    'compute:bookmarks:get',
    OwnerArgs<ComputeBookmarksOwner, 'get'>,
    OwnerResult<ComputeBookmarksOwner, 'get'>
  >('compute:bookmarks:get'),
  bookmarksSet: defineApplicationCommand<
    'compute:bookmarks:set',
    OwnerArgs<ComputeBookmarksOwner, 'set'>,
    OwnerResult<ComputeBookmarksOwner, 'set'>
  >('compute:bookmarks:set')
})

const computeApplicationCommandGroup = defineApplicationCommandGroup('compute', [
  computeApplicationCommands.accountStatus,
  computeApplicationCommands.connectAccount,
  computeApplicationCommands.useLocalAccount,
  computeApplicationCommands.cancelAccountConnection,
  computeApplicationCommands.disconnectAccount,
  computeApplicationCommands.listRayTokens,
  computeApplicationCommands.setRayToken,
  computeApplicationCommands.removeRayToken,
  computeApplicationCommands.verifyTarget,
  computeApplicationCommands.updateTarget,
  computeApplicationCommands.listKubernetesTargets,
  computeApplicationCommands.createKubernetesTarget,
  computeApplicationCommands.listHostedTargets,
  computeApplicationCommands.createHostedTarget,
  computeApplicationCommands.listRayTargets,
  computeApplicationCommands.createRayTarget,
  computeApplicationCommands.readOutputPreview,
  computeApplicationCommands.listModalTargets,
  computeApplicationCommands.createModalTarget,
  computeApplicationCommands.bookmarksGet,
  computeApplicationCommands.bookmarksSet,
  computeApplicationCommands.changeAuthentication,
  computeApplicationCommands.concurrencySet,
  computeApplicationCommands.executionModeSet,
  computeApplicationCommands.create,
  computeApplicationCommands.createPassword,
  computeApplicationCommands.delete,
  computeApplicationCommands.deletionStatus,
  computeApplicationCommands.detailsGet,
  computeApplicationCommands.detailsSave,
  computeApplicationCommands.download,
  computeApplicationCommands.enabledHostsGet,
  computeApplicationCommands.enabledHostsSet,
  computeApplicationCommands.hostEnabledSet,
  computeApplicationCommands.hostSelectedSet,
  computeApplicationCommands.get,
  computeApplicationCommands.jobsList,
  computeApplicationCommands.jobsCancel,
  computeApplicationCommands.jobsRetryHarvest,
  computeApplicationCommands.jobsSetRemoteCleanup,
  computeApplicationCommands.jobsMarkConsumed,
  computeApplicationCommands.jobsPendingNotification,
  computeApplicationCommands.jobsTransitionAnalysis,
  computeApplicationCommands.list,
  computeApplicationCommands.listDir,
  computeApplicationCommands.passwordCapability,
  computeApplicationCommands.probe,
  computeApplicationCommands.approvalReplay,
  computeApplicationCommands.approvalReplayPending,
  computeApplicationCommands.resetPassword,
  computeApplicationCommands.approvalRespond,
  computeApplicationCommands.revealInFolder,
  computeApplicationCommands.scratchSet,
  computeApplicationCommands.scratchClear,
  computeApplicationCommands.sshConfigAliases
] as const)

type ComputeApplicationCommandDependencies = Readonly<{
  compute: ComputeCommandOwner
  bookmarks: ComputeBookmarksOwner
  enabledHosts: ComputeEnabledHostsOwner
  events: ApplicationEventPublisher
}>

const withSerializedRemoteFsError = async <Result>(
  operation: () => Promise<Result>
): Promise<Result> => {
  try {
    return await operation()
  } catch (error) {
    const failure = error as Error & { remoteFsError?: SerializableRemoteFsError }
    if (failure.remoteFsError) {
      throw new Error(encodeRemoteFsError(failure.message, failure.remoteFsError))
    }
    throw error
  }
}

function assertAccountProvider(provider: (typeof computeAccountProviders)[number]): void {
  if (!computeAccountProviders.includes(provider))
    throw new Error('Unknown compute account provider.')
}

const assertLocalCommand = (context: CallerContext, channel: string): void => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
}

function assertAccountSettingsCaller(context: CallerContext, channel: string): void {
  assertLocalCommand(context, channel)
  if (!canSatisfyHumanApproval(context)) throw new Error('Account settings require a local user.')
}

const registerComputeApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: ComputeApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  const commitComputeHostAccess = async (
    operation: () => Promise<PersistedChatSession>
  ): Promise<PersistedChatSession> => {
    const session = await operation()
    try {
      dependencies.events.publish(LIFECYCLE_CHANNELS.sessionUpdated, {
        session,
        originClientId: MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID
      })
    } catch {
      // Lifecycle delivery cannot roll back committed Session authority.
    }
    return session
  }
  try {
    scope.registerGroup(computeApplicationCommandGroup, {
      'compute:list-kubernetes-targets': () => dependencies.compute.listKubernetesTargets(),
      'compute:create-kubernetes-target': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:create-kubernetes-target')
        return dependencies.compute.createKubernetesTarget(args[0])
      },
      'compute:list-hosted-targets': () => dependencies.compute.listHostedTargets(),
      'compute:account-status': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:account-status')
        assertAccountProvider(args[0])
        if (args[1] !== undefined && typeof args[1] !== 'boolean')
          throw new Error('Invalid refresh option.')
        return dependencies.compute.accountStatus(...args)
      },
      'compute:connect-account': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:connect-account')
        assertAccountProvider(args[0])
        return dependencies.compute.connectAccount(args[0])
      },
      'compute:use-local-account': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:use-local-account')
        assertAccountProvider(args[0])
        return dependencies.compute.useLocalAccount(args[0])
      },
      'compute:cancel-account-connection': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:cancel-account-connection')
        assertAccountProvider(args[0])
        return dependencies.compute.cancelAccountConnection(args[0])
      },
      'compute:disconnect-account': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:disconnect-account')
        assertAccountProvider(args[0])
        return dependencies.compute.disconnectAccount(args[0])
      },
      'compute:list-ray-tokens': ({ callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:list-ray-tokens')
        return dependencies.compute.listRayTokens()
      },
      'compute:set-ray-token': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:set-ray-token')
        return dependencies.compute.setRayToken(...args)
      },
      'compute:remove-ray-token': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:remove-ray-token')
        return dependencies.compute.removeRayToken(...args)
      },
      'compute:verify-target': ({ args, callerContext }) => {
        assertAccountSettingsCaller(callerContext, 'compute:verify-target')
        if (typeof args[0] !== 'string') throw new Error('Invalid compute target.')
        return dependencies.compute.verifyTarget(args[0])
      },
      'compute:update-target': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:update-target')
        return dependencies.compute.updateTarget(...args)
      },
      'compute:create-hosted-target': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:create-hosted-target')
        return dependencies.compute.createHostedTarget(args[0])
      },
      'compute:list-ray-targets': () => dependencies.compute.listRayTargets(),
      'compute:create-ray-target': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:create-ray-target')
        return dependencies.compute.createRayTarget(args[0])
      },
      'compute:read-output-preview': ({ args }) => dependencies.compute.readOutputPreview(args[0]),
      'compute:list-modal-targets': () => dependencies.compute.listModalTargets(),
      'compute:create-modal-target': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:create-modal-target')
        return dependencies.compute.createModalTarget(args[0])
      },
      'compute:list': () => dependencies.compute.list(),
      'compute:get': ({ args }) => dependencies.compute.get(args[0]),
      'compute:create': ({ args }) => dependencies.compute.create(args[0]),
      'compute:create-password': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:create-password')
        return dependencies.compute.createPassword(args[0])
      },
      'compute:reset-password': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:reset-password')
        return dependencies.compute.resetPassword(args[0])
      },
      'compute:change-authentication': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:change-authentication')
        return dependencies.compute.changeAuthentication(args[0])
      },
      'compute:password-capability': ({ callerContext }) => {
        assertLocalCommand(callerContext, 'compute:password-capability')
        return dependencies.compute.passwordCapability()
      },
      'compute:delete': ({ args, callerContext }) =>
        dependencies.compute.delete(args[0].providerId, {
          allowPasswordCredentialDeletion: callerContext.location === 'local'
        }),
      'compute:deletion-status': ({ args }) =>
        dependencies.compute.deletionStatus(args[0].providerId),
      'compute:ssh-config-aliases': () => dependencies.compute.sshConfigAliases(),
      'compute:probe': ({ args }) => dependencies.compute.probe(args[0]),
      'compute:details:get': ({ args }) => dependencies.compute.detailsGet(args[0]),
      'compute:details:save': ({ args }) =>
        dependencies.compute.detailsSave(args[0], args[1], args[2], args[3]),
      'compute:scratch:set': ({ args }) => dependencies.compute.scratchSet(args[0], args[1]),
      'compute:scratch:clear': ({ args }) => dependencies.compute.scratchClear(args[0]),
      'compute:concurrency:set': ({ args }) =>
        dependencies.compute.concurrencySet(args[0], args[1]),
      'compute:execution-mode:set': ({ args }) =>
        dependencies.compute.executionModeSet(args[0], args[1]),
      'compute:list-dir': ({ args }) =>
        withSerializedRemoteFsError(() => dependencies.compute.listDir(args[0], args[1])),
      'compute:download': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:download')
        return withSerializedRemoteFsError(() =>
          dependencies.compute.download(args[0], args[1], args[2])
        )
      },
      'compute:reveal-in-folder': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:reveal-in-folder')
        return dependencies.compute.revealInFolder(args[0])
      },
      'compute:approval-respond': ({ args, callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error('Only a current human caller can respond to compute approval requests.')
        }
        return dependencies.compute.approvalRespond(
          args[0].id,
          normalizeComputeApprovalDecision(args[0].decision)
        )
      },
      'compute:approval-replay': ({ args, callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error('Only a current human caller can reopen compute approval requests.')
        }
        return dependencies.compute.approvalReplay(args[0])
      },
      'compute:approval-replay-pending': ({ callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error('Only a current human caller can reopen compute approval requests.')
        }
        return dependencies.compute.approvalReplayPending()
      },
      'compute:jobs:list': ({ args }) => dependencies.compute.jobsList(args[0]),
      'compute:jobs:cancel': ({ args }) => dependencies.compute.jobsCancel(args[0]),
      'compute:jobs:retry-harvest': ({ args }) => dependencies.compute.jobsRetryHarvest(args[0]),
      'compute:jobs:set-remote-cleanup': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:jobs:set-remote-cleanup')
        if (args[0].manualStagedCleanup && !canSatisfyHumanApproval(callerContext))
          throw new Error('Staged resource cleanup requires a current local user.')
        return dependencies.compute.jobsSetRemoteCleanup(args[0])
      },
      'compute:jobs:pending-notification': ({ args }) =>
        dependencies.compute.jobsPendingNotification(args[0]),
      'compute:jobs:mark-consumed': ({ args }) =>
        dependencies.compute.jobsMarkConsumed(args[0], args[1]),
      'compute:jobs:transition-analysis': ({ args }) =>
        dependencies.compute.jobsTransitionAnalysis(args[0]),
      'compute:enabled-hosts:get': ({ args }) => dependencies.enabledHosts.get(args[0]),
      'compute:enabled-hosts:set': ({ args }) =>
        commitComputeHostAccess(() => dependencies.enabledHosts.set(args[0], args[1])),
      'compute:host-enabled:set': ({ args }) =>
        commitComputeHostAccess(() =>
          dependencies.enabledHosts.setHostEnabled(args[0], args[1], args[2])
        ),
      'compute:host-selected:set': ({ args }) =>
        commitComputeHostAccess(() =>
          dependencies.enabledHosts.setHostSelected(args[0], args[1], args[2])
        ),
      'compute:bookmarks:get': ({ args }) => dependencies.bookmarks.get(args[0]),
      'compute:bookmarks:set': ({ args }) => dependencies.bookmarks.set(args[0], args[1])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  computeApplicationCommandGroup,
  computeApplicationCommands,
  registerComputeApplicationCommands
}
export type {
  ComputeApplicationCommandDependencies,
  ComputeBookmarksOwner,
  ComputeCommandOwner,
  ComputeEnabledHostsOwner
}
