import { createContext, useContext, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

const REPLAY_SYSTEM_FONT = 'Arial, sans-serif'
const REPLAY_SYSTEM_MONO_FONT = 'Consolas, "Liberation Mono", monospace'

// Versioned, serializable input to interactive and future offline frame rendering.
export type ReplayPresentationConfig = {
  version: 1
  width: 1280
  height: 720
  locale: string
  timeZone: 'UTC'
  theme: 'light'
  fontFamily: typeof REPLAY_SYSTEM_FONT
  monoFontFamily: typeof REPLAY_SYSTEM_MONO_FONT
  reducedMotion: boolean
}
export const createReplayPresentation = (
  locale = 'en',
  reducedMotion = false
): ReplayPresentationConfig => ({
  version: 1,
  width: 1280,
  height: 720,
  locale,
  timeZone: 'UTC',
  theme: 'light',
  fontFamily: REPLAY_SYSTEM_FONT,
  monoFontFamily: REPLAY_SYSTEM_MONO_FONT,
  reducedMotion
})
export const ReplayPresentationContext = createContext(createReplayPresentation())
export const useReplayTranslation = (): ReturnType<typeof useTranslation> => {
  const config = useContext(ReplayPresentationContext)
  return useTranslation(undefined, { lng: config.locale })
}
export const replayPresentationStyle = (config: ReplayPresentationConfig): CSSProperties =>
  ({
    width: config.width,
    height: config.height,
    // First-generation frames permit system fonts only. Ignore unsupported runtime input too:
    // a late web font must never alter a frame that already passed its readiness deadline.
    fontFamily: REPLAY_SYSTEM_FONT,
    fontSize: 15,
    colorScheme: config.theme,
    '--font-mono': REPLAY_SYSTEM_MONO_FONT,
    '--bg-000': 'hsl(0 0% 100%)',
    '--bg-10': 'hsl(60 14% 99%)',
    '--bg-200': 'hsl(60 11% 95%)',
    '--bg-300': 'hsl(45 12% 93%)',
    '--bg-400': 'hsl(45 10% 88%)',
    '--border-ink-channel': '60 2% 12%',
    '--text-000': 'hsl(0 0% 7%)',
    '--text-100': 'hsl(60 2% 20%)',
    '--text-200': 'hsl(43 3% 42%)',
    '--text-300': 'hsl(43 3% 47%)'
  }) as CSSProperties
