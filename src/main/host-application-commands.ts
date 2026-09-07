import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../shared/artifacts'
import type { CliLauncherStatus } from '../shared/cli'
import type {
  GrantLocalRootRequest,
  GrantedLocalRoot,
  LocalDirListing,
  LocalDrive,
  LocalRoots,
  RemoveGrantedLocalRootRequest,
  SetGrantedLocalRootAccessRequest
} from '../shared/local-fs'
import type { LogFileStatus, OpenLogFileResult, RevealLogFileResult } from '../shared/logs'
import type {
  NotificationInboxSnapshot,
  NotificationMarkAllReadRequest,
  NotificationMarkReadRequest,
  NotificationMarkSessionCompletionsReadRequest,
  OpenSessionFromNotificationRequest
} from '../shared/notifications'
import type {
  ApproveRemotePairingRequest,
  RemoteAccessSnapshot,
  RemotePairingRequestId,
  RevokeRemoteBrowserRequest,
  SetRemoteAccessModeRequest
} from '../shared/remote-access'
import { remoteAccessApplicationCommandContracts } from '../shared/remote-access'
import type {
  ReviewRunRequest,
  ReviewRunResult,
  ReviewSessionRequest,
  ReviewWithChecks
} from '../shared/reviewer'
import type { RendererSessionPersistenceTarget } from './session-persistence/renderer-flush'
import type { SessionPersistenceFlushResponse } from '../shared/session-persistence-flush'
import type {
  ActiveSessionInfo,
  DataRootInspection,
  DataRootValidationResult,
  DiscardMigratedCopyResult,
  MigrationOutcome,
  RevealAppStorageResult,
  StorageInfo,
  StorageStatus
} from '../shared/storage'
import type {
  AppInfo,
  UpdateApplyOptions,
  UpdateDownloadOptions,
  UpdateStatus
} from '../shared/update'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from './application-command-router'
import type { CallerContext } from './caller-context'
import type { CliCommandOwner } from './cli-install/ipc'
import type { GithubCommandOwner } from './github-ipc'
import type { LocalFsService } from './local-fs/service'
import type { LogsCommandOwner } from './logs-ipc'
import {
  requireNotificationMarkAllReadRequest,
  requireNotificationMarkReadRequest,
  requireNotificationMarkSessionCompletionsReadRequest
} from './notifications/notification-inbox-requests'
import {
  canManagePairing,
  isDesktopCaller,
  requireDesktopCaller,
  requirePairingManager
} from './remote-access/ipc'
import type { RemoteAccessService } from './remote-access/service'
import type { ReviewerCommandOwner } from './reviewer/ipc'
import type { UpdateCommandOwner } from './update/ipc'

type StorageParentRequest = Readonly<{ parent: string }>
type StorageRootRequest = Readonly<{ parent: string; markOnboarding?: boolean }>

const cliCommands = Object.freeze({
  getStatus: defineApplicationCommand<'cli:get-status', readonly [], CliLauncherStatus>(
    'cli:get-status'
  ),
  install: defineApplicationCommand<'cli:install', readonly [], CliLauncherStatus>('cli:install'),
  uninstall: defineApplicationCommand<'cli:uninstall', readonly [], CliLauncherStatus>(
    'cli:uninstall'
  )
})

const githubCommands = Object.freeze({
  getStars: defineApplicationCommand<'github:get-stars', readonly [], number | null>(
    'github:get-stars'
  )
})

const localFsCommands = Object.freeze({
  getRoots: defineApplicationCommand<'local-fs:get-roots', readonly [], LocalRoots>(
    'local-fs:get-roots'
  ),
  grantRoot: defineApplicationCommand<
    'local-fs:grant-root',
    readonly [request: GrantLocalRootRequest],
    GrantedLocalRoot[]
  >('local-fs:grant-root'),
  listDir: defineApplicationCommand<'local-fs:list-dir', readonly [path: string], LocalDirListing>(
    'local-fs:list-dir'
  ),
  listDrives: defineApplicationCommand<'local-fs:list-drives', readonly [], LocalDrive[]>(
    'local-fs:list-drives'
  ),
  listGrantedRoots: defineApplicationCommand<
    'local-fs:granted-roots:list',
    readonly [],
    GrantedLocalRoot[]
  >('local-fs:granted-roots:list'),
  openPath: defineApplicationCommand<'local-fs:open-path', readonly [path: string], string>(
    'local-fs:open-path'
  ),
  readPreview: defineApplicationCommand<
    'local-fs:read-preview',
    readonly [request: ReadArtifactPreviewRequest],
    ArtifactPreviewResult
  >('local-fs:read-preview'),
  removeGrantedRoot: defineApplicationCommand<
    'local-fs:granted-roots:remove',
    readonly [request: RemoveGrantedLocalRootRequest],
    GrantedLocalRoot[]
  >('local-fs:granted-roots:remove'),
  reveal: defineApplicationCommand<'local-fs:reveal', readonly [path: string], void>(
    'local-fs:reveal'
  ),
  setGrantedRootAccess: defineApplicationCommand<
    'local-fs:granted-roots:set-access',
    readonly [request: SetGrantedLocalRootAccessRequest],
    GrantedLocalRoot[]
  >('local-fs:granted-roots:set-access')
})

