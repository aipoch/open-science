export type ResourceFacts = Record<string, unknown>
const keys = new Set(
  (
    'runtimeId epoch framework status pid parentPid birth ownerPid ownerBirth role sessionId providerSessionId projectId ' +
    'frameId turnId activeBranchId kind sequence generation attached sessions interactions inFlight ' +
    'reconnect retirement activePrompts activeReviewers activityLeases operationLeases startups additionalActivity ' +
    'idleReleasePending retirementPending teardownPending providerPending skillsPending ' +
    'kernelEpochId receiptId lane attempt expected code signal reaped osReaped reason truncated total ' +
    'supported complete startedAt endedAt system committedBytes commitLimitBytes availableBytes systemError ' +
    'processes privateBytes workingSetBytes handleCount error sampleId elapsedMs dropped sealsSuppressed rotatedBytes ' +
    'pendingBytes failed missing snapshots processCoverage writeFailures processed processingMs nativeMs backoffMs ' +
    'activityProcessed activityTotal'
  ).split(' ')
)

// Only structural metadata enters the default journal. Unknown keys, free-form payloads and paths
// are discarded here even if a future observer accidentally passes a broader object.
export const resourceFacts = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return /^[\w.:-]{1,160}$/.test(value) ? value : undefined
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => resourceFacts(item, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  const output: ResourceFacts = {}
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) continue
    const projected = resourceFacts(item, depth + 1)
    if (projected !== undefined) output[key] = projected
  }
  return output
}
