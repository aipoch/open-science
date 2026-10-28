import type {
  AcpProviderTurnAdapter,
  AcpProviderTurnBeginInput,
  AcpProviderTurnProbe,
  AcpProviderTurnResult
} from './provider-turn-adapter'
import { diffOpenCodeTurnUsage, type OpenCodeUsageSnapshot } from './opencode-turn-usage'
import { isRecord } from '../value-guards'

export type OpenCodeUsageSnapshotReader = (
  providerSessionId: string,
  cwd: string
) => Promise<OpenCodeUsageSnapshot | undefined>

const EMPTY_RESULT: AcpProviderTurnResult = Object.freeze({})

const readSnapshotBestEffort = async (
  reader: OpenCodeUsageSnapshotReader,
  providerSessionId: string,
  cwd: string
): Promise<OpenCodeUsageSnapshot | undefined> => {
  try {
    return await reader(providerSessionId, cwd)
  } catch {
    return undefined
  }
}

const normalizeTurnUsage = (
  before: OpenCodeUsageSnapshot | undefined,
  after: OpenCodeUsageSnapshot | undefined
): AcpProviderTurnResult => {
  const diff = diffOpenCodeTurnUsage(before, after)
  if (!diff) return EMPTY_RESULT

  const { turnCount: modelTurnCount, ...turnUsage } = diff.turnUsage
  const contextUsedTokens =
    diff.lastModelStepUsage.inputTokens + diff.lastModelStepUsage.cacheTokens
  return Object.freeze({
    turnUsage: Object.freeze(turnUsage),
    modelTurnCount,
    modelCalls: Object.freeze(diff.modelCalls.map((call) => Object.freeze({ ...call }))),
    ...(Number.isSafeInteger(contextUsedTokens) ? { contextUsedTokens } : {}),
    lastModelStepUsage: Object.freeze(diff.lastModelStepUsage)
  })
}

/**
 * Adapts an authenticated, credential-opaque snapshot reader into normalized provider-turn facts.
 * Each probe retains only its before snapshot and releases that attempt state on either close path.
 */
export class AcpOpenCodeTurnAdapter implements AcpProviderTurnAdapter {
  constructor(private readonly readUsageSnapshot: OpenCodeUsageSnapshotReader) {}

  async begin(input: AcpProviderTurnBeginInput): Promise<AcpProviderTurnProbe> {
    const { providerSessionId, cwd } = input
    let reader: OpenCodeUsageSnapshotReader | undefined = this.readUsageSnapshot
    let before = await readSnapshotBestEffort(reader, providerSessionId, cwd)
    let closed = false
    let compactionId: string | undefined
    let observedCompaction: AcpProviderTurnResult['compaction']

    const close = (): void => {
      closed = true
      before = undefined
      reader = undefined
      compactionId = undefined
      observedCompaction = undefined
    }

    return Object.freeze({
      observe: (message: unknown) => {
        if (closed || !isRecord(message) || message.sessionId !== providerSessionId) return
        const update = message.update
        if (
          !isRecord(update) ||
          update.sessionUpdate !== 'session_info_update' ||
          !isRecord(update._meta)
        )
          return
        const marker = update._meta['opencode/compaction']
        if (
          !isRecord(marker) ||
          typeof marker.messageId !== 'string' ||
          before?.assistantMessageIds.has(marker.messageId)
        )
          return
        if (marker.status === 'started') {
          compactionId = marker.messageId
          observedCompaction = undefined
        } else if (marker.status === 'completed' && marker.messageId === compactionId) {
          observedCompaction = { succeeded: true }
        } else if (
          marker.status === 'failed' &&
          (!compactionId || marker.messageId === compactionId)
        ) {
          observedCompaction = {
            succeeded: false,
            ...(isRecord(marker.error) && typeof marker.error.message === 'string'
              ? { error: marker.error.message.slice(0, 2000) }
              : {})
          }
        }
      },
      finalize: async () => {
        if (closed || !reader) return EMPTY_RESULT
        const baseline = before
        const finalReader = reader
        const observed = observedCompaction
        close()
        const after = await readSnapshotBestEffort(finalReader, providerSessionId, cwd)
        const compaction =
          observed ??
          (baseline && after
            ? [...(after.compactionByMessageId ?? [])]
                .filter(([id]) => !baseline.assistantMessageIds.has(id))
                .at(-1)?.[1]
            : undefined)
        return { ...normalizeTurnUsage(baseline, after), ...(compaction ? { compaction } : {}) }
      },
      cancel: close
    })
  }
}
