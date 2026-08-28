import { useState, type FormEvent } from 'react'

import type { EditSessionDetailsRequest } from '../../../../shared/session-persistence'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import {
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '@/lib/session-persistence/session-persistence'

type SessionDetailsDialog = {
  session: ChatSession
  titleDraft: string
  descriptionDraft: string
  isSaving: boolean
}

type WorkspaceSessionDetailsController = {
  dialog: SessionDetailsDialog | null
  open: (session: ChatSession) => void
  close: () => void
  changeTitle: (draft: string) => void
  changeDescription: (draft: string) => void
  confirm: (event: FormEvent<HTMLFormElement>) => void
  rename: (session: ChatSession, title: string) => void
}

const useWorkspaceSessionDetailsController = (
  isPersistenceReady: boolean,
  onLoadFailure: () => void
): WorkspaceSessionDetailsController => {
  const [dialog, setDialog] = useState<SessionDetailsDialog | null>(null)
  const open = (session: ChatSession): void => {
    if (!isPersistenceReady) return
    const show = (authoritative: ChatSession): void =>
      setDialog({
        session: authoritative,
        titleDraft: authoritative.title,
        descriptionDraft: authoritative.description ?? '',
        isSaving: false
      })
    if (session.contentLoaded !== false) {
      show(session)
      return
    }
    void loadPersistedSession({ projectId: session.projectId, sessionId: session.id })
      .then((persisted) => {
        if (!persisted) throw new Error('Selected Session JSON is missing.')
        const hydrated = hydratePersistedSessionIfPresent(persisted)
        if (hydrated) show(hydrated)
      })
      .catch(onLoadFailure)
  }
  const confirm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!isPersistenceReady || !dialog || dialog.isSaving || !dialog.titleDraft.trim()) return
    const request: EditSessionDetailsRequest = {
      projectId: dialog.session.projectId,
      sessionId: dialog.session.id,
      title: dialog.titleDraft,
      description: dialog.descriptionDraft
    }
    setDialog((current) => (current ? { ...current, isSaving: true } : current))
    void window.api.sessions
      .editDetails(request)
      .then((persisted) => {
        useSessionStore.getState().upsertPersistedSession(persisted)
        setDialog(null)
      })
      .catch((error: unknown) => {
        console.warn('editSessionDetails failed', error)
        setDialog((current) => (current ? { ...current, isSaving: false } : current))
      })
  }
  // Title-only rename (sidebar hover card inline editor). Routes through the session-details
  // owner's editDetails mutation — like the Edit dialog — so the durable title is marked
  // sessionDetailsSource 'manual' and a later details generation cannot overwrite it. The
  // authoritative session is loaded first when needed so its description is preserved verbatim.
  const rename = (session: ChatSession, title: string): void => {
    if (!isPersistenceReady) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle || trimmedTitle === session.title) return
    const submit = (authoritative: ChatSession): void => {
      void window.api.sessions
        .editDetails({
          projectId: authoritative.projectId,
          sessionId: authoritative.id,
          title: trimmedTitle,
          description: authoritative.description ?? ''
        })
        .then((persisted) => {
          useSessionStore.getState().upsertPersistedSession(persisted)
        })
        .catch((error: unknown) => {
          console.warn('renameSessionTitle failed', error)
        })
    }
    if (session.contentLoaded !== false) {
      submit(session)
      return
    }
    void loadPersistedSession({ projectId: session.projectId, sessionId: session.id })
      .then((persisted) => {
        if (!persisted) throw new Error('Selected Session JSON is missing.')
        const hydrated = hydratePersistedSessionIfPresent(persisted)
        if (hydrated) submit(hydrated)
      })
      .catch(onLoadFailure)
  }
  return {
    dialog,
    open,
    close: () => setDialog((current) => (current?.isSaving ? current : null)),
    changeTitle: (titleDraft) =>
      setDialog((current) => (current ? { ...current, titleDraft } : current)),
    changeDescription: (descriptionDraft) =>
      setDialog((current) => (current ? { ...current, descriptionDraft } : current)),
    confirm,
    rename
  }
}

export { useWorkspaceSessionDetailsController }
export type { SessionDetailsDialog, WorkspaceSessionDetailsController }
