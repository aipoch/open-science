import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse,
  ConversationSkillImportResult,
  ConversationSkillImportSelection,
  SkillBundlePreviewResult
} from '../../shared/settings'
import type { UploadRepository } from '../uploads/repository'
import { SKILL_IMPORT_LIMITS } from './import-limits'
import { isImportableSkillArchivePath } from './skill-archive-sniffer'

type SkillImportApprovalInfo = Omit<ConversationSkillImportApprovalRequest, 'id'>

type SkillImportCancellationGuard = {
  isCancelled: () => boolean
}

type SkillImportApprovalBrokerOptions = {
  broadcast: (request: ConversationSkillImportApprovalRequest) => void
  generateId: () => string
  onSettled?: (id: string) => void
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

// Holds one agent tool call while the renderer shows the bounded Skill preview. Unknown and late
// responses are ignored, and an unanswered dialog cancels rather than holding the agent forever.
class SkillImportApprovalBroker {
  private readonly pending = new Map<
    string,
    {
      sessionId: string
      request: ConversationSkillImportApprovalRequest
      resolve: (response: ConversationSkillImportApprovalResponse) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly activeSessionTurns = new Map<
    string,
    { turnToken: string; eligibleAttachmentUris: Set<string> }
  >()

  constructor(private readonly options: SkillImportApprovalBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  beginSessionTurn(sessionId: string, turnToken: string): void {
    this.activeSessionTurns.set(sessionId, {
      turnToken,
      eligibleAttachmentUris: new Set()
    })
    // A new turn cannot inherit an unanswered dialog from an older turn of the same session.
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle({ id, cancelled: true })
    }
  }

  allowSessionTurnAttachment(sessionId: string, turnToken: string, attachmentUri: string): void {
    const turn = this.activeSessionTurns.get(sessionId)
    if (turn?.turnToken === turnToken) turn.eligibleAttachmentUris.add(attachmentUri)
  }

  endSessionTurn(sessionId: string, turnToken: string): void {
    if (this.activeSessionTurns.get(sessionId)?.turnToken !== turnToken) return
    this.activeSessionTurns.delete(sessionId)
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle({ id, cancelled: true })
    }
  }

  createCancellationGuard(
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ): SkillImportCancellationGuard {
    return {
      isCancelled: () => {
        const turn = this.activeSessionTurns.get(sessionId)
        return turn?.turnToken !== turnToken || !turn.eligibleAttachmentUris.has(attachmentUri)
      }
    }
  }

  request(
    info: SkillImportApprovalInfo,
    cancellation?: SkillImportCancellationGuard
  ): Promise<ConversationSkillImportApprovalResponse> {
    const id = this.options.generateId()
    const request = { id, ...info }

    // A teardown may have arrived while the importer was asynchronously sniffing/previewing the
    // archive, before this approval was registered. Never broadcast a dialog for that stale request.
    if (cancellation?.isCancelled()) return Promise.resolve({ id, cancelled: true })

    return new Promise((resolve) => {
      const timer = this.setTimer(() => this.settle({ id, cancelled: true }), this.timeoutMs)
      this.pending.set(id, { sessionId: info.sessionId, request, resolve, timer })
      this.options.broadcast(request)
    })
  }

  replayPending(): void {
    for (const pending of this.pending.values()) this.options.broadcast(pending.request)
  }

  respond(response: ConversationSkillImportApprovalResponse): void {
    this.settle(response)
  }

  cancelSession(sessionId: string): void {
    this.activeSessionTurns.delete(sessionId)
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle({ id, cancelled: true })
    }
  }

  cancelAll(): void {
    this.activeSessionTurns.clear()
    for (const id of this.pending.keys()) this.settle({ id, cancelled: true })
  }

  private settle(response: ConversationSkillImportApprovalResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return

    this.clearTimer(pending.timer)
    this.pending.delete(response.id)
    pending.resolve(response)
    try {
      this.options.onSettled?.(response.id)
    } catch {
      // Renderer teardown must not change the broker result or leave the agent call parked.
    }
  }
}

type ConversationSkillImporterOptions = {
  uploads: Pick<UploadRepository, 'resolveManagedUpload' | 'resolveSessionUpload'>
  createCancellationGuard: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => SkillImportCancellationGuard
  previewBundle: (bundle: Buffer) => Promise<SkillBundlePreviewResult>
  importBundle: (
    bundle: Buffer,
    items: ConversationSkillImportSelection[]
  ) => Promise<
    Array<{
      subPath: string
      outcome?: { status: 'imported' | 'unchanged' | 'updated'; id: string }
      error?: string
    }>
  >
  requestApproval: (
    request: SkillImportApprovalInfo,
    cancellation: SkillImportCancellationGuard
  ) => Promise<ConversationSkillImportApprovalResponse>
  onSkillsChanged?: () => void
}

type ConversationSkillImportRequest = {
  sessionId: string
  turnToken: string
  attachmentUri: string
}

const attachmentPathFromUri = (uri: string): string => {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new Error('Skill import requires the exact URI of an attached .zip or .skill bundle.')
  }
  if (parsed.protocol !== 'file:') {
    throw new Error('Skill import only accepts an attached local .zip or .skill bundle.')
  }
  return fileURLToPath(parsed)
}

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

