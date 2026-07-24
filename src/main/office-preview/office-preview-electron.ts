type OfficePreviewFrame = {
  url: string
  osProcessId: number
}

type OfficePreviewMainFrame = OfficePreviewFrame & {
  framesInSubtree: OfficePreviewFrame[]
}

type OfficePreviewWebContentsLookup = {
  fromId: (ownerId: number) => { mainFrame: OfficePreviewMainFrame } | undefined
}

type OfficePreviewProcessMetrics = {
  getAppMetrics: () => Array<{
    pid: number
    memory?: { privateBytes?: number; workingSetSize?: number }
  }>
}

// Resolves by the session-specific URL so sibling or stale Office frames cannot claim a capability.
const createOfficePreviewFrameProcessResolver = (contents: OfficePreviewWebContentsLookup) => {
  return (
    parentOwnerId: number,
    runtimeUrl: string
  ): { frameProcessId: number; parentProcessId: number } | undefined => {
    const mainFrame = contents.fromId(parentOwnerId)?.mainFrame
    if (!mainFrame) return undefined

    const runtimeFrame = mainFrame.framesInSubtree.find((frame) => frame.url === runtimeUrl)
    // A frame may disappear before React's close IPC reaches the main process during replacement.
    if (!runtimeFrame) return undefined
    if (runtimeFrame.osProcessId === mainFrame.osProcessId) {
      console.warn('[office-preview] runtime frame did not receive an isolated process', {
        parentOwnerId,
        osProcessId: runtimeFrame.osProcessId
      })
    }
    return {
      frameProcessId: runtimeFrame.osProcessId,
      parentProcessId: mainFrame.osProcessId
    }
  }
}

// Electron reports process memory in kilobytes while the supervisor enforces a byte limit.
const createOfficePreviewProcessMemoryReader = (metrics: OfficePreviewProcessMetrics) => {
  return (processId: number): number => {
    const memory = metrics.getAppMetrics().find((metric) => metric.pid === processId)?.memory
    return (memory?.privateBytes ?? memory?.workingSetSize ?? 0) * 1024
  }
}

export { createOfficePreviewFrameProcessResolver, createOfficePreviewProcessMemoryReader }
export type { OfficePreviewProcessMetrics, OfficePreviewWebContentsLookup }