const logsCommands = Object.freeze({
  getStatus: defineApplicationCommand<'logs:get-status', readonly [], LogFileStatus>(
    'logs:get-status'
  ),
  openFile: defineApplicationCommand<'logs:open-file', readonly [], OpenLogFileResult>(
    'logs:open-file'
  ),
  revealInFolder: defineApplicationCommand<
    'logs:reveal-in-folder',
    readonly [],
    RevealLogFileResult
  >('logs:reveal-in-folder')
})

const notificationCommands = Object.freeze({
  getSnapshot: defineApplicationCommand<
    'notifications:get-snapshot',
    readonly [],
    NotificationInboxSnapshot
  >('notifications:get-snapshot'),
  markAllRead: defineApplicationCommand<
    'notifications:mark-all-read',
    readonly [request: NotificationMarkAllReadRequest],
    void
  >('notifications:mark-all-read'),
  markRead: defineApplicationCommand<
    'notifications:mark-read',
    readonly [request: NotificationMarkReadRequest],
    void
  >('notifications:mark-read'),
  markSessionCompletionsRead: defineApplicationCommand<
    'notifications:mark-session-completions-read',
    readonly [request: NotificationMarkSessionCompletionsReadRequest],
    void
  >('notifications:mark-session-completions-read'),
  peekPendingOpenSession: defineApplicationCommand<
    'notifications:peek-pending-open-session',
    readonly [],
    OpenSessionFromNotificationRequest | null
  >('notifications:peek-pending-open-session'),
  takePendingOpenSession: defineApplicationCommand<
    'notifications:take-pending-open-session',
    readonly [expectedToken: unknown],
    OpenSessionFromNotificationRequest | null
  >('notifications:take-pending-open-session')
})

const remoteAccessCommands = Object.freeze({
  approve: defineApplicationCommand<
    'remote-access:approve',
    readonly [request: ApproveRemotePairingRequest],
    RemoteAccessSnapshot
  >('remote-access:approve', remoteAccessApplicationCommandContracts.approve),
  detect: defineApplicationCommand<'remote-access:detect', readonly [], RemoteAccessSnapshot>(
    'remote-access:detect',
    remoteAccessApplicationCommandContracts.detect
  ),
  probe: defineApplicationCommand<'remote-access:probe', readonly [], RemoteAccessSnapshot>(
    'remote-access:probe',
    remoteAccessApplicationCommandContracts.probe
  ),
  disable: defineApplicationCommand<'remote-access:disable', readonly [], RemoteAccessSnapshot>(
    'remote-access:disable',
    remoteAccessApplicationCommandContracts.disable
  ),
  getSnapshot: defineApplicationCommand<
    'remote-access:get-snapshot',
    readonly [],
    RemoteAccessSnapshot
  >('remote-access:get-snapshot', remoteAccessApplicationCommandContracts.getSnapshot),
  reject: defineApplicationCommand<
    'remote-access:reject',
    readonly [request: RemotePairingRequestId],
    RemoteAccessSnapshot
  >('remote-access:reject', remoteAccessApplicationCommandContracts.reject),
  revokeBrowser: defineApplicationCommand<
    'remote-access:revoke-browser',
    readonly [request: RevokeRemoteBrowserRequest],
    RemoteAccessSnapshot
  >('remote-access:revoke-browser', remoteAccessApplicationCommandContracts.revokeBrowser),
  setMode: defineApplicationCommand<
    'remote-access:set-mode',
    readonly [request: SetRemoteAccessModeRequest],
    RemoteAccessSnapshot
  >('remote-access:set-mode', remoteAccessApplicationCommandContracts.setMode)
})

