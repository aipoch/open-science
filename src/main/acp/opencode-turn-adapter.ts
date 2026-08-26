import type {
  AcpProviderTurnAdapter,
  AcpProviderTurnBeginInput,
  AcpProviderTurnProbe,
  AcpProviderTurnResult
} from './provider-turn-adapter'
import { diffOpenCodeTurnUsage, type OpenCodeUsageSnapshot } from './opencode-turn-usage'

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
  const cachedReadTokens = diff.lastModelStepUsage.cachedReadTokens
  const contextUsedTokens =
    cachedReadTokens === undefined
      ? undefined
      : diff.lastModelStepUsage.inputTokens + cachedReadTokens
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

    const close = (): void => {
      closed = true
      before = undefined
      reader = undefined
    }

    return Object.freeze({
      finalize: async () => {
        if (closed || !reader) return EMPTY_RESULT
        const baseline = before
        const finalReader = reader
        close()
        const after = await readSnapshotBestEffort(finalReader, providerSessionId, cwd)
        return normalizeTurnUsage(baseline, after)
      },
      cancel: close
    })
  }
}
