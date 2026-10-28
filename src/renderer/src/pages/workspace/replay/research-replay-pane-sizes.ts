export const RESEARCH_REPLAY_SEPARATOR_WIDTH = 1
const resizeSlackPerSeparator = 80

export const getResearchReplayPaneMinimumWidth = (id: string): number =>
  id === 'conversation' ? 300 : id === 'notebook' ? 360 : 320

/** Single-pane tabs fit their viewport; multiple panes retain room to move each separator. */
export const getResearchReplayMinimumGroupWidth = (visiblePaneIds: readonly string[]): number => {
  const ids = [...new Set(visiblePaneIds)]
  if (ids.length < 2) return 0
  return (
    ids.reduce((sum, id) => sum + getResearchReplayPaneMinimumWidth(id), 0) +
    (ids.length - 1) * (RESEARCH_REPLAY_SEPARATOR_WIDTH + resizeSlackPerSeparator)
  )
}

/** Resolve percentages/weights into pixels. availableWidth excludes separator widths. */
export const resolveResearchReplayPaneWidths = ({
  visiblePaneIds,
  availableWidth,
  mode,
  widths
}: {
  visiblePaneIds: readonly string[]
  availableWidth: number
  mode: 'tabs' | 'split' | 'columns'
  widths?: Readonly<Record<string, number>>
}): Record<string, number> => {
  const ids = [...new Set(visiblePaneIds)]
  const viewportWidth = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0
  if (ids.length === 0) return {}
  if (ids.length === 1) return { [ids[0]]: viewportWidth }

  const rawWeights = ids.map((id) => {
    const stored = widths?.[id]
    if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored
    return mode === 'split' ? (id === 'conversation' ? 35 : 65) : 1
  })
  // Scaling first keeps normalization finite even for large persisted weights.
  const largestWeight = Math.max(...rawWeights)
  const weights = Object.fromEntries(
    ids.map((id, index) => [id, rawWeights[index] / largestWeight])
  )
  const resolved = Object.fromEntries(ids.map((id) => [id, 0]))
  let remainingPixels = Math.max(
    viewportWidth,
    ids.reduce((sum, id) => sum + getResearchReplayPaneMinimumWidth(id), 0)
  )
  let remainingIds = ids

  while (remainingIds.length) {
    const totalWeight = remainingIds.reduce((sum, id) => sum + weights[id], 0)
    const constrained = remainingIds.filter(
      (id) => (remainingPixels * weights[id]) / totalWeight < getResearchReplayPaneMinimumWidth(id)
    )
    if (!constrained.length) {
      for (const id of remainingIds) resolved[id] = (remainingPixels * weights[id]) / totalWeight
      break
    }
    for (const id of constrained) {
      resolved[id] = getResearchReplayPaneMinimumWidth(id)
      remainingPixels -= resolved[id]
    }
    remainingIds = remainingIds.filter((id) => !constrained.includes(id))
  }
  return resolved
}

/** Move one boundary in pixels, retaining other pane widths; return persistable percentages. */
export const resizeResearchReplayPaneWidths = ({
  paneWidths,
  leftPaneId,
  rightPaneId,
  deltaPixels
}: {
  paneWidths: Readonly<Record<string, number>>
  leftPaneId: string
  rightPaneId: string
  deltaPixels: number
}): Record<string, number> => {
  const entries = Object.entries(paneWidths).filter(
    ([, width]) => Number.isFinite(width) && width >= 0
  )
  const next = Object.fromEntries(entries)
  const ids = entries.filter(([, width]) => width > 0).map(([id]) => id)
  const leftIndex = ids.indexOf(leftPaneId)
  if (!Number.isNaN(deltaPixels) && leftIndex >= 0 && ids[leftIndex + 1] === rightPaneId) {
    const lower = getResearchReplayPaneMinimumWidth(leftPaneId) - next[leftPaneId]
    const upper = next[rightPaneId] - getResearchReplayPaneMinimumWidth(rightPaneId)
    if (lower <= upper) {
      const delta = Math.min(upper, Math.max(lower, deltaPixels))
      next[leftPaneId] += delta
      next[rightPaneId] -= delta
    }
  }
  const total = entries.reduce((sum, [, width]) => sum + width, 0)
  return Object.fromEntries(
    Object.entries(next).map(([id, width]) => [id, total ? (width / total) * 100 : 0])
  )
}
