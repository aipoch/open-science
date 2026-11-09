import { z } from 'zod'
import type { Annotation } from '../../../../shared/annotation-contract'
import { replayAnnotationTarget } from '../../../../shared/replay-reference'
import { sanitizeAnnotations } from '../../../../shared/annotations'
import type { ComposerDraft } from './composer-contract'
import { docToText } from './composer/composer-doc'

const STORAGE_KEY = 'open-science-composer-drafts-v1'
const RECOVERY_STORAGE_KEY = 'open-science-composer-drafts-recovery-v1'
const storedDraftSchema = z.object({
  projectId: z.string(),
  key: z.string(),
  text: z.string(),
  annotations: z.array(z.unknown()).transform(sanitizeAnnotations),
  files: z.array(
    z.object({ name: z.string(), size: z.number().nonnegative(), receipt: z.string().optional() })
  ),
  automaticReadingEnabled: z.boolean()
})
type StoredDraft = z.infer<typeof storedDraftSchema>
const envelopeSchema = z.object({
  version: z.literal(1),
  scope: z.string(),
  drafts: z.array(storedDraftSchema)
})
let enabled = false
let storage = (): Storage => sessionStorage
let scope: string | undefined
let drafts: StoredDraft[] = []
let failed = false
const writers = new Set<() => void>()
const draftObservers = new Set<(projectId: string, key: string, draft: ComposerDraft) => void>()
export const observeComposerDrafts = (
  observer: (projectId: string, key: string, draft: ComposerDraft) => void
): (() => void) => {
  draftObservers.add(observer)
  return () => {
    draftObservers.delete(observer)
  }
}
const deletedProjects = new Set<string>()
const deletedSessions = new Map<string, string>()
const deletionListeners = new Set<() => void>()

export const subscribeDraftSourceDeletion = (listener: () => void): (() => void) => {
  deletionListeners.add(listener)
  return () => {
    deletionListeners.delete(listener)
  }
}

export const availableDraftAnnotations = (annotations: Annotation[]): Annotation[] => {
  if (!deletedSessions.size) return annotations
  const retained = annotations.filter((annotation) => {
    const target = replayAnnotationTarget(annotation)
    return !target || deletedSessions.get(target.sourceSessionId) !== target.projectId
  })
  return retained.length === annotations.length ? annotations : retained
}

const save = (): void => {
  if (!enabled) return
  if (!scope) {
    failed = true
    return
  }
  try {
    storage().setItem(STORAGE_KEY, JSON.stringify({ version: 1, scope, drafts }))
    failed = false
  } catch {
    failed = true
    // A failed overwrite must not leave an older, possibly already-sent draft available to reload.
    // Keep the current in-memory drafts for the explicit copy fallback.
    try {
      storage().removeItem(STORAGE_KEY)
    } catch {
      /* Storage access itself may be denied. */
    }
  }
}

// Web drafts stay tab-local with a server-supplied authorization scope. Desktop has one main
// renderer per profile: its Chromium localStorage survives a process restart and is isolated by
// the profile's userData/sessionData directory, independently of the backend's ephemeral port.
export const configureComposerDraftStorage = (
  nextScope?: string,
  lifetime: 'tab' | 'profile' = 'tab'
): void => {
  enabled = true
  storage = lifetime === 'profile' ? () => localStorage : () => sessionStorage
  scope = nextScope
  drafts = []
  deletedProjects.clear()
  deletedSessions.clear()
  failed = !scope
  try {
    const raw = storage().getItem(STORAGE_KEY)
    const parsed = raw ? envelopeSchema.safeParse(JSON.parse(raw)) : undefined
    const recoveryRaw = storage().getItem(RECOVERY_STORAGE_KEY)
    const recovery = recoveryRaw ? envelopeSchema.safeParse(JSON.parse(recoveryRaw)) : undefined
    if (scope && recovery?.success && recovery.data.scope === scope) {
      drafts = recovery.data.drafts
      storage().setItem(STORAGE_KEY, JSON.stringify(recovery.data))
      storage().removeItem(RECOVERY_STORAGE_KEY)
    } else if (scope && parsed?.success && parsed.data.scope === scope) {
      drafts = parsed.data.drafts
    } else {
      storage().removeItem(STORAGE_KEY)
      storage().removeItem(RECOVERY_STORAGE_KEY)
    }
  } catch {
    failed = true
  }
}

export const revokeComposerDraftStorage = (): void => {
  failed = false
  enabled = false
  scope = undefined
  drafts = []
  try {
    storage().removeItem(STORAGE_KEY)
    storage().removeItem(RECOVERY_STORAGE_KEY)
  } catch {
    /* Re-pairing changes scope even if removal fails. */
  }
}

