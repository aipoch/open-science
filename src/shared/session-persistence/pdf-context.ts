import {
  type SessionPdfBinding,
  type SessionPdfContext,
  MAX_SESSION_PDF_CONTEXTS,
  type MessagePdfContextSnapshot
} from '../session-runtime-context'
import { isRecord, asString, asNumber } from './primitives'

const PDF_CONTEXT_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/

const sanitizeSessionPdfBinding = (value: unknown): SessionPdfBinding | undefined => {
  if (!isRecord(value) || value.version !== 1) return undefined
  const bindingId = asString(value.bindingId)
  const sourceKind = asString(value.sourceKind)
  const sourceFileId = asString(value.sourceFileId)
  const sourceVersionId = asString(value.sourceVersionId)
  const sourceSessionId = asString(value.sourceSessionId)
  const name = asString(value.name)
  const sizeBytes = asNumber(value.sizeBytes)
  const checksum = asString(value.checksum)
  const linkedAt = asNumber(value.linkedAt)
  const sourceSessionIdRequired =
    sourceKind === 'artifact-version' || sourceKind === 'upload-version'
  if (
    !bindingId ||
    bindingId.length > 512 ||
    (!sourceSessionIdRequired && sourceKind !== 'literature-attachment-version') ||
    !sourceFileId ||
    sourceFileId.length > 512 ||
    !sourceVersionId ||
    sourceVersionId.length > 512 ||
    (sourceSessionIdRequired && (!sourceSessionId || sourceSessionId.length > 512)) ||
    (!sourceSessionIdRequired && sourceSessionId !== undefined) ||
    !name ||
    name.length > 4096 ||
    value.mimeType !== 'application/pdf' ||
    sizeBytes === undefined ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !checksum ||
    !PDF_CONTEXT_CHECKSUM_PATTERN.test(checksum) ||
    linkedAt === undefined ||
    !Number.isSafeInteger(linkedAt) ||
    linkedAt < 0
  ) {
    return undefined
  }
  const binding = {
    version: 1 as const,
    bindingId,
    sourceFileId,
    sourceVersionId,
    name,
    mimeType: 'application/pdf' as const,
    sizeBytes,
    checksum,
    linkedAt
  }
  if (sourceKind === 'literature-attachment-version') {
    return { ...binding, sourceKind }
  }
  if (!sourceSessionId) return undefined
  return { ...binding, sourceKind, sourceSessionId }
}

export const sanitizeSessionPdfContext = (value: unknown): SessionPdfContext | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length < 1 ||
    value.bindings.length > MAX_SESSION_PDF_CONTEXTS
  ) {
    return undefined
  }
  const bindings = value.bindings.map(sanitizeSessionPdfBinding)
  if (bindings.some((binding) => binding === undefined)) return undefined
  const validBindings = bindings as SessionPdfBinding[]
  const identities = validBindings.map(
    ({ sourceKind, sourceVersionId }) => `${sourceKind}:${sourceVersionId}`
  )
  if (
    new Set(validBindings.map(({ bindingId }) => bindingId)).size !== validBindings.length ||
    new Set(identities).size !== identities.length
  ) {
    return undefined
  }
  return { version: 1, bindings: validBindings }
}

export const sanitizeMessagePdfContextSnapshot = (
  value: unknown
): MessagePdfContextSnapshot | undefined => {
  const context = sanitizeSessionPdfContext(value)
  if (!context || !isRecord(value)) return context
  const activeBindingId = asString(value.activeBindingId)
  if (
    !activeBindingId ||
    !context.bindings.some(({ bindingId }) => bindingId === activeBindingId)
  ) {
    return context
  }
  if (value.readingPosition === undefined) return { ...context, activeBindingId }
  if (!isRecord(value.readingPosition)) return context
  const pageNumber = asNumber(value.readingPosition.pageNumber)
  const pageCount = asNumber(value.readingPosition.pageCount)
  if (
    pageNumber === undefined ||
    pageCount === undefined ||
    !Number.isSafeInteger(pageNumber) ||
    !Number.isSafeInteger(pageCount) ||
    pageNumber < 1 ||
    pageCount < pageNumber
  ) {
    return { ...context, activeBindingId }
  }
  return { ...context, activeBindingId, readingPosition: { pageNumber, pageCount } }
}
