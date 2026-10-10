import type { ChildProcess } from 'node:child_process'

// The web service lives in the launched Node backend (#3358). An HTTP shutdown stops the backend
// with exit code 0, and the desktop cannot outlive the backend it owns — quit the way the
// pre-#3358 in-process web service did. Client-initiated quits suppress onDisconnect upstream.
export const handleOwnedBackendDisconnect = (input: {
  child: ChildProcess
  error: Error
  updateCommitted: boolean
  onCleanExit: () => void
  onFailure: (error: Error) => void
  // The transport usually closes moments before the process exit settles. A backend still
  // running past this window lost the connection instead of shutting down — report it.
  exitSettleTimeoutMs?: number
}): void => {
  const { child } = input
  const decide = (): void => {
    if (input.updateCommitted) return
    if (child.exitCode === 0) input.onCleanExit()
    else input.onFailure(input.error)
  }
  if (child.exitCode !== null) {
    decide()
    return
  }
  let settled = false
  const onExit = (): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    decide()
  }
  const timer = setTimeout(onExit, input.exitSettleTimeoutMs ?? 10_000)
  timer.unref?.()
  child.once('exit', onExit)
}
