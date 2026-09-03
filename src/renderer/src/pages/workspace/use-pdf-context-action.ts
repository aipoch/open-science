// The PDF reading-context link action shared by the preview header (PreviewFileSurface) and the
// tab context menu (PreviewPanel): one hook resolves whether a file item can back a Session PDF
// binding and runs the link/unlink command, so both entries act on the same state.
//
// Linking also requests composer focus — "Read with agent" ends with the user
// typing a question, per the literature-reading interaction design.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  pendingPdfContextBindingId,
  usePreviewWorkbenchStore,
  type PreviewFileItem
} from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import { parseNotebookInputPreviewKey } from '../../../../shared/notebook'
import {
  MAX_SESSION_PDF_CONTEXTS,
  type SessionPdfContextSource
} from '../../../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID, parseUploadVersionReference } from '../../../../shared/uploads'

import { requestComposerFocus } from './composer-focus-events'

export type PdfContextTarget = SessionPdfContextSource

// A managed PDF is linkable once it has immutable Version identity; local files never are.
export const resolvePdfContextTarget = (item: PreviewFileItem): PdfContextTarget | undefined => {
  if (item.format !== 'pdf' || item.source === 'local') return undefined
  if (item.source === 'notebook-input') {
    try {
      const identity = parseNotebookInputPreviewKey(item.path)
      return {
        sourceKind: identity.sourceKind,
        sourceFileId: identity.sourceFileId,
        sourceVersionId: identity.inputFileVersionId
      }
    } catch {
      return undefined
    }
  }
  if (item.source === 'upload') {
    const identity = parseUploadVersionReference(item.path)
    const sourceFileId = item.managedFileId ?? identity?.fileId
    return identity && sourceFileId
      ? { sourceKind: 'upload-version', sourceFileId, sourceVersionId: identity.versionId }
      : undefined
  }
  const sourceFileId = item.managedFileId ?? item.artifactId
  return item.selectedVersionId && sourceFileId
    ? { sourceKind: 'artifact-version', sourceFileId, sourceVersionId: item.selectedVersionId }
    : undefined
}

// What running the action would do: append this PDF or remove its own binding/draft selection.
export type PdfContextLinkState = 'link' | 'remove'

export type PdfContextAction = {
  state: PdfContextLinkState
  // English source text; doubles as the i18n key per repo convention.
  label: string
  active: boolean
  pending: boolean
  disabled?: boolean
  run: () => void
}

type PdfContextMutationPort = {
  link?: (source: PdfContextTarget) => Promise<void>
  unlink?: (bindingId: string) => void
}

