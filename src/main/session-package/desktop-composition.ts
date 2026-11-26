import { SessionPackageDesktop } from './desktop'
import type { SessionPackageService } from './service'
import type { ArchiveCoordinator } from '../archive/coordinator'
import type { SessionRepository } from '../session-persistence/repository'
import type { ProjectRepository } from '../projects/repository'
import type { ApplicationEventPublisher } from '../application-events'
import type { NativeTranslator } from '../locale/main-process-messages'
import type { SensitiveContentEvidence, SessionPackageRequest } from '../../shared/session-package'
import type { PackageSensitiveContentSource } from './sensitive-content'
import {
  isMigrationInProgress,
  isMigrationPending,
  withDataRootWrite
} from '../storage/migration-state'

type Owners = {
  sessionPackageService: SessionPackageService
  translate: NativeTranslator
  archiveCoordinator: Pick<ArchiveCoordinator, 'reserveProjectImport'>
  applicationEvents: ApplicationEventPublisher
  projectRepository: Pick<ProjectRepository, 'get'>
  sessionRepository: Pick<SessionRepository, 'loadSession'>
  isPackageHandoffHeld: () => boolean
  cancelBrowserTransfer?: (id: string) => Promise<void>
  onSensitiveContentFailure?: (
    request: SessionPackageRequest,
    evidence: SensitiveContentEvidence[],
    sources: PackageSensitiveContentSource[]
  ) => void
}
export const createSessionPackageDesktop = ({
  sessionPackageService,
  translate,
  archiveCoordinator,
  applicationEvents,
  projectRepository,
  sessionRepository,
  isPackageHandoffHeld,
  onSensitiveContentFailure,
  cancelBrowserTransfer
}: Owners): SessionPackageDesktop => {
  return new SessionPackageDesktop({
    service: sessionPackageService,
    cancelBrowserTransfer,
    translate,
    withDataRootWrite,
    assertCanStart: () => {
      if (isPackageHandoffHeld() || isMigrationInProgress() || isMigrationPending())
        throw new Error('Wait for the application handoff to finish before transferring research.')
    },
    reserveImport: (projectId, signal) =>
      archiveCoordinator.reserveProjectImport(projectId, signal),
    onOperationChanged: (snapshot) =>
      applicationEvents.publish('sessions:package-operation-changed', snapshot),
    onSensitiveContentFailure,
    afterImport: async (identity, originClientId, projectCreated) => {
      const [project, importedSession] = await Promise.all([
        projectRepository.get(identity.projectId),
        sessionRepository.loadSession(identity.projectId, identity.sessionId)
      ])
      if (project && projectCreated) applicationEvents.publish('project:created', project)
      if (importedSession)
        applicationEvents.publish('session:created', {
          session: importedSession,
          originClientId: originClientId ?? 'session-package-import'
        })
    }
  })
}