const reviewerCommands = Object.freeze({
  abort: defineApplicationCommand<'reviewer:abort', readonly [request: ReviewSessionRequest], void>(
    'reviewer:abort'
  ),
  abortFixLoop: defineApplicationCommand<
    'reviewer:abort-fix-loop',
    readonly [request: ReviewSessionRequest],
    void
  >('reviewer:abort-fix-loop'),
  getForSession: defineApplicationCommand<
    'reviewer:get-for-session',
    readonly [request: ReviewSessionRequest],
    ReviewWithChecks[]
  >('reviewer:get-for-session'),
  run: defineApplicationCommand<
    'reviewer:run',
    readonly [request: ReviewRunRequest],
    ReviewRunResult
  >('reviewer:run')
})

const storageCommands = Object.freeze({
  acceptMissingDataRoot: defineApplicationCommand<
    'storage:accept-missing-data-root',
    readonly [],
    void
  >('storage:accept-missing-data-root'),
  acknowledgeDataRootHandoffFlush: defineApplicationCommand<
    'storage:ack-data-root-handoff-flush',
    readonly [response: SessionPersistenceFlushResponse],
    void
  >('storage:ack-data-root-handoff-flush'),
  cancelMigrate: defineApplicationCommand<'storage:cancel-migrate', readonly [], void>(
    'storage:cancel-migrate'
  ),
  commitAndRelaunch: defineApplicationCommand<
    'storage:commit-and-relaunch',
    readonly [request: StorageParentRequest],
    MigrationOutcome
  >('storage:commit-and-relaunch'),
  detectActive: defineApplicationCommand<'storage:detect-active', readonly [], ActiveSessionInfo[]>(
    'storage:detect-active'
  ),
  discardMigratedCopy: defineApplicationCommand<
    'storage:discard-migrated-copy',
    readonly [request: StorageParentRequest],
    DiscardMigratedCopyResult
  >('storage:discard-migrated-copy'),
  dismissLegacyMovePrompt: defineApplicationCommand<
    'storage:dismiss-legacy-move-prompt',
    readonly [],
    void
  >('storage:dismiss-legacy-move-prompt'),
  getStatus: defineApplicationCommand<'storage:get-status', readonly [], StorageStatus>(
    'storage:get-status'
  ),
  getInfo: defineApplicationCommand<'storage:get-info', readonly [], StorageInfo>(
    'storage:get-info'
  ),
  inspectDataRoot: defineApplicationCommand<
    'storage:inspect-data-root',
    readonly [request: StorageParentRequest],
    DataRootInspection
  >('storage:inspect-data-root'),
  migrate: defineApplicationCommand<
    'storage:migrate',
    readonly [request: StorageParentRequest],
    MigrationOutcome
  >('storage:migrate'),
  pickDirectory: defineApplicationCommand<'storage:pick-directory', readonly [], string | null>(
    'storage:pick-directory'
  ),
  revealAppStorage: defineApplicationCommand<
    'storage:reveal-app-storage',
    readonly [],
    RevealAppStorageResult
  >('storage:reveal-app-storage'),
  setDataRootAndRelaunch: defineApplicationCommand<
    'storage:set-data-root-and-relaunch',
    readonly [request: StorageRootRequest],
    DataRootValidationResult
  >('storage:set-data-root-and-relaunch'),
  validateDataRoot: defineApplicationCommand<
    'storage:validate-data-root',
    readonly [request: StorageParentRequest],
    DataRootValidationResult
  >('storage:validate-data-root')
})

const updateCommands = Object.freeze({
  apply: defineApplicationCommand<
    'update:apply',
    readonly [options?: UpdateApplyOptions],
    UpdateStatus
  >('update:apply'),
  cancel: defineApplicationCommand<'update:cancel', readonly [], UpdateStatus>('update:cancel'),
  check: defineApplicationCommand<'update:check', readonly [], UpdateStatus>('update:check'),
  download: defineApplicationCommand<
    'update:download',
    readonly [options?: UpdateDownloadOptions],
    UpdateStatus
  >('update:download'),
  getAppInfo: defineApplicationCommand<'update:get-app-info', readonly [], AppInfo>(
    'update:get-app-info'
  ),
  getStatus: defineApplicationCommand<'update:get-status', readonly [], UpdateStatus>(
    'update:get-status'
  )
})