export const preserveComposerDraftsForRecovery = (): void => {
  for (const writer of writers) writer()
  if (!scope) return
  try {
    const raw = storage().getItem(STORAGE_KEY)
    const parsed = raw ? envelopeSchema.safeParse(JSON.parse(raw)) : undefined
    if (parsed?.success && parsed.data.scope === scope) {
      storage().setItem(RECOVERY_STORAGE_KEY, JSON.stringify(parsed.data))
    }
  } catch {
    // Recovery is best-effort; the in-memory draft remains available to the dialog copy action.
  }
}

export const readComposerDraft = (
  projectId: string,
  key: string,
  retryMessage: string
): ComposerDraft | undefined => {
  const saved = drafts.find((draft) => draft.projectId === projectId && draft.key === key)
  if (!saved) return undefined
  return {
    doc: { nodes: saved.text ? [{ type: 'text', text: saved.text }] : [] },
    annotations: saved.annotations,
    attachments: [],
    attachmentTransfers: saved.files.map((file) => ({
      transferId: `recovered-${crypto.randomUUID()}`,
      name: file.name,
      totalBytes: file.size,
      receivedBytes: 0,
      status: 'error',
      error: retryMessage,
      recoveryReceipt: file.receipt
    })),
    automaticReadingEnabled: saved.automaticReadingEnabled
  }
}

export const writeComposerDraft = (projectId: string, key: string, draft: ComposerDraft): void => {
  const annotations = availableDraftAnnotations(draft.annotations)
  for (const observer of draftObservers)
    observer(projectId, key, annotations === draft.annotations ? draft : { ...draft, annotations })
  if (!enabled || deletedProjects.has(projectId) || deletedSessions.get(key) === projectId) return
  // Old chips are restored as editable labels; a restored draft never silently reattaches stale
  // context or queue intents. Long-paste anchors retain their complete source text.
  const text = draft.doc.nodes
    .map((node) => (node.type === 'pasted-text' ? node.text : docToText({ nodes: [node] })))
    .join('')
  const pastedIds = new Set(
    draft.doc.nodes.flatMap((node) =>
      node.type === 'pasted-text' && node.attachmentId ? [node.attachmentId] : []
    )
  )
  const files = [
    ...draft.attachments
      .filter((file) => !pastedIds.has(file.id))
      .map((file) => ({
        name: file.originalName || file.name,
        size: file.size,
        receipt: file.draftReceipt
      })),
    ...draft.attachmentTransfers
      .filter((file) => !file.pastedTextId)
      .map((file) => ({ name: file.name, size: file.totalBytes, receipt: file.recoveryReceipt }))
  ]
  drafts = drafts.filter((saved) => saved.projectId !== projectId || saved.key !== key)
  if (text || annotations.length || files.length)
    drafts.push({
      projectId,
      key,
      text,
      annotations,
      files,
      automaticReadingEnabled: draft.automaticReadingEnabled
    })
  save()
}

export const removeComposerDrafts = (projectId: string, key?: string): void => {
  if (key) deletedSessions.set(key, projectId)
  else deletedProjects.add(projectId)
  const removeDeleted = (saved: StoredDraft[]): StoredDraft[] =>
    saved.flatMap((draft) => {
      if (draft.projectId === projectId && (!key || draft.key === key)) return []
      const annotations = availableDraftAnnotations(draft.annotations)
      if (annotations === draft.annotations) return [draft]
      return draft.text || annotations.length || draft.files.length
        ? [{ ...draft, annotations }]
        : []
    })
  drafts = removeDeleted(drafts)
  save()
  // Recovery takes precedence on restart, even if its copy predates deletion.
  if (enabled && scope) {
    try {
      const raw = storage().getItem(RECOVERY_STORAGE_KEY)
      const recovery = raw && envelopeSchema.safeParse(JSON.parse(raw))
      if (recovery && recovery.success && recovery.data.scope === scope)
        storage().setItem(
          RECOVERY_STORAGE_KEY,
          JSON.stringify({ ...recovery.data, drafts: removeDeleted(recovery.data.drafts) })
        )
    } catch {
      failed = true
    }
  }
  if (key) for (const listener of deletionListeners) listener()
}

export const composerDraftStorageFailed = (): boolean => failed

export const registerComposerDraftWriter = (writer: () => void): (() => void) => {
  writers.add(writer)
  return () => {
    writers.delete(writer)
  }
}

export const flushComposerDrafts = (): { failed: boolean; text: string; count: number } => {
  for (const writer of writers) writer()
  return {
    failed,
    count: drafts.length,
    text: drafts
      .map((draft) =>
        [
          draft.projectId,
          draft.key,
          draft.text,
          ...sanitizeAnnotations(draft.annotations).map((annotation) => JSON.stringify(annotation)),
          ...draft.files.map((file) => file.name)
        ].join('\n')
      )
      .join('\n\n')
  }
}
