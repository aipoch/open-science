import type { AcpRuntimeEvent } from '../../../../shared/acp'
import { getAcpRuntimeEventText, isBufferableAssistantTextEvent } from './chat-events'

type WorkspacePresentationScheduler = (callback: () => void, delayMs: number) => () => void

type WorkspaceRuntimePresentation = {
  now: () => number
  schedule: WorkspacePresentationScheduler
  shouldAnimate: () => boolean
}

type WorkspacePresentationLane = {
  force: boolean
  nextAt: number
  toolCatchUpFramesRemaining?: number
  wait?: {
    cancel: () => void
    finish: () => void
  }
}

const PRESENTATION_INTERVAL_MS = 33
const PRESENTATION_BASE_GRAPHEMES = 8
const PRESENTATION_LAG_FRAMES = 7
const TOOL_CATCH_UP_FRAMES = 4
const MAX_BUFFERED_GRAPHEMES = 32_768
const graphemeSegmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

const countEventGraphemes = (event: AcpRuntimeEvent): number => {
  const text = getAcpRuntimeEventText(event) ?? ''
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text)).length
    : Array.from(text).length
}

const isImmediatePresentationBoundary = (event: AcpRuntimeEvent): boolean =>
  !isBufferableAssistantTextEvent(event) && event.kind !== 'tool'

const defaultPresentationSchedule: WorkspacePresentationScheduler = (callback, delayMs) => {
  let frameId: number | undefined
  let timerId: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const cleanup = (): void => {
    if (timerId !== undefined) clearTimeout(timerId)
    if (frameId !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameId)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    cleanup()
    callback()
  }
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') finish()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  if (typeof requestAnimationFrame === 'function') {
    const deadline = performance.now() + delayMs
    const tick = (timestamp: number): void => {
      if (timestamp >= deadline) finish()
      else frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
  } else {
    timerId = setTimeout(finish, delayMs)
  }

  return () => {
    finished = true
    cleanup()
  }
}

const shouldAnimateWorkspacePresentation = (): boolean => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  return !(
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const liveWorkspaceRuntimePresentation: WorkspaceRuntimePresentation = {
  now: Date.now,
  schedule: defaultPresentationSchedule,
  shouldAnimate: shouldAnimateWorkspacePresentation
}

const createWorkspaceRuntimePresentationBuffer = (
  presentation?: WorkspaceRuntimePresentation
): {
  createLane: () => WorkspacePresentationLane
  forceOnAccepted: (lane: WorkspacePresentationLane, event: AcpRuntimeEvent) => void
  force: (lane: WorkspacePresentationLane) => void
  prepare: (lane: WorkspacePresentationLane, pending: AcpRuntimeEvent[]) => Promise<void>
  select: (lane: WorkspacePresentationLane, pending: AcpRuntimeEvent[]) => AcpRuntimeEvent[]
  recordProgress: (
    lane: WorkspacePresentationLane,
    selected: AcpRuntimeEvent[],
    hasPending: boolean
  ) => void
} => {
  const wake = (lane: WorkspacePresentationLane): void => {
    const wait = lane.wait
    if (!wait) return
    wait.cancel()
    wait.finish()
  }

  const force = (lane: WorkspacePresentationLane): void => {
    lane.force = true
    wake(lane)
  }

  const prepare = async (
    lane: WorkspacePresentationLane,
    pending: AcpRuntimeEvent[]
  ): Promise<void> => {
    const first = pending[0]
    const boundary = pending.find((event) => !isBufferableAssistantTextEvent(event))
    if (
      !presentation ||
      lane.force ||
      !presentation.shouldAnimate() ||
      !first ||
      !isBufferableAssistantTextEvent(first) ||
      (boundary && isImmediatePresentationBoundary(boundary))
    ) {
      return
    }

    const delayMs = Math.max(0, lane.nextAt - presentation.now())
    if (delayMs === 0) return
    await new Promise<void>((resolve) => {
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        lane.wait = undefined
        resolve()
      }
      lane.wait = { cancel: presentation.schedule(finish, delayMs), finish }
    })
  }

  const consecutiveNonTextPrefix = (pending: AcpRuntimeEvent[]): AcpRuntimeEvent[] => {
    const end = pending.findIndex((event) => isBufferableAssistantTextEvent(event))
    return pending.slice(0, end === -1 ? pending.length : end)
  }

  const select = (
    lane: WorkspacePresentationLane,
    pending: AcpRuntimeEvent[]
  ): AcpRuntimeEvent[] => {
    if (!presentation) return pending
    const first = pending[0]
    if (!first) return []
    // Thought, tool, stop, and other non-text events are not grapheme-paced. Selecting only the
    // first one made a live burst drain one event per iteration and recopy the remaining lane
    // each time. Consecutive non-text events stay ordered and still apply sequentially.
    if (!isBufferableAssistantTextEvent(first)) return consecutiveNonTextPrefix(pending)

    const textRun = pending.slice(
      0,
      pending.findIndex((event) => !isBufferableAssistantTextEvent(event)) === -1
        ? pending.length
        : pending.findIndex((event) => !isBufferableAssistantTextEvent(event))
    )
    const boundary = pending[textRun.length]
    const totalGraphemes = textRun.reduce((total, event) => total + countEventGraphemes(event), 0)
    if (
      lane.force ||
      !presentation.shouldAnimate() ||
      (boundary && isImmediatePresentationBoundary(boundary)) ||
      totalGraphemes > MAX_BUFFERED_GRAPHEMES
    ) {
      lane.toolCatchUpFramesRemaining = undefined
      return textRun
    }

    const remaining =
      boundary?.kind === 'tool'
        ? (lane.toolCatchUpFramesRemaining ?? TOOL_CATCH_UP_FRAMES)
        : PRESENTATION_LAG_FRAMES
    const targetGraphemes = Math.max(
      boundary?.kind === 'tool' ? 1 : PRESENTATION_BASE_GRAPHEMES,
      Math.ceil(totalGraphemes / remaining)
    )
    lane.toolCatchUpFramesRemaining =
      boundary?.kind === 'tool' ? Math.max(1, remaining - 1) : undefined

    const selected: AcpRuntimeEvent[] = []
    let selectedGraphemes = 0
    for (const event of textRun) {
      selected.push(event)
      selectedGraphemes += countEventGraphemes(event)
      if (selectedGraphemes >= targetGraphemes) break
    }
    if (selected.length === textRun.length) lane.toolCatchUpFramesRemaining = undefined
    return selected
  }

  return {
    createLane: () => ({ force: false, nextAt: 0 }),
    forceOnAccepted: (lane, event) => {
      if (isImmediatePresentationBoundary(event)) force(lane)
    },
    force,
    prepare,
    select,
    recordProgress: (lane, selected, hasPending) => {
      if (selected.some(isBufferableAssistantTextEvent) && presentation?.shouldAnimate()) {
        lane.nextAt = presentation.now() + PRESENTATION_INTERVAL_MS
      }
      if (!hasPending) lane.force = false
    }
  }
}

export { createWorkspaceRuntimePresentationBuffer, liveWorkspaceRuntimePresentation }
export type { WorkspacePresentationLane, WorkspaceRuntimePresentation }
