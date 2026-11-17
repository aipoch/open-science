import { applyOperations, pptxOperationsSchema, readOutline } from '../../shared/pptx-edit'
import type { PptxOperation } from '../../shared/pptx-edit'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { PptxDraftStore } from './draft-store'
import {
  resolvePptxTarget,
  type PptxTarget,
  type ProposePptxOperationsInput,
  type ReadPptxOutlineInput
} from './agent-tools'

type AgentService = Pick<ManagedFileVersionService, 'inspect' | 'openVersion'>

type PptxAgentContext = Readonly<{ projectId: string; sessionId: string; signal: AbortSignal }>

class PptxAgentError extends Error {
  constructor(
    readonly code: 'PPTX_TARGET_INVALID' | 'PPTX_HEAD_STALE' | 'PPTX_OPERATION_REJECTED',
    message: string
  ) {
    super(`${code}: ${message}`)
    this.name = 'PptxAgentError'
  }
}

class PptxAgentHandler {
  constructor(
    private readonly service: AgentService,
    private readonly drafts: PptxDraftStore
  ) {}

  async read(context: PptxAgentContext, input: ReadPptxOutlineInput): Promise<object> {
    const target = this.target(context, input.path)
    const headVersionId = await this.headOf(target)
    const bytes = await this.bytesOf(target, headVersionId)
    const draft = this.drafts.get(target.identity)
    return {
      headVersionId,
      outline: readOutline(bytes),
      pendingDraft: draft
        ? { draftId: draft.draftId, opCount: draft.operations.length, summary: draft.summary }
        : null
    }
  }

  async propose(context: PptxAgentContext, input: ProposePptxOperationsInput): Promise<object> {
    const target = this.target(context, input.path)
    const headVersionId = await this.headOf(target)
    if (headVersionId !== input.expectedHeadVersionId) {
      throw new PptxAgentError(
        'PPTX_HEAD_STALE',
        'The deck changed since it was read. Call read_pptx_outline again and rebuild the operations.'
      )
    }
    const base = await this.bytesOf(target, headVersionId)
    const previous = this.drafts.get(target.identity)
    const carried = previous?.basedOnVersionId === headVersionId ? previous.operations : []
    const operations: PptxOperation[] = [...carried]
    const parsed = this.parse(input.operations)
    operations.push(...parsed)
    context.signal.throwIfAborted()
    const result = this.apply(base, operations)
    const draft = this.drafts.put({
      identity: target.identity,
      basedOnVersionId: headVersionId,
      operations,
      bytes: result.bytes,
      summary: result.summary
    })
    return {
      draftId: draft.draftId,
      status: 'pending-user-review',
      opCount: operations.length,
      summary: result.summary,
      note: 'Nothing is saved until the user accepts the draft.'
    }
  }

  private parse(raw: readonly unknown[]): PptxOperation[] {
    const parsed = pptxOperationsSchema.safeParse(raw)
    if (!parsed.success) {
      throw new PptxAgentError(
        'PPTX_OPERATION_REJECTED',
        parsed.error.issues[0]?.message ?? 'Invalid.'
      )
    }
    return parsed.data
  }

  private apply(
    base: Uint8Array,
    operations: readonly PptxOperation[]
  ): { bytes: Uint8Array; summary: string } {
    try {
      return applyOperations(base, [...operations])
    } catch (error) {
      throw new PptxAgentError(
        'PPTX_OPERATION_REJECTED',
        error instanceof Error ? error.message : 'Operations could not be applied.'
      )
    }
  }

  private target(context: PptxAgentContext, path: string): PptxTarget {
    const target = resolvePptxTarget(context.projectId, context.sessionId, path)
    if (!target) {
      throw new PptxAgentError('PPTX_TARGET_INVALID', 'Path is not a deck version in this session.')
    }
    return target
  }

  private async headOf(target: PptxTarget): Promise<string> {
    return (await this.service.inspect({ ...target.identity, versionId: target.versionId }))
      .headVersionId
  }

  private async bytesOf(target: PptxTarget, versionId: string): Promise<Uint8Array> {
    const lease = await this.service.openVersion(target.identity, versionId)
    try {
      const bytes = await lease.readRange(0, lease.size)
      await lease.verifyUnchanged()
      return bytes
    } finally {
      await lease.close()
    }
  }
}

export { PptxAgentError, PptxAgentHandler }
export type { PptxAgentContext }
