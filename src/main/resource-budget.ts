import type { IncomingMessage } from 'node:http'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

const LOCAL_RESOURCE_BUDGETS = Object.freeze({
  requestBytes: 64 * MIB,
  artifactInlineBytes: 32 * MIB,
  artifactFileBytes: 1 * GIB,
  artifactTurnBytes: 2 * GIB,
  artifactSessionBytes: 10 * GIB,
  notebookEvidenceProjectBytes: 10 * GIB,
  diskReserveBytes: 2 * GIB,
  reviewerReadBytes: 256 * 1024,
  reviewerSessionBytes: 2 * MIB
})

type LocalResourceBudgetOverrides = Partial<typeof LOCAL_RESOURCE_BUDGETS>

type ResourceBudgetDimension =
  'request' | 'file' | 'turn' | 'session' | 'disk-reserve' | 'reviewer-session'

class ResourceBudgetExceededError extends Error {
  readonly name = 'ResourceBudgetExceededError'

  constructor(
    readonly dimension: ResourceBudgetDimension,
    readonly observedBytes: number,
    readonly limitBytes: number
  ) {
    super(
      `Local resource ${dimension} budget exceeded: ${observedBytes} bytes exceeds ${limitBytes} bytes.`
    )
  }
}

const assertWithinResourceBudget = (
  dimension: ResourceBudgetDimension,
  observedBytes: number,
  limitBytes: number
): void => {
  if (!Number.isSafeInteger(observedBytes) || observedBytes < 0) {
    throw new TypeError('Resource budget observations must be non-negative safe integers.')
  }
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new TypeError('Resource budget limits must be non-negative safe integers.')
  }
  if (observedBytes > limitBytes) {
    throw new ResourceBudgetExceededError(dimension, observedBytes, limitBytes)
  }
}

const declaredContentLength = (request: IncomingMessage): number | undefined => {
  const value = request.headers['content-length']
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : undefined
}

const readBoundedJsonBody = async <Result = unknown>(
  request: IncomingMessage,
  maxBytes = LOCAL_RESOURCE_BUDGETS.requestBytes,
  options?: { emptyValue: Result }
): Promise<Result> => {
  const declared = declaredContentLength(request)
  if (declared !== undefined) assertWithinResourceBudget('request', declared, maxBytes)

  const chunks: Buffer[] = []
  let observedBytes = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    observedBytes += buffer.byteLength
    assertWithinResourceBudget('request', observedBytes, maxBytes)
    chunks.push(buffer)
  }

  if (chunks.length === 0 && options) return options.emptyValue
  return JSON.parse(Buffer.concat(chunks, observedBytes).toString('utf8')) as Result
}

export {
  LOCAL_RESOURCE_BUDGETS,
  ResourceBudgetExceededError,
  assertWithinResourceBudget,
  readBoundedJsonBody
}
export type { ResourceBudgetDimension }
export type { LocalResourceBudgetOverrides }
