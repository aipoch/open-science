import type {
  ResearchDraft,
  ResearchDraftPayload,
  ResearchDraftMutationResult
} from '../../../../shared/research-draft'
import type { ResearchWorkspaceRequest } from '../../../../shared/research-workspace'
import type { ComposerDraft } from './workspace-composer-upload-controller'
import type { ComposerSendSnapshot } from './workspace-composer-controller'
import type { UploadedAttachment } from '../../../../shared/uploads'

export type ResearchDraftIdentity = { id: string; revision: number; intentId: string }
export type ResearchDraftApi = Pick<Window['api']['researchDrafts'], 'list' | 'save' | 'act'>
type DraftEdit = {
  signature: string
  payload: ResearchDraftPayload
  identity: ResearchDraftIdentity
  saved: Promise<ResearchDraft>
  failed?: boolean
  save?: () => Promise<ResearchDraft>
}
type Owner = {
  id: string
  revision: number
  editRevision: number
  tail: Promise<unknown>
  current?: DraftEdit
  finalized: Map<string, UploadedAttachment>
  discarded: boolean
  unconfirmed?: () => Promise<ResearchDraft>
}
const keyOf = (scope: ResearchWorkspaceRequest): string =>
  JSON.stringify([scope.projectId, scope.sourceSessionId])
const signatureOf = (
  payload: Pick<
    ResearchDraftPayload,
    'doc' | 'annotations' | 'attachments' | 'transfers' | 'automaticReadingEnabled'
  >
): string =>
  JSON.stringify({
    doc: payload.doc,
    annotations: payload.annotations,
    transfers: payload.transfers,
    automaticReadingEnabled: payload.automaticReadingEnabled,
    attachments: payload.attachments.map((attachment) => [
      attachment.id,
      attachment.name,
      attachment.size
    ])
  })
export const hasResearchDraftContent = (
  draft: ComposerDraft,
  scope: ResearchWorkspaceRequest
): boolean => {
  const content = draft.doc.nodes.filter(
    (node) => node.type !== 'text' || node.text.trim().length > 0
  )
  const sourceOnly =
    content.length === 1 &&
    content[0].type === 'session' &&
    content[0].sessionId === scope.sourceSessionId
  return (
    (content.length > 0 && !sourceOnly) ||
    draft.annotations.length > 0 ||
    draft.attachments.length > 0 ||
    draft.attachmentTransfers.length > 0
  )
}

export const draftToPayload = (
  draft: ComposerDraft
): Omit<ResearchDraftPayload, 'intentId' | 'editRevision'> => ({
  doc: draft.doc,
  annotations: draft.annotations,
  attachments: draft.attachments,
  transfers: draft.attachmentTransfers
    .filter((transfer) => !transfer.pastedTextId)
    .map((transfer) => ({
      name: transfer.name,
      size: transfer.totalBytes,
      mimeType: transfer.mimeType
    })),
  automaticReadingEnabled: draft.automaticReadingEnabled
})
export const payloadToDraft = (
  payload: ResearchDraftPayload,
  retryMessage: string
): ComposerDraft => ({
  doc: {
    nodes: payload.doc.nodes.map((node) =>
      node.type === 'pasted-text' && !node.attachmentId
        ? { type: 'text' as const, text: node.text }
        : node
    )
  },
  annotations: payload.annotations,
  attachments: payload.attachments,
  attachmentTransfers: payload.transfers.map((file) => ({
    transferId: `recovered-${crypto.randomUUID()}`,
    name: file.name,
    totalBytes: file.size,
    receivedBytes: 0,
    mimeType: file.mimeType,
    status: 'error',
    error: retryMessage
  })),
  automaticReadingEnabled: payload.automaticReadingEnabled
})

