import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
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

type SkillImportApprovalInfo = Omit<ConversationSkillImportApprovalRequest, 'id'>

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

  constructor(private readonly options: SkillImportApprovalBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  request(info: SkillImportApprovalInfo): Promise<ConversationSkillImportApprovalResponse> {
    const id = this.options.generateId()
    const request = { id, ...info }

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
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle({ id, cancelled: true })
    }
  }

  cancelAll(): void {
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
  uploads: Pick<UploadRepository, 'resolveSessionUploadPath'>
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
    request: SkillImportApprovalInfo
  ) => Promise<ConversationSkillImportApprovalResponse>
  onSkillsChanged?: () => void
}

type ConversationSkillImportRequest = {
  sessionId: string
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
  constructor(private readonly options: ConversationSkillImporterOptions) {}

  async request(request: ConversationSkillImportRequest): Promise<ConversationSkillImportResult> {
    const requestedPath = attachmentPathFromUri(request.attachmentUri)
    const filePath = await this.options.uploads.resolveSessionUploadPath(request.sessionId, {
      path: requestedPath
    })
    const attachmentName = basename(filePath)
    if (!['.zip', '.skill'].includes(extname(attachmentName).toLowerCase())) {
      throw new Error('Skill import only accepts an attached .zip or .skill bundle.')
    }
    if ((await stat(filePath)).size > SKILL_IMPORT_LIMITS.maxBundleBytes) {
      throw new Error('The attached Skill bundle is too large to import.')
    }

    const previewed = await (async () => {
      const bundle = await readFile(filePath)
      return { digest: sha256(bundle), preview: await this.options.previewBundle(bundle) }
    })()
    const preview = previewed.preview
    if (preview.previews.length === 0) {
      throw new Error('The attached bundle does not contain an importable Skill.')
    }

    const approval = await this.options.requestApproval({
      sessionId: request.sessionId,
      attachmentName,
      ...preview
    })
    if (approval.cancelled || approval.items.length === 0) {
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
  SkillImportApprovalBrokerOptions,
  SkillImportApprovalInfo
}
