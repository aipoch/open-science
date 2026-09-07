import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import {
  isSessionDetailsConflictError,
  isSessionSizeLimitError,
  type EditSessionDetailsRequest,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
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
  error: string | null
}

type WorkspaceSessionDetailsController = {
  dialog: SessionDetailsDialog | null
  open: (session: ChatSession) => void
  close: () => void
  changeTitle: (draft: string) => void
  changeDescription: (draft: string) => void
  confirm: (event: FormEvent<HTMLFormElement>) => void
  rename: (session: ChatSession, title: string, expectedTitle?: string) => Promise<boolean>
}

const useWorkspaceSessionDetailsController = (
  isPersistenceReady: boolean,
  onLoadFailure: () => void,
  onSessionSizeLimit?: (sessionId: string) => void
): WorkspaceSessionDetailsController => {
  const { t } = useTranslation()
  const [dialog, setDialog] = useState<SessionDetailsDialog | null>(null)
  const dialogIntentRef = useRef(0)
  const editDetails = (request: EditSessionDetailsRequest): Promise<PersistedChatSession> =>
    window.api.sessions.editDetails(request).catch((error: unknown) => {
      if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(request.sessionId)
      throw error
    })
  const open = (session: ChatSession): void => {
    const intent = ++dialogIntentRef.current
    if (!isPersistenceReady) return
    const show = (authoritative: ChatSession): void =>
      setDialog({
        session: authoritative,
        titleDraft: authoritative.title,
        descriptionDraft: authoritative.description ?? '',
        isSaving: false,
        error: null
      })
    if (session.contentLoaded !== false) {
      show(session)
      return
    }
    void loadPersistedSession({ projectId: session.projectId, sessionId: session.id })
      .then((persisted) => {
        if (!persisted) throw new Error('Selected Session JSON is missing.')
        const hydrated = hydratePersistedSessionIfPresent(persisted)
        if (hydrated && intent === dialogIntentRef.current) show(hydrated)
      })
      .catch(() => {
        if (intent === dialogIntentRef.current) onLoadFailure()
      })
  }
  const confirm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!isPersistenceReady || !dialog || dialog.isSaving || !dialog.titleDraft.trim()) return
    const intent = dialogIntentRef.current
    const sessionId = dialog.session.id
    const request: EditSessionDetailsRequest = {
      projectId: dialog.session.projectId,
      sessionId,
      expectedTitle: dialog.session.title,
      expectedDescription: dialog.session.description ?? '',
      title: dialog.titleDraft,
      description: dialog.descriptionDraft
    }
    setDialog((current) => (current ? { ...current, isSaving: true, error: null } : current))
    void editDetails(request)
      .then((persisted) => {
        useSessionStore.getState().upsertPersistedSession(persisted)
        setDialog((current) =>
          intent === dialogIntentRef.current && current?.session.id === sessionId ? null : current
        )
      })
      .catch((error: unknown) => {
        console.warn('editSessionDetails failed', error)
        const message = isSessionDetailsConflictError(error)
          ? t(
              "This session's title or description changed in another window. Your changes were not saved. Close and reopen the editor to review the latest details."
            )
          : t('Could not save session details.')
        setDialog((current) =>
          intent === dialogIntentRef.current && current?.session.id === sessionId
            ? { ...current, isSaving: false, error: message }
            : current
        )
      })
  }
  // Title-only rename (sidebar hover card inline editor). Routes through the session-details
  // owner's editDetails mutation — like the Edit dialog — so the durable title is marked
  // sessionDetailsSource 'manual' and a later details generation cannot overwrite it. The
  // authoritative session is loaded first when needed so its description is preserved verbatim.
  const rename = (
    session: ChatSession,
    title: string,
    expectedTitle = session.title
  ): Promise<boolean> => {
    if (!isPersistenceReady) return Promise.resolve(true)
    const trimmedTitle = title.trim()
    if (!trimmedTitle || trimmedTitle === expectedTitle) return Promise.resolve(true)
    const submit = (authoritative: ChatSession): Promise<boolean> =>
      editDetails({
        projectId: authoritative.projectId,
        sessionId: authoritative.id,
        expectedTitle,
        expectedDescription: authoritative.description ?? '',
        title: trimmedTitle,
        description: authoritative.description ?? ''
      }).then((persisted) => {
        useSessionStore.getState().upsertPersistedSession(persisted)
        return true
      })
    if (session.contentLoaded !== false) {
      return submit(session)
    }
    const authoritative = loadPersistedSession({
      projectId: session.projectId,
      sessionId: session.id
    })
      .then((persisted) => {
        if (!persisted) throw new Error('Selected Session JSON is missing.')
        const hydrated = hydratePersistedSessionIfPresent(persisted)
        if (!hydrated) throw new Error('Selected Session JSON is invalid.')
        return hydrated
      })
      .catch(() => {
        onLoadFailure()
        return undefined
      })
    return authoritative.then((loaded) => (loaded ? submit(loaded) : false))
  }
  return {
    dialog,
    open,
    close: () => {
      if (dialog?.isSaving) return
      dialogIntentRef.current += 1
      setDialog(null)
    },
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