// One manager per renderer, independent of sessionStorage. The SQLite records are the recovery
// owner; this object serializes writes for this editor and retains each captured send's identity.
export class ResearchDraftPersistence {
  readonly editorId: string
  private readonly owners = new Map<string, Owner>()
  private readonly edits = new Map<string, { owner: Owner; edit: DraftEdit }>()
  private readonly activeKeys = new Map<string, string>()
  private readonly bindings = new Map<string, ResearchWorkspaceRequest>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private pending = 0
  error?: string
  constructor(
    private readonly api: () => ResearchDraftApi | undefined,
    editorId: string = crypto.randomUUID()
  ) {
    this.editorId = editorId
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = (): number => this.version
  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
  get saving(): boolean {
    return this.pending > 0
  }
  bind(scope: ResearchWorkspaceRequest, draftKey: string): void {
    this.bindings.set(JSON.stringify([scope.projectId, draftKey]), scope)
    this.activeKeys.set(keyOf(scope), draftKey)
  }
  scopeFor(projectId: string, draftKey: string): ResearchWorkspaceRequest | undefined {
    return this.bindings.get(JSON.stringify([projectId, draftKey]))
  }
  private owner(scope: ResearchWorkspaceRequest): Owner {
    const key = keyOf(scope)
    let owner = this.owners.get(key)
    if (!owner || owner.discarded) {
      owner = {
        id: crypto.randomUUID(),
        revision: 0,
        editRevision: 0,
        tail: Promise.resolve(),
        finalized: new Map(),
        discarded: false
      }
      this.owners.set(key, owner)
    }
    return owner
  }
  private accept(result: ResearchDraftMutationResult): ResearchDraft {
    if (result.status === 'conflict')
      throw new Error(
        'This research draft changed in another window. Your current input has been kept.'
      )
    return result.draft
  }
  private queue<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
    this.pending++
    this.emit()
    const task = owner.tail.then(operation, operation)
    owner.tail = task
      .then(
        () => {
          this.error = undefined
        },
        (error: unknown) => {
          this.error = error instanceof Error ? error.message : String(error)
        }
      )
      .finally(() => {
        this.pending--
        this.emit()
      })
    return task
  }
  write(
    projectId: string,
    draftKey: string,
    draft: ComposerDraft
  ): ResearchDraftIdentity | undefined {
    const scope = this.scopeFor(projectId, draftKey)
    const api = this.api()
    if (!scope || !api || this.activeKeys.get(keyOf(scope)) !== draftKey) return undefined
    if (!hasResearchDraftContent(draft, scope)) {
      const owner = this.owners.get(keyOf(scope))
      if (owner && !owner.discarded && owner.current) {
        owner.discarded = true
        void this.queue(owner, async () => {
          if (!owner.revision) return
          this.accept(
            await api.act({
              ...scope,
              id: owner.id,
              editorId: this.editorId,
              expectedRevision: owner.revision,
              action: 'discard'
            })
          )
        }).catch(() => undefined)
      }
      return undefined
    }
    const owner = this.owner(scope)
    const base = draftToPayload(draft)
    const signature = signatureOf(base)
    if (owner.current?.signature === signature) return owner.current.identity
    const identity = { id: owner.id, revision: ++owner.editRevision, intentId: crypto.randomUUID() }
    const payload: ResearchDraftPayload = {
      ...base,
      editRevision: identity.revision,
      intentId: identity.intentId
    }
    const edit: DraftEdit = { signature, payload, identity, saved: undefined! }
    // Freeze each request before crossing IPC. A lost acknowledgement must retry exactly that
    // request before a newer edit advances the same row's CAS revision.
    let request: Parameters<ResearchDraftApi['save']>[0] | undefined
    const confirm = async (): Promise<ResearchDraft> => {
      request ??= {
        ...scope,
        id: owner.id,
        editorId: this.editorId,
        expectedRevision: owner.revision,
        payload: {
          ...payload,
          attachments: payload.attachments.map((file) => owner.finalized.get(file.id) ?? file)
        }
      }
      owner.unconfirmed = confirm
      const result = this.accept(await api.save(request))
      owner.revision = Math.max(owner.revision, result.revision)
      for (const file of result.payload.attachments) owner.finalized.set(file.id, file)
      owner.unconfirmed = undefined
      edit.failed = false
      edit.saved = Promise.resolve(result)
      return result
    }
    edit.save = async () => {
      if (owner.unconfirmed && owner.unconfirmed !== confirm) await owner.unconfirmed()
      return confirm()
    }
    edit.saved = this.saveEdit(owner, edit)
    // Autosave errors are surfaced through the manager; a send awaits the same promise explicitly.
    void edit.saved.catch(() => undefined)
    owner.current = edit
    return identity
  }
  private saveEdit(owner: Owner, edit: DraftEdit): Promise<ResearchDraft> {
    edit.failed = false
    const saved = this.queue(owner, edit.save!)
    void saved.catch(() => {
      edit.failed = true
    })
    return saved
  }
  capture(projectId: string, snapshot: ComposerSendSnapshot): ResearchDraftIdentity | undefined {
    const identity = this.write(projectId, snapshot.draftKey, {
      ...snapshot,
      attachmentTransfers: [],
      automaticReadingEnabled: snapshot.automaticReadingEnabled !== false
    })
    const scope = this.scopeFor(projectId, snapshot.draftKey)
    const owner = scope ? this.owners.get(keyOf(scope)) : undefined
    if (identity && owner?.current)
      this.edits.set(identity.intentId, { owner, edit: owner.current })
    return identity
  }
  async persist(projectId: string, snapshot: ComposerSendSnapshot): Promise<ComposerSendSnapshot> {
    const scope = this.scopeFor(projectId, snapshot.draftKey)
    if (!scope) return snapshot
    const identity = snapshot.researchDraft ?? this.capture(projectId, snapshot)
    const captured = identity ? this.edits.get(identity.intentId) : undefined
    const edit = captured?.edit
    if (!identity || !edit || !captured)
      throw new Error(
        'The research draft changed before it could be saved. Your current input has been kept.'
      )
    if (edit.failed && edit.save && !captured.owner.discarded)
      edit.saved = this.saveEdit(captured.owner, edit)
    const saved = await edit.saved
    return { ...snapshot, researchDraft: identity, attachments: saved.payload.attachments }
  }
  currentId(scope: ResearchWorkspaceRequest): string | undefined {
    return this.owners.get(keyOf(scope))?.id
  }
  async list(scope: ResearchWorkspaceRequest): Promise<ResearchDraft[]> {
    return (await this.api()?.list(scope)) ?? []
  }
  async claim(draft: ResearchDraft): Promise<ResearchDraft> {
    const api = this.api()
    if (!api) throw new Error('Research draft storage is unavailable.')
    return this.accept(
      await api.act({
        projectId: draft.projectId,
        sourceSessionId: draft.sourceSessionId,
        id: draft.id,
        editorId: this.editorId,
        expectedRevision: draft.revision,
        action: 'claim'
      })
    )
  }
  adopt(draft: ResearchDraft): void {
    const identity = {
      id: draft.id,
      revision: draft.payload.editRevision,
      intentId: draft.payload.intentId
    }
    const owner: Owner = {
      id: draft.id,
      revision: draft.revision,
      editRevision: draft.payload.editRevision,
      discarded: false,
      tail: Promise.resolve(),
      finalized: new Map(draft.payload.attachments.map((file) => [file.id, file])),
      current: {
        identity,
        payload: draft.payload,
        signature: signatureOf(draft.payload),
        saved: Promise.resolve(draft)
      }
    }
    this.owners.set(keyOf(draft), owner)
    this.edits.set(identity.intentId, { owner, edit: owner.current! })
    this.emit()
  }
  async discard(draft: ResearchDraft): Promise<void> {
    const claimed = draft.editorId === this.editorId ? draft : await this.claim(draft)
    const api = this.api()
    if (!api) return
    this.accept(
      await api.act({
        projectId: claimed.projectId,
        sourceSessionId: claimed.sourceSessionId,
        id: claimed.id,
        editorId: this.editorId,
        expectedRevision: claimed.revision,
        action: 'discard',
        releaseAttachments: true
      })
    )
    this.emit()
  }
}
let instance: ResearchDraftPersistence | undefined
export const researchDraftPersistence = (): ResearchDraftPersistence =>
  (instance ??= new ResearchDraftPersistence(() => window.api?.researchDrafts))
