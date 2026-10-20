import type { ChildProcess } from 'node:child_process'

// The web service lives in the launched Node backend. Follow its clean shutdown through the
// ordinary desktop quit flow, retaining renderer persistence protection. Client-initiated quits
// suppress onDisconnect upstream.
export const handleOwnedBackendDisconnect = (input: {
  child: ChildProcess
  runtimePid: number | undefined
  error: Error
  isUpdateCommitted: () => boolean
  onCleanExit: () => void
  onFailure: (error: Error) => void
  exitSettleTimeoutMs?: number
}): void => {
  const { child } = input
  if (input.isUpdateCommitted()) return
  let failureReported = false
  const reportFailure = (): void => {
    if (failureReported || input.isUpdateCommitted()) return
    failureReported = true
    input.onFailure(input.error)
  }
  // A spawned child may have lost the startup race to the authenticated runtime.
  if (child.pid === undefined || child.pid !== input.runtimePid) {
    reportFailure()
    return
  }
  const decide = (): void => {
    if (input.isUpdateCommitted()) return
    if (child.exitCode === 0 && child.signalCode === null) input.onCleanExit()
    else reportFailure()
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    decide()
    return
  }
  const onExit = (): void => {
    clearTimeout(timer)
    decide()
  }
  // Surface a lost connection promptly, but keep observing the child: WebSocket close handshakes
  // and remaining backend teardown may legitimately outlast this diagnostic window.
  const timer = setTimeout(reportFailure, input.exitSettleTimeoutMs ?? 10_000)
  timer.unref()
  child.once('exit', onExit)
}