const hostApplicationCommands = Object.freeze({
  cli: cliCommands,
  github: githubCommands,
  localFs: localFsCommands,
  logs: logsCommands,
  notifications: notificationCommands,
  remoteAccess: remoteAccessCommands,
  reviewer: reviewerCommands,
  storage: storageCommands,
  update: updateCommands
})

const hostApplicationCommandGroups = Object.freeze([
  defineApplicationCommandGroup('cli', Object.values(cliCommands)),
  defineApplicationCommandGroup('github', Object.values(githubCommands)),
  defineApplicationCommandGroup('local-fs', Object.values(localFsCommands)),
  defineApplicationCommandGroup('logs', Object.values(logsCommands)),
  defineApplicationCommandGroup('notifications', Object.values(notificationCommands)),
  defineApplicationCommandGroup('remote-access', Object.values(remoteAccessCommands)),
  defineApplicationCommandGroup('reviewer', Object.values(reviewerCommands)),
  defineApplicationCommandGroup('storage', Object.values(storageCommands)),
  defineApplicationCommandGroup('update', Object.values(updateCommands))
] as const)

type HostApplicationCommandDependencies = Readonly<{
  cli: CliCommandOwner
  github: GithubCommandOwner
  localFs: Pick<
    LocalFsService,
    | 'getRoots'
    | 'grantRoot'
    | 'listDir'
    | 'listDrives'
    | 'listGrantedRoots'
    | 'openPath'
    | 'readPreview'
    | 'removeGrantedRoot'
    | 'revealInFolder'
    | 'setGrantedRootAccess'
  >
  logs: LogsCommandOwner
  notifications: Readonly<{
    getSnapshot: () => Promise<NotificationInboxSnapshot>
    markAllRead: (request: NotificationMarkAllReadRequest) => Promise<void>
    markRead: (request: NotificationMarkReadRequest) => Promise<void>
    markSessionCompletionsRead: (
      request: NotificationMarkSessionCompletionsReadRequest
    ) => Promise<void>
    peekPendingOpenSession: () => OpenSessionFromNotificationRequest | null
    takePendingOpenSession: (expectedToken: number) => OpenSessionFromNotificationRequest | null
  }>
  remoteAccess: Pick<
    RemoteAccessService,
    'snapshot' | 'probe' | 'detect' | 'setMode' | 'disable' | 'approve' | 'reject' | 'revoke'
  >
  reviewer: Pick<ReviewerCommandOwner, 'run' | 'getForSession' | 'abort' | 'abortFixLoop'>
  storage: Readonly<{
    acceptMissingDataRoot: () => Promise<void>
    acknowledgeDataRootHandoffFlush: (
      response: SessionPersistenceFlushResponse,
      lifecycleClientId: string
    ) => void
    getStatus: () => Promise<StorageStatus>
    getInfo: () => Promise<StorageInfo>
    revealAppStorage: () => Promise<RevealAppStorageResult>
    detectActive: () => ActiveSessionInfo[]
    pickDirectory: () => Promise<string | null>
    validateDataRoot: (request: StorageParentRequest) => Promise<DataRootValidationResult>
    inspectDataRoot: (request: StorageParentRequest) => Promise<DataRootInspection>
    migrate: (
      request: StorageParentRequest,
      target?: RendererSessionPersistenceTarget
    ) => Promise<MigrationOutcome>
    setDataRootAndRelaunch: (
      request: StorageRootRequest,
      target?: RendererSessionPersistenceTarget
    ) => Promise<DataRootValidationResult>
    cancelMigrate: () => void
    commitAndRelaunch: (
      request: StorageParentRequest,
      target?: RendererSessionPersistenceTarget
    ) => Promise<MigrationOutcome>
    discardMigratedCopy: (request: StorageParentRequest) => Promise<DiscardMigratedCopyResult>
    dismissLegacyMovePrompt: () => Promise<void>
  }>
  update: UpdateCommandOwner
}>

const localCommand = <Result>(
  context: CallerContext,
  channel: string,
  invoke: () => Result
): Result => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
  return invoke()
}

const dataRootHandoffTarget = (context: CallerContext): RendererSessionPersistenceTarget =>
  context.surface === 'web'
    ? { surface: 'web-renderer', lifecycleClientId: context.lifecycleClientId }
    : { surface: 'electron-renderer' }

