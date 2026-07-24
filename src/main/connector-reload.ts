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

// Lets unrelated IPC registration proceed while the initial connector sync runs, but keeps ACP
// registration behind a bounded barrier so the first session normally observes a complete skills
// snapshot without allowing a hung custom MCP server to block app startup indefinitely.
export const registerAfterInitialConnectorRefresh = async <T>(
  initialRefresh: Promise<unknown>,
  registerRuntime: () => T,
  timeoutMs = INITIAL_CONNECTOR_REFRESH_TIMEOUT_MS
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const settledRefresh = initialRefresh.then(
    () => undefined,
    () => undefined
  )

  await Promise.race([
    settledRefresh,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
    })
  ])
  if (timeout) clearTimeout(timeout)

  return registerRuntime()
}
