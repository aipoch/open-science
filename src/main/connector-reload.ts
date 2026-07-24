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

// Lets unrelated IPC registration proceed while the initial connector sync runs, but keeps ACP
// registration behind that barrier so the first session cannot observe a partial skills snapshot.
export const registerAfterInitialConnectorRefresh = async <T>(
  initialRefresh: Promise<unknown>,
  registerRuntime: () => T
): Promise<T> => {
  await initialRefresh
  return registerRuntime()
}
