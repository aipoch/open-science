import type {
  AcpProviderTurnAdapter,
  AcpProviderTurnBeginInput,
  AcpProviderTurnProbe,
  AcpProviderTurnResult
} from './provider-turn-adapter'
import { sanitizeSessionTitle } from '../../shared/session-persistence'
import { diffOpenCodeTurnUsage, type OpenCodeUsageSnapshot } from './opencode-turn-usage'

export type OpenCodeUsageSnapshotReader = (
  providerSessionId: string,
  cwd: string
) => Promise<OpenCodeUsageSnapshot | undefined>

export type OpenCodeSessionTitleReader = (
  providerSessionId: string,
  cwd: string,
  signal?: AbortSignal
) => Promise<string | undefined>

type AcpOpenCodeTurnAdapterOptions = Readonly<{
  titlePollDeadlineMs?: number
  titlePollIntervalMs?: number
}>

const DEFAULT_TITLE_POLL_DEADLINE_MS = 2_000
const DEFAULT_TITLE_POLL_INTERVAL_MS = 100

const EMPTY_RESULT: AcpProviderTurnResult = Object.freeze({})

const readSnapshotBestEffort = async <Snapshot>(
  reader: (
    providerSessionId: string,
    cwd: string,
    signal?: AbortSignal
  ) => Promise<Snapshot | undefined>,
  providerSessionId: string,
  cwd: string,
  signal?: AbortSignal
): Promise<Snapshot | undefined> => {
  try {
    return await (signal ? reader(providerSessionId, cwd, signal) : reader(providerSessionId, cwd))
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
    ...(Number.isSafeInteger(contextUsedTokens) ? { contextUsedTokens } : {}),
    lastModelStepUsage: Object.freeze(diff.lastModelStepUsage)
  })
}

const changedSessionTitle = (
  before: string | undefined,
  after: string | undefined
): string | undefined => {
  const baseline = sanitizeSessionTitle(before)
  const title = sanitizeSessionTitle(after)
  return baseline && title && baseline !== title ? title : undefined
}

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

const readChangedSessionTitleBestEffort = async (
  reader: OpenCodeSessionTitleReader | undefined,
  baseline: string | undefined,
  providerSessionId: string,
  cwd: string,
  options: AcpOpenCodeTurnAdapterOptions
): Promise<string | undefined> => {
  const sanitizedBaseline = sanitizeSessionTitle(baseline)
  if (!reader || !sanitizedBaseline) return undefined
  const deadlineMs = options.titlePollDeadlineMs ?? DEFAULT_TITLE_POLL_DEADLINE_MS
  const intervalMs = options.titlePollIntervalMs ?? DEFAULT_TITLE_POLL_INTERVAL_MS
  const controller = new AbortController()
  const timer = deadlineMs > 0 ? setTimeout(() => controller.abort(), deadlineMs) : undefined
  try {
    for (;;) {
      const after = await readSnapshotBestEffort(reader, providerSessionId, cwd, controller.signal)
      if (!sanitizeSessionTitle(after)) {
        return undefined
      }
      const title = changedSessionTitle(baseline, after)
      if (title) return title
      if (deadlineMs <= 0 || controller.signal.aborted) {
        return undefined
      }
      await wait(intervalMs)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Adapts an authenticated, credential-opaque snapshot reader into normalized provider-turn facts.
 * Each probe retains only its before snapshot and releases that attempt state on either close path.
 */
export class AcpOpenCodeTurnAdapter implements AcpProviderTurnAdapter {
  constructor(
    private readonly readUsageSnapshot: OpenCodeUsageSnapshotReader,
    private readonly readSessionTitle?: OpenCodeSessionTitleReader,
    private readonly options: AcpOpenCodeTurnAdapterOptions = {}
  ) {}

  async begin(input: AcpProviderTurnBeginInput): Promise<AcpProviderTurnProbe> {
    const { providerSessionId, cwd } = input
    let usageReader: OpenCodeUsageSnapshotReader | undefined = this.readUsageSnapshot
    let titleReader: OpenCodeSessionTitleReader | undefined = this.readSessionTitle
    const initialSnapshots = await Promise.all([
      readSnapshotBestEffort(usageReader, providerSessionId, cwd),
      titleReader
        ? readSnapshotBestEffort(titleReader, providerSessionId, cwd)
        : Promise.resolve(undefined)
    ])
    let [beforeUsage, beforeTitle] = initialSnapshots
    let closed = false

    const close = (): void => {
      closed = true
      beforeUsage = undefined
      beforeTitle = undefined
      usageReader = undefined
      titleReader = undefined
    }

    return Object.freeze({
      finalize: async () => {
        if (closed || !usageReader) return EMPTY_RESULT
        const usageBaseline = beforeUsage
        const titleBaseline = beforeTitle
        const finalUsageReader = usageReader
        const finalTitleReader = titleReader
        close()
        const [finalUsage, frameworkSessionTitle] = await Promise.all([
          readSnapshotBestEffort(finalUsageReader, providerSessionId, cwd),
          readChangedSessionTitleBestEffort(
            finalTitleReader,
            titleBaseline,
            providerSessionId,
            cwd,
            this.options
          )
        ])
        const usage = normalizeTurnUsage(usageBaseline, finalUsage)
        return frameworkSessionTitle ? Object.freeze({ ...usage, frameworkSessionTitle }) : usage
      },
      cancel: close
    })
  }
}
