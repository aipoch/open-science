// The connector-change → skills-reload wiring, extracted from ipc.ts so it can be unit-tested against
// the REAL implementation (ipc.ts imports electron and constructs the whole service graph, so it can't
// load in a unit test). The skills reload MUST run on BOTH settle paths — a non-Claude framework
// (Codex, opencode) materializes connector docs into its own home at spawn, so it has to pick up a
// connector change even if the doc re-sync itself fails. Hence `.finally`, never `.then`.
export const wireConnectorReload = (
  refreshConnectorSkillDocs: () => Promise<unknown>,
  requestSkillsReload: () => void
): Promise<unknown> =>
  refreshConnectorSkillDocs().finally(() => {
    requestSkillsReload()
  })

const INITIAL_CONNECTOR_REFRESH_TIMEOUT_MS = 5_000

type InitialConnectorRefreshOptions = {
  timeoutMs?: number
  onLateSettled?: () => void | Promise<void>
}

// Produces a bounded barrier for the first ACP connection/session without putting app startup behind
// custom MCP discovery. If the source refresh settles after the barrier times out, notify the caller
// so an agent that already started against the old connector docs can be reloaded.
export const waitForInitialConnectorRefresh = async (
  initialRefresh: Promise<unknown>,
  {
    timeoutMs = INITIAL_CONNECTOR_REFRESH_TIMEOUT_MS,
    onLateSettled
  }: InitialConnectorRefreshOptions = {}
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const settledRefresh = initialRefresh.then(
    () => undefined,
    () => undefined
  )

  const outcome = await Promise.race([
    settledRefresh.then(() => 'settled' as const),
    new Promise<'timed-out'>((resolve) => {
      timeout = setTimeout(() => resolve('timed-out'), timeoutMs)
    })
  ])
  if (timeout) clearTimeout(timeout)

  if (outcome === 'timed-out' && onLateSettled) {
    void settledRefresh.then(onLateSettled).catch(() => undefined)
  }
}
