import { z } from 'zod'
import { sanitizeAnnotations } from '../../../../shared/annotations'
import { docToText } from './composer/composer-doc'
import type { ComposerDraft } from './workspace-composer-upload-controller'

const STORAGE_KEY = 'open-science-composer-drafts-v1'
const storedDraftSchema = z.object({
  projectId: z.string(),
  key: z.string(),
  text: z.string(),
  annotations: z.array(z.unknown()),
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
let scope: string | undefined
let drafts: StoredDraft[] = []
let failed = false
const writers = new Set<() => void>()
const deletedProjects = new Set<string>()
const deletedSessions = new Set<string>()

const save = (): void => {
  if (!enabled) return
  if (!scope) {
    failed = true
    return
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, scope, drafts }))
    failed = false
  } catch {
    failed = true
    // A failed overwrite must not leave an older, possibly already-sent draft available to reload.
    // Keep the current in-memory drafts for the explicit copy fallback.
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      /* Storage access itself may be denied. */
    }
  }
}

// sessionStorage isolates tabs and origins, survives reload, and avoids cross-window overwrites.
// The server supplies a non-secret scope tied to the host token and authorization principal.
export const configureComposerDraftStorage = (nextScope?: string): void => {
  enabled = true
  scope = nextScope
  drafts = []
  deletedProjects.clear()
  deletedSessions.clear()
  failed = !scope
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const parsed = raw ? envelopeSchema.safeParse(JSON.parse(raw)) : undefined
    if (scope && parsed?.success && parsed.data.scope === scope) drafts = parsed.data.drafts
    else sessionStorage.removeItem(STORAGE_KEY)
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
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* Re-pairing changes scope even if removal fails. */
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
    annotations: sanitizeAnnotations(saved.annotations),
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
  if (!enabled || deletedProjects.has(projectId) || deletedSessions.has(key)) return
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
  if (text || draft.annotations.length || files.length)
    drafts.push({
      projectId,
      key,
      text,
      annotations: draft.annotations,
      files,
      automaticReadingEnabled: draft.automaticReadingEnabled
    })
  save()
}

export const removeComposerDrafts = (projectId: string, key?: string): void => {
  if (key) deletedSessions.add(key)
  else deletedProjects.add(projectId)
  drafts = drafts.filter(
    (draft) => draft.projectId !== projectId || (key !== undefined && draft.key !== key)
  )
  save()
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
