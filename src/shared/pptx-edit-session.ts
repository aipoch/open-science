import type { DeckOutline, PptxOperation } from './pptx-edit'
import type { ManagedFileIdentity } from './managed-file-versions'

export type PptxEditSessionErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'VERSION_UNAVAILABLE'
  | 'INVALID_OPERATIONS'
  | 'OPERATION_REJECTED'
  | 'TOO_LARGE'

export type PptxEditSessionOpenRequest = ManagedFileIdentity & { versionId: string }

export type PptxEditSessionView = {
  sessionId: string
  basedOnVersionId: string
  revision: number
  opCount: number
  summary: string
  outline: DeckOutline
  // Resource key the Office preview opens with source 'staged-edit'.
  stagedKey: string
}

export type PptxEditSessionApplyRequest = {
  sessionId: string
  operations: PptxOperation[]
}

export type PptxEditSessionSaveRequest = {
  sessionId: string
  operations: PptxOperation[]
  expectedHeadVersionId: string
  operationId: string
  restore?: boolean
}

export type PptxEditSessionResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: { code: PptxEditSessionErrorCode; message: string } }
