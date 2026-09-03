import {
  normalizeComputeApprovalDecision,
  type ComputeApprovalDecisionInput,
  type DeleteComputeHostRequest,
  type SetComputeJobRemoteCleanupRequest
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
import type { ComputeHandlers } from './ipc'

type ComputeCommandOwner = Pick<
  ComputeHandlers,
  | 'list'
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
  | 'listDir'
  | 'download'
  | 'revealInFolder'
  | 'approvalRespond'
  | 'approvalReplay'
  | 'approvalReplayPending'
  | 'jobsList'
  | 'jobsCancel'
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
  computeApplicationCommands.bookmarksGet,
  computeApplicationCommands.bookmarksSet,
  computeApplicationCommands.changeAuthentication,
  computeApplicationCommands.concurrencySet,
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

const assertLocalCommand = (context: CallerContext, channel: string): void => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
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
      'compute:jobs:set-remote-cleanup': ({ args, callerContext }) => {
        assertLocalCommand(callerContext, 'compute:jobs:set-remote-cleanup')
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
