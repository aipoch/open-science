import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse,
  ConversationSkillImportResult,
  ConversationSkillImportSelection,
  ImportSkillResult,
  ScannedSkillView,
  SkillBundlePreviewResult
} from '../../shared/settings'
import { parseUploadVersionReference } from '../../shared/uploads'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { UploadRepository } from '../uploads/repository'
import { GITHUB_TOTAL_TIMEOUT_MS } from './github-import'
import { SKILL_IMPORT_LIMITS } from './import-limits'
import { isImportableSkillArchive, isImportableSkillArchivePath } from './skill-archive-sniffer'

type SkillImportApprovalInfo = Omit<ConversationSkillImportApprovalRequest, 'id'>

const withGitHubFlowTimeout = (signal: AbortSignal): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(GITHUB_TOTAL_TIMEOUT_MS)])

type SkillImportCancellationGuard = {
  signal: AbortSignal
  isCancelled: () => boolean
}

type SkillImportApprovalBrokerOptions = {
  broadcast: (request: ConversationSkillImportApprovalRequest) => void
  generateId: () => string
  onSettled?: (id: string) => void
  onLifecycleSettled?: (id: string, state: 'resolved' | 'expired' | 'cancelled') => void
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
    { turnToken: string; eligibleAttachmentUris: Set<string>; controller: AbortController }
  >()

  constructor(private readonly options: SkillImportApprovalBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  beginSessionTurn(sessionId: string, turnToken: string): void {
    this.activeSessionTurns.get(sessionId)?.controller.abort()
    this.activeSessionTurns.set(sessionId, {
      turnToken,
      eligibleAttachmentUris: new Set(),
      controller: new AbortController()
    })
    // A new turn cannot inherit an unanswered dialog from an older turn of the same session.
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle({ id, cancelled: true }, 'cancelled')
    }
  }

  allowSessionTurnAttachment(sessionId: string, turnToken: string, attachmentUri: string): void {
    const turn = this.activeSessionTurns.get(sessionId)
    if (turn?.turnToken === turnToken) turn.eligibleAttachmentUris.add(attachmentUri)
  }

  endSessionTurn(sessionId: string, turnToken: string): void {
    const turn = this.activeSessionTurns.get(sessionId)
    if (turn?.turnToken !== turnToken) return
    turn.controller.abort()
    this.activeSessionTurns.delete(sessionId)
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle({ id, cancelled: true }, 'cancelled')
    }
  }

  createCancellationGuard(
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ): SkillImportCancellationGuard {
    const turn = this.activeSessionTurns.get(sessionId)
    return {
      signal: turn?.controller.signal ?? AbortSignal.abort(),
      isCancelled: () => {
        const activeTurn = this.activeSessionTurns.get(sessionId)
        return (
          activeTurn?.turnToken !== turnToken ||
          !activeTurn.eligibleAttachmentUris.has(attachmentUri)
        )
      }
    }
  }

  createSessionCancellationGuard(sessionId: string): SkillImportCancellationGuard {
    const turn = this.activeSessionTurns.get(sessionId)
    return {
      signal: turn?.controller.signal ?? AbortSignal.abort(),
      isCancelled: () => !turn || this.activeSessionTurns.get(sessionId) !== turn
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
      const timer = this.setTimer(
        () => this.settle({ id, cancelled: true }, 'expired'),
        this.timeoutMs
      )
      this.pending.set(id, { sessionId: info.sessionId, request, resolve, timer })
      this.options.broadcast(request)
    })
  }

  replayPending(): void {
    for (const pending of this.pending.values()) this.options.broadcast(pending.request)
  }

  respond(response: ConversationSkillImportApprovalResponse): void {
    this.settle(response, response.cancelled ? 'cancelled' : 'resolved')
  }

  cancelSession(sessionId: string): void {
    this.activeSessionTurns.get(sessionId)?.controller.abort()
    this.activeSessionTurns.delete(sessionId)
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle({ id, cancelled: true }, 'cancelled')
    }
  }

  cancelAll(): void {
    for (const turn of this.activeSessionTurns.values()) turn.controller.abort()
    this.activeSessionTurns.clear()
    for (const id of this.pending.keys()) this.settle({ id, cancelled: true }, 'cancelled')
  }

  private settle(
    response: ConversationSkillImportApprovalResponse,
    state: 'resolved' | 'expired' | 'cancelled'
  ): void {
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
    try {
      this.options.onLifecycleSettled?.(response.id, state)
    } catch {
      // Inbox projection is independent from renderer teardown and remains best-effort.
    }
  }
}

type ConversationSkillImporterOptions = {
  uploads: Pick<UploadRepository, 'resolveManagedUpload' | 'resolveSessionUpload'>
  managedFileVersions?: Pick<ManagedFileVersionService, 'openVersion'>
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
  scanGitHub?: (url: string, signal: AbortSignal) => Promise<ScannedSkillView[]>
  importGitHub?: (url: string, signal: AbortSignal) => Promise<ImportSkillResult>
  createSessionCancellationGuard?: (sessionId: string) => SkillImportCancellationGuard
  requestApproval: (
    request: SkillImportApprovalInfo,
    cancellation: SkillImportCancellationGuard
  ) => Promise<ConversationSkillImportApprovalResponse>
  onSkillsChanged?: () => void
}

