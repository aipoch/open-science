import { create } from 'zustand'

import type { Project } from '../../../shared/projects'
import type { PersistedChatSession } from '../../../shared/session-persistence'
import { useProjectStore } from './project-store'
import { useSessionStore } from './session-store'

const ARCHIVE_UNDO_DURATION_MS = 8_000

// Notices outlive the render that created them and must follow a language switch, so they carry a
// translation key plus its interpolation values rather than a resolved string. A `message` is only
// present for a restore failure, where the text comes from the backend and passes through verbatim.
type ArchiveUndoText =
  | { messageKey: 'Archived project “{{name}}”.'; messageParams: { name: string } }
  | { messageKey: 'Archived session “{{title}}”.'; messageParams: { title: string } }
  | { message: string }

type ArchiveUndo = ArchiveUndoText &
  (
    | {
        key: string
        kind: 'project'
        projectId: string
        archivedAt: number
        expiresAt: number
        retry?: boolean
      }
    | {
        key: string
        kind: 'session'
        projectId: string
        sessionId: string
        archivedAt: number
        expiresAt: number
        retry?: boolean
      }
  )

type ArchiveUndoStore = {
  notices: ArchiveUndo[]
  restoringKey: string | undefined
  enqueueProject: (project: Project) => void
  enqueueSession: (session: PersistedChatSession) => void
  dismiss: (key: string) => void
  dismissProject: (projectId: string) => void
  dismissSession: (sessionId: string) => void
  reconcileProject: (project: Project) => void
  reconcileSession: (session: PersistedChatSession) => void
  undo: (key: string) => Promise<void>
}

const archiveKey = (kind: ArchiveUndo['kind'], id: string, archivedAt: number): string =>
  `${kind}:${id}:${archivedAt}`

const prune = (notices: ArchiveUndo[]): ArchiveUndo[] =>
  notices.filter((notice) => notice.expiresAt > Date.now())

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Archive state changed elsewhere.'

export const useArchiveUndoStore = create<ArchiveUndoStore>((set, get) => ({
  notices: [],
  restoringKey: undefined,

  enqueueProject: (project) => {
    if (project.archivedAt === undefined) return
    const key = archiveKey('project', project.id, project.archivedAt)
    const notice: ArchiveUndo = {
      key,
      kind: 'project',
      projectId: project.id,
      archivedAt: project.archivedAt,
      messageKey: 'Archived project “{{name}}”.',
      messageParams: { name: project.name },
      expiresAt: Date.now() + ARCHIVE_UNDO_DURATION_MS
    }
    set((state) => ({
      notices: [notice, ...prune(state.notices).filter((item) => item.projectId !== project.id)]
    }))
  },

  enqueueSession: (session) => {
    if (session.archivedAt === undefined) return
    const key = archiveKey('session', session.id, session.archivedAt)
    const notice: ArchiveUndo = {
      key,
      kind: 'session',
      projectId: session.projectId,
      sessionId: session.id,
      archivedAt: session.archivedAt,
      messageKey: 'Archived session “{{title}}”.',
      messageParams: { title: session.title },
      expiresAt: Date.now() + ARCHIVE_UNDO_DURATION_MS
    }
    set((state) => ({
      notices: [
        notice,
        ...prune(state.notices).filter(
          (item) => !(item.kind === 'session' && item.sessionId === session.id)
        )
      ]
    }))
  },

  dismiss: (key) => set((state) => ({ notices: state.notices.filter((item) => item.key !== key) })),

  dismissProject: (projectId) =>
    set((state) => ({
      notices: state.notices.filter((notice) => notice.projectId !== projectId),
      restoringKey: state.notices.some(
        (notice) => notice.key === state.restoringKey && notice.projectId === projectId
      )
        ? undefined
        : state.restoringKey
    })),

  dismissSession: (sessionId) =>
    set((state) => ({
      notices: state.notices.filter(
        (notice) => notice.kind !== 'session' || notice.sessionId !== sessionId
      ),
      restoringKey: state.notices.some(
        (notice) =>
          notice.key === state.restoringKey &&
          notice.kind === 'session' &&
          notice.sessionId === sessionId
      )
        ? undefined
        : state.restoringKey
    })),

  reconcileProject: (project) =>
    set((state) => ({
      notices: prune(state.notices).filter((notice) => {
        if (notice.projectId !== project.id) return true
        // An archived parent supersedes child undo actions. Once it is restored, however, a
        // previously archived child session remains independently restorable.
        return project.archivedAt === undefined
          ? notice.kind === 'session'
          : notice.kind === 'project' && project.archivedAt === notice.archivedAt
      })
    })),

  reconcileSession: (session) =>
    set((state) => ({
      notices: prune(state.notices).filter(
        (notice) =>
          notice.kind !== 'session' ||
          notice.sessionId !== session.id ||
          session.archivedAt === notice.archivedAt
      )
    })),

  undo: async (key) => {
    const notice = get().notices.find((item) => item.key === key)
    if (!notice) return
    set({ restoringKey: key })
    try {
      if (notice.kind === 'project') {
        await useProjectStore.getState().updateProjectArchive({
          id: notice.projectId,
          archived: false,
          expectedArchivedAt: notice.archivedAt
        })
      } else {
        await useSessionStore.getState().updateSessionArchive({
          projectId: notice.projectId,
          sessionId: notice.sessionId,
          archived: false,
          expectedArchivedAt: notice.archivedAt
        })
      }
      set((state) => ({
        notices: state.notices.filter((item) => item.key !== key),
        restoringKey: undefined
      }))
    } catch (error) {
      set((state) => ({
        notices: state.notices.map((item) => {
          if (item.key !== key) return item
          // A failure replaces the localized archive text with the backend's own message, so the
          // key/params pair is dropped to keep exactly one text source on the notice.
          const failed = { ...item, retry: true, expiresAt: Date.now() + ARCHIVE_UNDO_DURATION_MS }
          if ('messageKey' in failed) {
            delete (failed as { messageKey?: unknown }).messageKey
            delete (failed as { messageParams?: unknown }).messageParams
          }
          return { ...failed, message: errorMessage(error) }
        }),
        restoringKey: undefined
      }))
    }
  }
}))

export type { ArchiveUndo }
