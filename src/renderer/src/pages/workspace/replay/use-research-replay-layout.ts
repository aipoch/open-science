import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  normalizeResearchReplayLayoutPreferences,
  getResearchReplayVisiblePaneIds,
  researchReplayLayoutWidthKey,
  type ResearchReplayLayoutPreferences
} from './research-replay-layout'
import type { ResearchReplayLayout } from './ReplayResearchLayout'

/** UI preferences only: never part of a Replay checkpoint or exported research. */
export function useResearchReplayLayout({
  enabled,
  fullscreen,
  paneIds,
  materialId,
  native,
  sourceKey
}: {
  enabled: boolean
  fullscreen: boolean
  paneIds: readonly string[]
  materialId: string
  native: boolean
  sourceKey: string
}): {
  preferences: ResearchReplayLayoutPreferences
  changePreferences: (value: ResearchReplayLayoutPreferences) => void
  layout: ResearchReplayLayout
  rememberMaterial: (id: string) => void
} {
  const key = native ? 'research-replay-layout:v1' : `research-replay-layout:v1:${sourceKey}`
  const storage = useMemo(() => {
    if (!enabled) return undefined
    try {
      return native ? window.localStorage : window.sessionStorage
    } catch {
      return undefined
    }
  }, [enabled, native])
  const [saved, setSaved] = useState(() => {
    let value: unknown
    try {
      value = JSON.parse(storage?.getItem(key) ?? 'null')
    } catch {
      // An unavailable or old preference never prevents reading a study.
    }
    const restored = normalizeResearchReplayLayoutPreferences(value, paneIds)
    return materialId !== 'conversation' && paneIds.includes(materialId)
      ? { ...restored, rightMaterialId: materialId }
      : restored
  })
  const preferences = useMemo(
    () => normalizeResearchReplayLayoutPreferences(saved, paneIds),
    [saved, paneIds]
  )
  const changePreferences = useCallback(
    (value: ResearchReplayLayoutPreferences) =>
      setSaved(normalizeResearchReplayLayoutPreferences(value, paneIds)),
    [paneIds]
  )
  useEffect(() => {
    if (!enabled) return
    try {
      storage?.setItem(key, JSON.stringify(preferences))
    } catch {
      // Viewing is independent of optional preference storage.
    }
  }, [enabled, storage, key, preferences])
  const rememberMaterial = useCallback((id: string) => {
    if (id !== 'conversation')
      setSaved((previous) =>
        previous.rightMaterialId === id ? previous : { ...previous, rightMaterialId: id }
      )
  }, [])
  const mode = fullscreen ? preferences.mode : 'tabs'
  const visiblePaneIds = fullscreen
    ? getResearchReplayVisiblePaneIds(preferences, paneIds)
    : [paneIds.includes(materialId) ? materialId : 'conversation']
  const widthKey = researchReplayLayoutWidthKey(preferences.mode, visiblePaneIds)
  const onWidthsChange = useCallback(
    (widths: Record<string, number>) => {
      if (!fullscreen) return
      setSaved((previous) => ({
        ...previous,
        widthsByLayout: { ...previous.widthsByLayout, [widthKey]: widths }
      }))
    },
    [fullscreen, widthKey]
  )
  return {
    preferences,
    changePreferences,
    rememberMaterial,
    layout: { mode, visiblePaneIds, widths: preferences.widthsByLayout[widthKey], onWidthsChange }
  }
}
