// The Connector Settings workflow uses this settle rule after starting its derived projection refresh.
// The Skills reload MUST run on BOTH settle paths: every framework captures Connector docs in a
// private runtime generation, so a later turn must rebuild that generation even if source re-sync
// fails. Hence `.finally`, never `.then`.
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
