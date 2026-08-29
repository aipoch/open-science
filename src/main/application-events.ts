import type {
  AcpAgentRuntimeUpdate,
  AcpPermissionRequest,
  AcpRuntimeEvent,
  AcpStateSnapshot
} from '../shared/acp'
import type { CompletionGateLifecycleEvent } from './agents/completion-gate'
import type { ComputeApprovalRequest, JobSummary } from '../shared/compute'
import type { DownloadProgress } from '../shared/download-progress'
import type {
  Project,
  ProjectDeletedEvent,
  SessionDeletedEvent,
  SessionUpsertEvent
} from '../shared/lifecycle-events'
import type { NotebookAvailableEvent, NotebookChangedEvent } from '../shared/notebook'
import type { ProvisionProgress } from '../shared/notebook-env'
import type { NotificationInboxChanged } from '../shared/notifications'
import type { PermissionGrantsChangedEvent } from '../shared/permission-grants'
import type { ProjectFilesChangedEvent } from '../shared/project-files'
import type {
  ReviewSessionRequest,
  ReviewSuppressionEvent,
  ReviewUpdateEvent
} from '../shared/reviewer'
import type {
  ClaudeInstallEvent,
  ConnectorApprovalRequest,
  ConnectorCredentialRequest,
  ConversationSkillImportApprovalRequest,
  SettingsSnapshot
} from '../shared/settings'
import type { CompletionHandoffLifecycleEvent, PendingSwitchBroadcast } from '../shared/specialist'
import type { MigrationProgress } from '../shared/storage'
import type { SideChatRelayDeliveredEvent, SideChatRuntimeEvent } from '../shared/side-chat'
import type { UpdateStatus } from '../shared/update'
import type { LocalePreferenceSnapshot } from '../shared/locale'
import type { TagsChangedEvent } from '../shared/tags'
import type { MemoryChangedEvent } from '../shared/memory'
import type { SessionPersistenceFlushRequest } from '../shared/session-persistence-flush'
import { createLogger, errorLogFields } from './logger'

const log = createLogger('application-events')

// This catalog describes only events that already flow through renderer-broadcast. Window-only
// signals and generated Web-only channels stay on their existing transports until their owner moves
// them deliberately.
export type ApplicationEventMap = {
  'acp:state': AcpStateSnapshot
  'acp:event': readonly AcpRuntimeEvent[]
  'acp:agent-runtime-update': AcpAgentRuntimeUpdate
  'acp:permission-request': AcpPermissionRequest
  'side-chat:event': SideChatRuntimeEvent
  'side-chat:relay-delivered': SideChatRelayDeliveredEvent
  'notebook:available': NotebookAvailableEvent
  'notebook:changed': NotebookChangedEvent
  'notebook-env:progress': ProvisionProgress
  'notifications:changed': NotificationInboxChanged
  'project:created': Project
  'project:updated': Project
  'project:deleted': ProjectDeletedEvent
  'session:created': SessionUpsertEvent
  'session:updated': SessionUpsertEvent
  'session:deleted': SessionDeletedEvent
  'sessions:flush-aborted': undefined
  'sessions:flush-request': SessionPersistenceFlushRequest
  'project-files:changed': ProjectFilesChangedEvent
  'permissions:changed': PermissionGrantsChangedEvent
  'tags:changed': TagsChangedEvent
  'memory:changed': MemoryChangedEvent
  'connectors:approval-request': ConnectorApprovalRequest
  'connectors:approval-settled': string
  'connectors:credential-request': ConnectorCredentialRequest
  'connectors:credential-settled': string
  'skills:conversation-import-request': ConversationSkillImportApprovalRequest
  'skills:conversation-import-settled': string
  'skills:catalog-changed': undefined
  'compute:approval-request': ComputeApprovalRequest
  'compute:approval-settled': string
  'compute:job-updated': JobSummary
  'specialist:catalog-changed': undefined
  'specialist:pending-switch': PendingSwitchBroadcast
  'specialist:handoff-lifecycle-changed': CompletionHandoffLifecycleEvent
  'specialist:handoff-lifecycle': CompletionGateLifecycleEvent
  'settings:connector-runtime-changed': undefined
  'settings:install-log': ClaudeInstallEvent
  'settings:changed': SettingsSnapshot
  'storage:migrate-progress': MigrationProgress
  'reviewer:updated': ReviewUpdateEvent
  'reviewer:suppress-next-auto-review': ReviewSuppressionEvent
  'reviewer:fix-loop-start': ReviewSessionRequest
  'reviewer:fix-loop-end': ReviewSessionRequest
  'remote-access:changed': Record<string, never>
  'locale:changed': LocalePreferenceSnapshot
  'update:status': UpdateStatus
  'update:progress': DownloadProgress
}

export type ApplicationEventChannel = keyof ApplicationEventMap

export type ApplicationEvent<Channel extends ApplicationEventChannel = ApplicationEventChannel> = {
  [CurrentChannel in Channel]: Readonly<{
    channel: CurrentChannel
    payload: ApplicationEventMap[CurrentChannel]
  }>
}[Channel]

export type ApplicationEventListener = (event: ApplicationEvent) => void

export type ApplicationEventPublisher = {
  publish<Channel extends ApplicationEventChannel>(
    channel: Channel,
    payload: ApplicationEventMap[Channel]
  ): void
}

export type ApplicationEventSource = {
  subscribe(listener: ApplicationEventListener): () => void
}

export type ApplicationEvents = ApplicationEventPublisher & ApplicationEventSource

export type ApplicationEventInstaller = (events: ApplicationEvents) => () => void

export type ApplicationEventModule = {
  name: 'application-events'
  capability: ApplicationEvents
  start(): void
  rollback(): void
  dispose(): void
}

// Owns in-process publication order and subscription lifetime. It deliberately knows nothing about
// Electron, WebSocket serialization, public allowlists, or durable state.
export class ApplicationEventHub implements ApplicationEvents {
  private readonly listeners = new Set<ApplicationEventListener>()
  private disposed = false

  publish<Channel extends ApplicationEventChannel>(
    channel: Channel,
    payload: ApplicationEventMap[Channel]
  ): void {
    if (this.disposed) return
    const event = Object.freeze({ channel, payload }) as ApplicationEvent

    // Iterate the live Set deliberately so removing a not-yet-called listener still skips it in the
    // active publication. Isolate subscriber failures because notification delivery cannot roll back
    // an already-committed owner mutation or suppress healthy later projections.
    let failures: unknown[] | undefined
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        if (failures) failures.push(error)
        else failures = [error]
      }
    }
    if (failures) {
      log.warn('Application event subscriber delivery failed (non-fatal)', {
        channel,
        subscriberFailureCount: failures.length,
        ...errorLogFields(
          new AggregateError(failures, 'One or more application event subscribers failed.')
        )
      })
    }
  }

  subscribe(listener: ApplicationEventListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }
}

// The runtime registers this module first, so reverse disposal keeps publication and every
// projection alive while later-owned backends emit their final shutdown events.
export const createApplicationEventModule = (
  install: ApplicationEventInstaller
): ApplicationEventModule => {
  const hub = new ApplicationEventHub()
  let uninstall: (() => void) | undefined
  const dispose = (): void => {
    uninstall?.()
    uninstall = undefined
    hub.dispose()
  }

  return {
    name: 'application-events',
    capability: hub,
    start: () => {
      uninstall = install(hub)
    },
    rollback: dispose,
    dispose
  }
}