const validateSelections = (
  preview: SkillBundlePreviewResult,
  items: ConversationSkillImportSelection[]
): ConversationSkillImportSelection[] => {
  const candidates = new Map(preview.previews.map((candidate) => [candidate.subPath, candidate]))
  const selected = new Set<string>()
  const replacementTargets = new Set<string>()

  return items.map((item) => {
    const candidate = candidates.get(item.subPath)
    if (!candidate || selected.has(item.subPath)) {
      throw new Error('The Skill import selection does not match the approved preview.')
    }
    if (item.replaceId !== candidate.replaceableId) {
      throw new Error('The Skill replacement target does not match the approved preview.')
    }
    if (candidate.replaceableId !== undefined) {
      if (replacementTargets.has(candidate.replaceableId)) {
        throw new Error('A Skill import cannot replace the same installed Skill more than once.')
      }
      replacementTargets.add(candidate.replaceableId)
    }
    selected.add(item.subPath)
    return {
      subPath: item.subPath,
      ...(candidate.replaceableId !== undefined ? { replaceId: candidate.replaceableId } : {})
    }
  })
}

// Owns the complete conversation import transaction behind one agent-facing request: attachment
// ownership, bounded preview, user confirmation, selection validation, import, and reload signal.
class ConversationSkillImporter {
  private readonly referencedUploadGrants = new Map<
    string,
    { projectId: string; paths: ReadonlySet<string> }
  >()

  constructor(private readonly options: ConversationSkillImporterOptions) {}

  // Grants one active turn access to uploads the user explicitly selected through `@`. Returning an
  // identity-scoped disposer prevents a stale turn from revoking a newer turn's grant for the same
  // conversation during context-reset recovery.
  async authorizeReferencedUploads(
    projectId: string,
    sessionId: string,
    paths: string[]
  ): Promise<() => void> {
    const managedUploads = await Promise.all(
      paths.map((path) => this.options.uploads.resolveManagedUpload({ path }))
    )
    const grant = {
      projectId,
      paths: new Set(managedUploads.map((upload) => upload.path))
    }
    this.referencedUploadGrants.set(sessionId, grant)

    return () => {
      if (this.referencedUploadGrants.get(sessionId) === grant) {
        this.referencedUploadGrants.delete(sessionId)
      }
    }
  }

  async request(request: ConversationSkillImportRequest): Promise<ConversationSkillImportResult> {
    const cancellation = this.options.createCancellationGuard(
      request.sessionId,
      request.turnToken,
      request.attachmentUri
    )
    if (cancellation.isCancelled()) return { status: 'cancelled', skills: [] }
    const requestedPath = attachmentPathFromUri(request.attachmentUri)
    const grant = this.referencedUploadGrants.get(request.sessionId)
    const managedUpload = await this.options.uploads.resolveManagedUpload({ path: requestedPath })
    const resolvedUpload = grant?.paths.has(managedUpload.path)
      ? managedUpload
      : await this.options.uploads.resolveSessionUpload(
          request.sessionId,
          { path: requestedPath },
          grant?.projectId
        )
    const filePath = resolvedUpload.path
    const attachmentName = resolvedUpload.name
    if (!['.zip', '.skill'].includes(extname(attachmentName).toLowerCase())) {
      throw new Error('Skill import only accepts an attached .zip or .skill bundle.')
    }
    if ((await stat(filePath)).size > SKILL_IMPORT_LIMITS.maxBundleBytes) {
      throw new Error('The attached Skill bundle is too large to import.')
    }
    // Prompt tags are guidance for the model, not an authorization boundary. Re-run the same bounded
    // classifier here so a forged tool call cannot turn an ordinary session ZIP into an import flow.
    if (!(await isImportableSkillArchivePath(filePath))) {
      throw new Error('The attached archive is not eligible for Skill import.')
    }

    const previewed = await (async () => {
      const bundle = await readFile(filePath)
      return { digest: sha256(bundle), preview: await this.options.previewBundle(bundle) }
    })()
    const preview = previewed.preview
    if (preview.previews.length === 0) {
      throw new Error('The attached bundle does not contain an importable Skill.')
    }

    const approval = await this.options.requestApproval(
      {
        sessionId: request.sessionId,
        attachmentName,
        ...preview
      },
      cancellation
    )
    if (cancellation.isCancelled() || approval.cancelled || approval.items.length === 0) {
      return { status: 'cancelled', skills: [] }
    }

    const items = validateSelections(preview, approval.items)
    if ((await stat(filePath)).size > SKILL_IMPORT_LIMITS.maxBundleBytes) {
      throw new Error('The attached Skill bundle changed after it was previewed.')
    }
    const bundle = await readFile(filePath)
    if (sha256(bundle) !== previewed.digest) {
      throw new Error('The attached Skill bundle changed after it was previewed.')
    }
    if (cancellation.isCancelled()) return { status: 'cancelled', skills: [] }
    const outcomes = await this.options.importBundle(bundle, items)
    const previewsByPath = new Map(
      preview.previews.map((candidate) => [candidate.subPath, candidate])
    )
    const skills: ConversationSkillImportResult['skills'] = []
    const errors: NonNullable<ConversationSkillImportResult['errors']> = []

    for (const entry of outcomes) {
      const name = previewsByPath.get(entry.subPath)?.name ?? entry.subPath
      if (entry.outcome) {
        skills.push({
          id: entry.outcome.id,
          name,
          status: entry.outcome.status
        })
      } else {
        errors.push({ name, error: entry.error ?? 'Import failed.' })
      }
    }

    const changed = skills.some(
      (skill) => skill.status === 'imported' || skill.status === 'updated'
    )
    if (changed) this.options.onSkillsChanged?.()

    return {
      status: errors.length > 0 ? 'partial' : changed ? 'imported' : 'unchanged',
      skills,
      ...(errors.length > 0 ? { errors } : {})
    }
  }
}

export { ConversationSkillImporter, SkillImportApprovalBroker }
export type {
  ConversationSkillImporterOptions,
  ConversationSkillImportRequest,
  SkillImportCancellationGuard,
  SkillImportApprovalBrokerOptions,
  SkillImportApprovalInfo
}
