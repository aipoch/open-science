import type { RuntimeWriterOwner } from '../session-persistence/runtime-writer'
import { shell } from 'electron'
import { registerSessionPersistenceIpcHandlers } from '../session-persistence/ipc'
import type { SessionRepository } from '../session-persistence/repository'
import type { SessionDetailsOwner } from '../session-details/owner'
import type { RootDelegatedWorkControl } from '../delegation/production-composition'
import { createLogger, diagnosticErrorFields } from '../logger'
import { createElectronSurfaceAdapter } from './adapter'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'

type Registrar = Parameters<typeof registerSessionPersistenceIpcHandlers>
type Owners = {
  runtimeWriter?: RuntimeWriterOwner
  sessionPersistenceBackend: Registrar[0]
  reviewRepository: NonNullable<Registrar[1]>
  sessionPersistenceHandlers: NonNullable<Registrar[2]>
  sessionDetailsOwner: Pick<SessionDetailsOwner, 'afterSessionSaved'>
  delegatedWork: { root: Pick<RootDelegatedWorkControl, 'wakeMessages'> }
  sessionRepository: Pick<SessionRepository, 'recoveryFolderPath'>
}

export const createSessionPersistenceElectronSurface = ({
  runtimeWriter,
  sessionPersistenceBackend,
  reviewRepository,
  sessionPersistenceHandlers,
  sessionDetailsOwner,
  delegatedWork,
  sessionRepository
}: Owners): NamedElectronSurfaceAdapter => {
  return createElectronSurfaceAdapter('session-persistence', () => {
    registerSessionPersistenceIpcHandlers(
      sessionPersistenceBackend,
      reviewRepository,
      sessionPersistenceHandlers,
      async (session) => {
        sessionDetailsOwner.afterSessionSaved(session)
        try {
          await delegatedWork.root.wakeMessages?.(session.id)
        } catch (error) {
          createLogger('delegation:messages').warn(
            'message wake after Session activation failed',
            diagnosticErrorFields(error)
          )
        }
      },
      async (request) => {
        const error = await shell.openPath(sessionRepository.recoveryFolderPath(request.projectId))
        if (error) throw new Error('Session recovery folder could not be opened.')
      },
      runtimeWriter
    )
  })
}
