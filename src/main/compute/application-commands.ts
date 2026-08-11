import type { ComputeApprovalDecision, DeleteComputeHostRequest } from '../../shared/compute'
import { encodeRemoteFsError, type SerializableRemoteFsError } from '../../shared/remote-fs'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import { canSatisfyHumanApproval, type CallerContext } from '../caller-context'
import type { ComputeHandlers } from './ipc'

type ComputeCommandOwner = Pick<
  ComputeHandlers,
  | 'list'
  | 'get'
  | 'create'
  | 'delete'
  | 'sshConfigAliases'
  | 'probe'
  | 'detailsGet'
  | 'detailsSave'
  | 'scratchSet'
  | 'concurrencySet'
  | 'listDir'
  | 'download'
  | 'revealInFolder'
  | 'approvalRespond'
  | 'approvalReplay'
  | 'jobsList'
  | 'jobsPendingNotification'
  | 'jobsMarkConsumed'
>

type ComputeBookmarksOwner = Readonly<{
  get(providerId: string): Promise<string[]>
  set(providerId: string, folders: string[]): Promise<void>
}>

type ComputeEnabledHostsOwner = Readonly<{
  get(sessionId: string): string[]
  set(sessionId: string, providerIds: string[]): void
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
  delete: defineApplicationCommand<
    'compute:delete',
    readonly [DeleteComputeHostRequest],
    OwnerResult<ComputeCommandOwner, 'delete'>
  >('compute:delete'),
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
    readonly [{ id: string; decision: ComputeApprovalDecision }],
    OwnerResult<ComputeCommandOwner, 'approvalRespond'>
  >('compute:approval-respond'),
  approvalReplay: defineApplicationCommand<
    'compute:approval-replay',
    readonly [id: string],
    OwnerResult<ComputeCommandOwner, 'approvalReplay'>
  >('compute:approval-replay'),
  jobsList: defineApplicationCommand<
    'compute:jobs:list',
    OwnerArgs<ComputeCommandOwner, 'jobsList'>,
    OwnerResult<ComputeCommandOwner, 'jobsList'>
  >('compute:jobs:list'),
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
  computeApplicationCommands.concurrencySet,
  computeApplicationCommands.create,
  computeApplicationCommands.delete,
  computeApplicationCommands.detailsGet,
  computeApplicationCommands.detailsSave,
  computeApplicationCommands.download,
  computeApplicationCommands.enabledHostsGet,
  computeApplicationCommands.enabledHostsSet,
  computeApplicationCommands.get,
  computeApplicationCommands.jobsList,
  computeApplicationCommands.jobsMarkConsumed,
  computeApplicationCommands.jobsPendingNotification,
  computeApplicationCommands.list,
  computeApplicationCommands.listDir,
  computeApplicationCommands.probe,
  computeApplicationCommands.approvalReplay,
  computeApplicationCommands.approvalRespond,
  computeApplicationCommands.revealInFolder,
  computeApplicationCommands.scratchSet,
  computeApplicationCommands.sshConfigAliases
] as const)

type ComputeApplicationCommandDependencies = Readonly<{
  compute: ComputeCommandOwner
  bookmarks: ComputeBookmarksOwner
  enabledHosts: ComputeEnabledHostsOwner
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
  try {
    scope.registerGroup(computeApplicationCommandGroup, {
      'compute:list': () => dependencies.compute.list(),
      'compute:get': ({ args }) => dependencies.compute.get(args[0]),
      'compute:create': ({ args }) => dependencies.compute.create(args[0]),
      'compute:delete': ({ args }) => dependencies.compute.delete(args[0].providerId),
      'compute:ssh-config-aliases': () => dependencies.compute.sshConfigAliases(),
      'compute:probe': ({ args }) => dependencies.compute.probe(args[0]),
      'compute:details:get': ({ args }) => dependencies.compute.detailsGet(args[0]),
      'compute:details:save': ({ args }) =>
        dependencies.compute.detailsSave(args[0], args[1], args[2], args[3]),
      'compute:scratch:set': ({ args }) => dependencies.compute.scratchSet(args[0], args[1]),
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
        return dependencies.compute.approvalRespond(args[0].id, args[0].decision)
      },
      'compute:approval-replay': ({ args, callerContext }) => {
        if (!canSatisfyHumanApproval(callerContext)) {
          throw new Error('Only a current human caller can reopen compute approval requests.')
        }
        return dependencies.compute.approvalReplay(args[0])
      },
      'compute:jobs:list': ({ args }) => dependencies.compute.jobsList(args[0]),
      'compute:jobs:pending-notification': ({ args }) =>
        dependencies.compute.jobsPendingNotification(args[0]),
      'compute:jobs:mark-consumed': ({ args }) =>
        dependencies.compute.jobsMarkConsumed(args[0], args[1]),
      'compute:enabled-hosts:get': ({ args }) => dependencies.enabledHosts.get(args[0]),
      'compute:enabled-hosts:set': ({ args }) => dependencies.enabledHosts.set(args[0], args[1]),
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