type ConversationSkillAttachmentImportRequest = {
  sessionId: string
  turnToken: string
  attachmentUri: string
}

type ConversationSkillGitHubImportRequest = {
  sessionId: string
  githubUrl: string
}

type ConversationSkillImportRequest =
  ConversationSkillAttachmentImportRequest | ConversationSkillGitHubImportRequest

type AttachmentReference =
  | {
      kind: 'upload-version'
      value: string
      identity: NonNullable<ReturnType<typeof parseUploadVersionReference>>
    }
  | { kind: 'path'; value: string }

const attachmentReferenceFromUri = (uri: string): AttachmentReference => {
  const versionIdentity = parseUploadVersionReference(uri)
  if (versionIdentity) return { kind: 'upload-version', value: uri, identity: versionIdentity }

  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new Error('Skill import requires the exact URI of an attached .zip or .skill bundle.')
  }
  if (parsed.protocol !== 'file:') {
    throw new Error('Skill import only accepts an attached local .zip or .skill bundle.')
  }
  return { kind: 'path', value: fileURLToPath(parsed) }
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
      paths.map(async (path) => {
        const versionIdentity = parseUploadVersionReference(path)
        if (!versionIdentity) {
          const upload = await this.options.uploads.resolveManagedUpload({ path }, { projectId })
          return upload.path
        }
        if (
          versionIdentity.projectId !== projectId ||
          !versionIdentity.fileId ||
          !versionIdentity.sessionId
        ) {
          throw new Error('Upload Version belongs to a different project or is missing its scope.')
        }
        if (!this.options.managedFileVersions) {
          throw new Error('Managed Upload Version access is not configured.')
        }
        const lease = await this.options.managedFileVersions.openVersion(
          { source: 'upload', projectId, fileId: versionIdentity.fileId },
          versionIdentity.versionId
        )
        try {
          if (lease.logicalFile.sessionId !== versionIdentity.sessionId) {
            throw new Error('Upload Version belongs to a different Session.')
          }
          return path
        } finally {
          await lease.close()
        }
      })
    )
    const grant = {
      projectId,
      paths: new Set(managedUploads)
    }
    this.referencedUploadGrants.set(sessionId, grant)

    return () => {
      if (this.referencedUploadGrants.get(sessionId) === grant) {
        this.referencedUploadGrants.delete(sessionId)
      }
    }
  }

  async request(request: ConversationSkillImportRequest): Promise<ConversationSkillImportResult> {
    if ('githubUrl' in request) return this.requestGitHub(request)

    const cancellation = this.options.createCancellationGuard(
      request.sessionId,
      request.turnToken,
      request.attachmentUri
    )
    if (cancellation.isCancelled()) return { status: 'cancelled', skills: [] }
    const requested = attachmentReferenceFromUri(request.attachmentUri)
    const grant = this.referencedUploadGrants.get(request.sessionId)
    let attachmentName: string
    let size: number
    let readBundle: () => Promise<Buffer>
    let isEligible: () => Promise<boolean>
    let verifyUnchanged: () => Promise<void>
    let close: () => Promise<void>

    if (requested.kind === 'upload-version') {
      const { identity } = requested
      if (
        !grant?.paths.has(requested.value) ||
        grant.projectId !== identity.projectId ||
        !identity.projectId ||
        !identity.fileId ||
        !identity.sessionId
      ) {
        throw new Error('Upload Version is not authorized for this conversation turn.')
      }
      if (!this.options.managedFileVersions) {
        throw new Error('Managed Upload Version access is not configured.')
      }
      const lease = await this.options.managedFileVersions.openVersion(
        { source: 'upload', projectId: identity.projectId, fileId: identity.fileId },
        identity.versionId
      )
      if (lease.logicalFile.sessionId !== identity.sessionId) {
        await lease.close()
        throw new Error('Upload Version belongs to a different Session.')
      }
      attachmentName = lease.version.filename
      size = lease.size
      readBundle = async () => Buffer.from(await lease.readRange(0, lease.size))
      isEligible = () =>
        isImportableSkillArchive({
          size: lease.size,
          read: async (position, length) =>
            Buffer.from(await lease.readRange(position, position + length))
        })
      verifyUnchanged = lease.verifyUnchanged
      close = lease.close
    } else {
      const managedUpload = await this.options.uploads.resolveManagedUpload({
        path: requested.value
      })
      const resolvedUpload = grant?.paths.has(managedUpload.path)
        ? managedUpload
        : await this.options.uploads.resolveSessionUpload(
            request.sessionId,
            { path: requested.value },
            grant?.projectId
          )
      const filePath = resolvedUpload.path
      attachmentName = resolvedUpload.name
      size = (await stat(filePath)).size
      readBundle = () => readFile(filePath)
      isEligible = () => isImportableSkillArchivePath(filePath)
      verifyUnchanged = async () => {
        if ((await stat(filePath)).size > SKILL_IMPORT_LIMITS.maxBundleBytes) {
          throw new Error('The attached Skill bundle changed after it was previewed.')
        }
      }
      close = async () => undefined
    }

    try {
      if (!['.zip', '.skill'].includes(extname(attachmentName).toLowerCase())) {
        throw new Error('Skill import only accepts an attached .zip or .skill bundle.')
      }
      if (size > SKILL_IMPORT_LIMITS.maxBundleBytes) {
        throw new Error('The attached Skill bundle is too large to import.')
      }
      // Prompt tags are guidance for the model, not an authorization boundary. Re-run the same
      // bounded classifier here so a forged tool call cannot turn an ordinary archive into an import.
      if (!(await isEligible())) {
        throw new Error('The attached archive is not eligible for Skill import.')
      }

      const previewBundle = await readBundle()
      const previewed = {
        digest: sha256(previewBundle),
        preview: await this.options.previewBundle(previewBundle)
      }
      const preview = previewed.preview
      if (preview.previews.length === 0) {
        throw new Error('The attached bundle does not contain an importable Skill.')
      }

      const approval = await this.options.requestApproval(
        {
          sessionId: request.sessionId,
          source: { kind: 'attachment', label: attachmentName },
          ...preview
        },
        cancellation
      )
      if (cancellation.isCancelled() || approval.cancelled || approval.items.length === 0) {
        return { status: 'cancelled', skills: [] }
      }

      const items = validateSelections(preview, approval.items)
      await verifyUnchanged()
      const bundle = await readBundle()
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
    } finally {
      await close()
    }
  }

  private async requestGitHub(
    request: ConversationSkillGitHubImportRequest
  ): Promise<ConversationSkillImportResult> {
    const createCancellation = this.options.createSessionCancellationGuard
    const scanGitHub = this.options.scanGitHub
    const importGitHub = this.options.importGitHub
    if (!createCancellation || !scanGitHub || !importGitHub) {
      throw new Error('Conversation GitHub Skill import is not configured.')
    }

    const cancellation = createCancellation(request.sessionId)
    if (cancellation.isCancelled()) return { status: 'cancelled', skills: [] }
    const scanSignal = withGitHubFlowTimeout(cancellation.signal)
    let scanned: ScannedSkillView[]
    try {
      scanned = await scanGitHub(request.githubUrl, scanSignal)
    } catch (error) {
      if (cancellation.isCancelled()) return { status: 'cancelled', skills: [] }
      throw error
    }
    if (scanned.length === 0) {
      throw new Error('No importable Skills were found in that GitHub repo.')
    }
    const preview: SkillBundlePreviewResult = {
      previews: scanned.map((candidate) => ({
        subPath: candidate.path || '.',
        name: candidate.name,
        description: candidate.path || 'Repository root',
        metadata: {},
        body: '',
        files: [],
        alreadyImported: candidate.alreadyImported,
        githubUrl: candidate.url
      })),
      skipped: []
    }
    const approval = await this.options.requestApproval(
      {
        sessionId: request.sessionId,
        source: { kind: 'github', label: request.githubUrl },
        ...preview
      },
      cancellation
    )
    if (cancellation.isCancelled() || approval.cancelled || approval.items.length === 0) {
      return { status: 'cancelled', skills: [] }
    }
    const items = validateSelections(preview, approval.items)
    if (cancellation.isCancelled()) return { status: 'cancelled', skills: [] }

    const candidates = new Map(scanned.map((candidate) => [candidate.path || '.', candidate]))
    const skills: ConversationSkillImportResult['skills'] = []
    const errors: NonNullable<ConversationSkillImportResult['errors']> = []
    const importSignal = withGitHubFlowTimeout(cancellation.signal)
    for (const item of items) {
      if (cancellation.isCancelled()) break
      const candidate = candidates.get(item.subPath)!
      try {
        const outcome = await importGitHub(candidate.url, importSignal)
        skills.push({ id: outcome.id, name: candidate.name, status: outcome.status })
      } catch (error) {
        if (cancellation.isCancelled()) break
        if (importSignal.aborted) throw importSignal.reason
        errors.push({
          name: candidate.name,
          error: error instanceof Error ? error.message : 'Import failed.'
        })
      }
    }

    const changed = skills.some(
      (skill) => skill.status === 'imported' || skill.status === 'updated'
    )
    if (cancellation.isCancelled() && skills.length === 0 && errors.length === 0) {
      return { status: 'cancelled', skills: [] }
    }
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
  ConversationSkillAttachmentImportRequest,
  ConversationSkillGitHubImportRequest,
  ConversationSkillImportRequest,
  SkillImportCancellationGuard,
  SkillImportApprovalBrokerOptions,
  SkillImportApprovalInfo
}