// Production composition registers all bounded command groups atomically; this group must not be
// exposed through a live transport in isolation.
const registerHostApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: HostApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(hostApplicationCommandGroups[0], {
      'cli:get-status': () => dependencies.cli.getStatus(),
      'cli:install': ({ callerContext }) =>
        localCommand(callerContext, 'cli:install', () => dependencies.cli.install()),
      'cli:uninstall': ({ callerContext }) =>
        localCommand(callerContext, 'cli:uninstall', () => dependencies.cli.uninstall())
    })
    scope.registerGroup(hostApplicationCommandGroups[1], {
      'github:get-stars': () => dependencies.github.getStars()
    })
    scope.registerGroup(hostApplicationCommandGroups[2], {
      'local-fs:get-roots': ({ callerContext }) =>
        localCommand(callerContext, 'local-fs:get-roots', () => dependencies.localFs.getRoots()),
      'local-fs:grant-root': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:grant-root', () =>
          dependencies.localFs.grantRoot(args[0])
        ),
      'local-fs:list-dir': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:list-dir', () =>
          dependencies.localFs.listDir(args[0])
        ),
      'local-fs:list-drives': ({ callerContext }) =>
        localCommand(callerContext, 'local-fs:list-drives', () =>
          dependencies.localFs.listDrives()
        ),
      'local-fs:granted-roots:list': ({ callerContext }) =>
        localCommand(callerContext, 'local-fs:granted-roots:list', () =>
          dependencies.localFs.listGrantedRoots()
        ),
      'local-fs:open-path': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:open-path', () =>
          dependencies.localFs.openPath(args[0])
        ),
      'local-fs:read-preview': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:read-preview', () =>
          dependencies.localFs.readPreview(args[0])
        ),
      'local-fs:granted-roots:remove': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:granted-roots:remove', () =>
          dependencies.localFs.removeGrantedRoot(args[0])
        ),
      'local-fs:reveal': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:reveal', () =>
          dependencies.localFs.revealInFolder(args[0])
        ),
      'local-fs:granted-roots:set-access': ({ args, callerContext }) =>
        localCommand(callerContext, 'local-fs:granted-roots:set-access', () =>
          dependencies.localFs.setGrantedRootAccess(args[0])
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[3], {
      'logs:get-status': ({ callerContext }) =>
        localCommand(callerContext, 'logs:get-status', () => dependencies.logs.getStatus()),
      'logs:open-file': ({ callerContext }) =>
        localCommand(callerContext, 'logs:open-file', () => dependencies.logs.openFile()),
      'logs:reveal-in-folder': ({ callerContext }) =>
        localCommand(callerContext, 'logs:reveal-in-folder', () =>
          dependencies.logs.revealInFolder()
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[4], {
      'notifications:get-snapshot': () => dependencies.notifications.getSnapshot(),
      'notifications:mark-all-read': ({ args }) =>
        dependencies.notifications.markAllRead(requireNotificationMarkAllReadRequest(args[0])),
      'notifications:mark-read': ({ args }) =>
        dependencies.notifications.markRead(requireNotificationMarkReadRequest(args[0])),
      'notifications:mark-session-completions-read': ({ args }) =>
        dependencies.notifications.markSessionCompletionsRead(
          requireNotificationMarkSessionCompletionsReadRequest(args[0])
        ),
      'notifications:peek-pending-open-session': () =>
        dependencies.notifications.peekPendingOpenSession(),
      'notifications:take-pending-open-session': ({ args }) =>
        typeof args[0] === 'number' && Number.isSafeInteger(args[0]) && args[0] > 0
          ? dependencies.notifications.takePendingOpenSession(args[0])
          : null
    })
    scope.registerGroup(hostApplicationCommandGroups[5], {
      'remote-access:approve': ({ args, callerContext }) => {
        requirePairingManager(callerContext)
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.approve(args[0], desktop, canManagePairing(callerContext))
      },
      'remote-access:detect': ({ callerContext }) => {
        requireDesktopCaller(callerContext)
        return dependencies.remoteAccess.detect()
      },
      'remote-access:probe': ({ callerContext }) =>
        localCommand(callerContext, 'remote-access:probe', () => dependencies.remoteAccess.probe()),
      'remote-access:disable': ({ callerContext }) => {
        requireDesktopCaller(callerContext)
        return dependencies.remoteAccess.disable()
      },
      'remote-access:get-snapshot': ({ callerContext }) => {
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.snapshot(desktop, canManagePairing(callerContext))
      },
      'remote-access:reject': ({ args, callerContext }) => {
        requirePairingManager(callerContext)
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.reject(
          args[0].requestId,
          desktop,
          canManagePairing(callerContext)
        )
      },
      'remote-access:revoke-browser': ({ args, callerContext }) => {
        requirePairingManager(callerContext)
        const desktop = isDesktopCaller(callerContext)
        return dependencies.remoteAccess.revoke(
          args[0].browserId,
          desktop,
          canManagePairing(callerContext)
        )
      },
      'remote-access:set-mode': ({ args, callerContext }) => {
        requireDesktopCaller(callerContext)
        return dependencies.remoteAccess.setMode(args[0].mode)
      }
    })
    scope.registerGroup(hostApplicationCommandGroups[6], {
      'reviewer:abort': ({ args }) => dependencies.reviewer.abort(args[0]),
      'reviewer:abort-fix-loop': ({ args }) => dependencies.reviewer.abortFixLoop(args[0]),
      'reviewer:get-for-session': ({ args }) => dependencies.reviewer.getForSession(args[0]),
      'reviewer:run': ({ args }) => dependencies.reviewer.run(args[0])
    })
    scope.registerGroup(hostApplicationCommandGroups[7], {
      'storage:accept-missing-data-root': ({ callerContext }) =>
        localCommand(callerContext, 'storage:accept-missing-data-root', () =>
          dependencies.storage.acceptMissingDataRoot()
        ),
      'storage:ack-data-root-handoff-flush': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:ack-data-root-handoff-flush', () => {
          const response = args[0]
          if (
            typeof response?.requestId !== 'string' ||
            !['completed', 'conflict', 'failed'].includes(response.status)
          ) {
            throw new Error('Invalid data-root handoff flush acknowledgement.')
          }
          dependencies.storage.acknowledgeDataRootHandoffFlush(
            response,
            callerContext.lifecycleClientId
          )
        }),
      'storage:cancel-migrate': ({ callerContext }) =>
        localCommand(callerContext, 'storage:cancel-migrate', () =>
          dependencies.storage.cancelMigrate()
        ),
      'storage:commit-and-relaunch': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:commit-and-relaunch', () =>
          dependencies.storage.commitAndRelaunch(args[0], dataRootHandoffTarget(callerContext))
        ),
      'storage:detect-active': () => dependencies.storage.detectActive(),
      'storage:discard-migrated-copy': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:discard-migrated-copy', () =>
          dependencies.storage.discardMigratedCopy(args[0])
        ),
      'storage:dismiss-legacy-move-prompt': () => dependencies.storage.dismissLegacyMovePrompt(),
      'storage:get-status': () => dependencies.storage.getStatus(),
      'storage:get-info': () => dependencies.storage.getInfo(),
      'storage:inspect-data-root': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:inspect-data-root', () =>
          dependencies.storage.inspectDataRoot(args[0])
        ),
      'storage:migrate': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:migrate', () =>
          dependencies.storage.migrate(args[0], dataRootHandoffTarget(callerContext))
        ),
      'storage:pick-directory': ({ callerContext }) =>
        localCommand(callerContext, 'storage:pick-directory', () =>
          dependencies.storage.pickDirectory()
        ),
      'storage:reveal-app-storage': ({ callerContext }) =>
        localCommand(callerContext, 'storage:reveal-app-storage', () =>
          dependencies.storage.revealAppStorage()
        ),
      'storage:set-data-root-and-relaunch': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:set-data-root-and-relaunch', () =>
          dependencies.storage.setDataRootAndRelaunch(args[0], dataRootHandoffTarget(callerContext))
        ),
      'storage:validate-data-root': ({ args, callerContext }) =>
        localCommand(callerContext, 'storage:validate-data-root', () =>
          dependencies.storage.validateDataRoot(args[0])
        )
    })
    scope.registerGroup(hostApplicationCommandGroups[8], {
      'update:apply': ({ args, callerContext }) =>
        localCommand(callerContext, 'update:apply', () => dependencies.update.apply(args[0])),
      'update:cancel': ({ callerContext }) =>
        localCommand(callerContext, 'update:cancel', () => dependencies.update.cancel()),
      'update:check': () => dependencies.update.check(),
      'update:download': ({ args, callerContext }) =>
        localCommand(callerContext, 'update:download', () => dependencies.update.download(args[0])),
      'update:get-app-info': () => dependencies.update.getAppInfo(),
      'update:get-status': () => dependencies.update.getStatus()
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { hostApplicationCommandGroups, hostApplicationCommands, registerHostApplicationCommands }
export type { HostApplicationCommandDependencies }
