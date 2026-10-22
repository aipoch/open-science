const MIB = 1024 * 1024
const GIB = 1024 * MIB

const LOCAL_RESOURCE_BUDGETS = Object.freeze({
  requestBytes: 64 * MIB,
  artifactSaveSessionRequests: 16,
  artifactSaveProcessRequests: 64,
  artifactSaveSessionPayloadBytes: 128 * MIB,
  artifactSaveProcessPayloadBytes: 512 * MIB,
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

export { LOCAL_RESOURCE_BUDGETS, ResourceBudgetExceededError, assertWithinResourceBudget }
export type { ResourceBudgetDimension, LocalResourceBudgetOverrides }
