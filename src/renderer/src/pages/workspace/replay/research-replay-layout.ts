export type ResearchReplayLayoutPreferences = {
  version: 1
  mode: 'split' | 'columns'
  rightMaterialId: string
  visiblePaneIds: string[]
  widthsByLayout: Record<string, Record<string, number>>
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

const orderedPaneIds = (ids: readonly string[], available: readonly string[]): string[] =>
  available.filter((id) => ids.includes(id))

export const createResearchReplayLayoutPreferences = (
  paneIds: readonly string[],
  rightMaterialId?: string
): ResearchReplayLayoutPreferences => {
  const right =
    (rightMaterialId !== 'conversation' && paneIds.includes(rightMaterialId ?? '')
      ? rightMaterialId
      : undefined) ??
    (paneIds.includes('notebook') ? 'notebook' : paneIds.find((id) => id !== 'conversation')) ??
    paneIds[0] ??
    'notebook'
  return {
    version: 1,
    mode: 'split',
    rightMaterialId: right,
    visiblePaneIds: orderedPaneIds(['conversation', right], paneIds),
    widthsByLayout: {}
  }
}

export const getResearchReplayVisiblePaneIds = (
  preferences: ResearchReplayLayoutPreferences,
  paneIds: readonly string[]
): string[] => {
  const visible = orderedPaneIds(
    preferences.mode === 'split'
      ? ['conversation', preferences.rightMaterialId]
      : preferences.visiblePaneIds,
    paneIds
  )
  return visible.length ? visible : paneIds.slice(0, 1)
}

export const researchReplayLayoutWidthKey = (
  mode: 'split' | 'columns',
  visiblePaneIds: readonly string[]
): string => `${mode}:${visiblePaneIds.join(',')}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Layout preferences contain UI-only identifiers and ratios, never viewer access credentials. */
export const normalizeResearchReplayLayoutPreferences = (
  value: unknown,
  paneIds: readonly string[]
): ResearchReplayLayoutPreferences => {
  const fallback = createResearchReplayLayoutPreferences(paneIds)
  if (!isRecord(value) || value.version !== 1) return fallback
  const right =
    typeof value.rightMaterialId === 'string' &&
    value.rightMaterialId !== 'conversation' &&
    paneIds.includes(value.rightMaterialId)
      ? value.rightMaterialId
      : fallback.rightMaterialId
  const visible = Array.isArray(value.visiblePaneIds)
    ? orderedPaneIds(
        value.visiblePaneIds.filter((id): id is string => typeof id === 'string'),
        paneIds
      )
    : []
  const widthsByLayout: Record<string, Record<string, number>> = {}
  if (isRecord(value.widthsByLayout)) {
    for (const [key, widths] of Object.entries(value.widthsByLayout).slice(0, 32)) {
      const [mode, rawIds, extra] = key.split(':')
      const ids = rawIds?.split(',') ?? []
      if (
        extra !== undefined ||
        (mode !== 'split' && mode !== 'columns') ||
        !ids.length ||
        ids.some((id) => !paneIds.includes(id)) ||
        new Set(ids).size !== ids.length ||
        !isRecord(widths)
      ) {
        continue
      }
      const entries = ids.map((id) => [id, widths[id]] as const)
      if (
        entries.every(
          ([, width]) =>
            typeof width === 'number' && Number.isFinite(width) && width > 0 && width <= 100
        )
      ) {
        widthsByLayout[key] = Object.fromEntries(entries) as Record<string, number>
      }
    }
  }
  return {
    version: 1,
    mode: value.mode === 'columns' ? 'columns' : 'split',
    rightMaterialId: right,
    visiblePaneIds: visible.length ? visible : orderedPaneIds(['conversation', right], paneIds),
    widthsByLayout
  }
}

export const updateResearchReplayPaneVisibility = (
  preferences: ResearchReplayLayoutPreferences,
  id: string,
  visible: boolean,
  paneIds: readonly string[]
): ResearchReplayLayoutPreferences => {
  if (!paneIds.includes(id)) return preferences
  const current = getResearchReplayVisiblePaneIds(preferences, paneIds)
  const next = visible
    ? orderedPaneIds([...current, id], paneIds)
    : current.filter((pane) => pane !== id)
  if (!next.length) return preferences
  return { ...preferences, mode: 'columns', visiblePaneIds: next }
}

export const readResearchReplayLayoutPreferences = (
  storage: LayoutStorage | undefined,
  key: string,
  paneIds: readonly string[]
): ResearchReplayLayoutPreferences => {
  try {
    return normalizeResearchReplayLayoutPreferences(
      JSON.parse(storage?.getItem(key) ?? 'null'),
      paneIds
    )
  } catch {
    return createResearchReplayLayoutPreferences(paneIds)
  }
}

export const writeResearchReplayLayoutPreferences = (
  storage: LayoutStorage | undefined,
  key: string,
  preferences: ResearchReplayLayoutPreferences
): void => {
  try {
    storage?.setItem(key, JSON.stringify(preferences))
  } catch {
    // A restricted or full browser store must not block playback or resizing.
  }
}