export const usePdfContextAction = (
  item: PreviewFileItem | undefined,
  onError?: (message: string | null) => void,
  mutations: PdfContextMutationPort = {}
): { action: PdfContextAction | undefined; readingContextBindingId: string | undefined } => {
  const { t } = useTranslation()
  const projectId = usePreviewWorkbenchStore((state) => state.activeProjectId)
  const pendingPdfContextSelection = usePreviewWorkbenchStore((state) =>
    state.activeProjectId ? state.pendingPdfContextByProject[state.activeProjectId] : undefined
  )
  const draftStagedUploadIds = usePreviewWorkbenchStore((state) => state.draftStagedUploadIds)
  // Match the conversation actually rendered by WorkspacePage. A stale selectedSessionId from
  // another/archived project must not make a full-screen preview claim that PDF is linked there.
  const activeSession = useSessionStore((state) => {
    const selected = state.sessions.find((session) => session.id === state.selectedSessionId)
    if (!selected || selected.projectId !== projectId || selected.archivedAt !== undefined) {
      return undefined
    }
    return selected
  })
  const [pdfContextPending, setPdfContextPending] = useState(false)

  const pdfContextTarget = item ? resolvePdfContextTarget(item) : undefined
  const managedPdfContextUnavailable = Boolean(
    item && item.format === 'pdf' && item.source !== 'local' && !pdfContextTarget
  )
  const stagedPdfAttachmentId =
    item &&
    item.format === 'pdf' &&
    item.source === 'upload' &&
    item.sessionId === PENDING_UPLOAD_SESSION_ID &&
    item.id.startsWith('upload:')
      ? item.id.slice('upload:'.length)
      : undefined
  // A staged upload can only become the draft's reading context while it is attached to that
  // draft — first-send finalization looks the attachment up among the message's own uploads.
  const stagedAttachmentInDraft = Boolean(
    stagedPdfAttachmentId && draftStagedUploadIds.includes(stagedPdfAttachmentId)
  )
  const pdfContext = activeSession?.runtimeContext?.pdfContext
  const currentBinding = pdfContextTarget
    ? pdfContext?.bindings.find(
        ({ sourceKind, sourceVersionId }) =>
          sourceKind === pdfContextTarget.sourceKind &&
          sourceVersionId === pdfContextTarget.sourceVersionId
      )
    : undefined
  const isCurrentPdfContext = Boolean(currentBinding)
  const isPendingPdfContext = Boolean(
    !activeSession &&
    ((stagedPdfAttachmentId &&
      pendingPdfContextSelection?.kind === 'staged-upload' &&
      stagedPdfAttachmentId === pendingPdfContextSelection.attachmentId) ||
      (pdfContextTarget &&
        pendingPdfContextSelection?.kind === 'version' &&
        pdfContextTarget.sourceKind === pendingPdfContextSelection.sourceKind &&
        pdfContextTarget.sourceVersionId === pendingPdfContextSelection.sourceVersionId))
  )
  const readingContextBindingId = isCurrentPdfContext
    ? currentBinding?.bindingId
    : isPendingPdfContext && pendingPdfContextSelection
      ? pendingPdfContextBindingId(pendingPdfContextSelection)
      : undefined

  const updatePdfContext = async (): Promise<void> => {
    if (!activeSession || !pdfContextTarget || pdfContextPending) return
    setPdfContextPending(true)
    onError?.(null)
    try {
      if (isCurrentPdfContext && currentBinding) {
        if (mutations.unlink) {
          mutations.unlink(currentBinding.bindingId)
          return
        }
        await window.api.sessions.unlinkPdfContext({
          projectId: activeSession.projectId,
          sessionId: activeSession.id,
          expectedRevision: activeSession.runtimeContext?.revision ?? 0,
          bindingId: currentBinding.bindingId
        })
        usePreviewWorkbenchStore.getState().clearPdfReadingPosition(currentBinding.bindingId)
      } else {
        if (mutations.link) {
          await mutations.link(pdfContextTarget)
          return
        }
        await window.api.sessions.linkPdfContext({
          projectId: activeSession.projectId,
          sessionId: activeSession.id,
          expectedRevision: activeSession.runtimeContext?.revision ?? 0,
          sources: [pdfContextTarget]
        })
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      setPdfContextPending(false)
    }
  }

  const updatePendingPdfContext = (): void => {
    if (!projectId || activeSession || (!stagedAttachmentInDraft && !pdfContextTarget)) return
    if (isPendingPdfContext && pendingPdfContextSelection) {
      usePreviewWorkbenchStore
        .getState()
        .clearPdfReadingPosition(pendingPdfContextBindingId(pendingPdfContextSelection))
    }
    usePreviewWorkbenchStore.getState().setPendingPdfContext(
      projectId,
      isPendingPdfContext
        ? undefined
        : stagedPdfAttachmentId
          ? {
              kind: 'staged-upload',
              attachmentId: stagedPdfAttachmentId,
              previewItemId: item!.id
            }
          : {
              kind: 'version',
              sourceKind: pdfContextTarget!.sourceKind,
              sourceFileId: pdfContextTarget!.sourceFileId,
              sourceVersionId: pdfContextTarget!.sourceVersionId,
              previewItemId: item!.id
            }
    )
  }

  if (!item) return { action: undefined, readingContextBindingId: undefined }

  if (activeSession && pdfContextTarget) {
    return {
      action: {
        state: isCurrentPdfContext ? 'remove' : 'link',
        label: t(isCurrentPdfContext ? 'Remove PDF from context' : 'Read with agent'),
        active: isCurrentPdfContext,
        pending: pdfContextPending,
        disabled:
          !isCurrentPdfContext && (pdfContext?.bindings.length ?? 0) >= MAX_SESSION_PDF_CONTEXTS,
        run: () => {
          void updatePdfContext()
          // Linking starts a reading session; removing one leaves the composer alone.
          if (!isCurrentPdfContext) requestComposerFocus()
        }
      },
      readingContextBindingId
    }
  }
  if (!activeSession && (stagedAttachmentInDraft || pdfContextTarget)) {
    return {
      action: {
        state: isPendingPdfContext ? 'remove' : 'link',
        label: t(isPendingPdfContext ? 'Remove PDF from context' : 'Read with agent'),
        active: isPendingPdfContext,
        pending: false,
        run: () => {
          updatePendingPdfContext()
          if (!isPendingPdfContext) requestComposerFocus()
        }
      },
      readingContextBindingId
    }
  }
  if (managedPdfContextUnavailable) {
    return {
      action: {
        state: 'link',
        label: t('Read with agent'),
        active: false,
        pending: false,
        disabled: true,
        run: () => undefined
      },
      readingContextBindingId: undefined
    }
  }
  return { action: undefined, readingContextBindingId: undefined }
}
