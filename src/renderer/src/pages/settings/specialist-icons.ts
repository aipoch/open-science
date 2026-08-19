import type { CSSProperties } from 'react'
import { APP_ICONS } from '@/components/app-icons/registry'

// The color palette used for specialist avatar backgrounds. Shared between the
// list and the editor so the preview matches the rendered row exactly.
export const AVATAR_COLORS: Record<string, string> = {
  teal: '#e0f2f1',
  purple: '#ede9fe',
  amber: '#fef3c7',
  green: '#dcfce7',
  blue: '#dbeafe',
  slate: '#f1f5f9'
}
export const DEFAULT_AVATAR_COLOR = '#ececea'

export const getAvatarColor = (colorKey?: string): string =>
  colorKey ? (AVATAR_COLORS[colorKey] ?? DEFAULT_AVATAR_COLOR) : DEFAULT_AVATAR_COLOR

// Avatar glyphs come from the shared app icon registry; the alias keeps existing
// consumers on a stable name.
export const AVATAR_ICONS = APP_ICONS

// Colors remain shared by the compact picker and the full editor.
export const SPECIALIST_COLOR_OPTIONS = [
  { key: 'blue', label: 'Blue' },
  { key: 'green', label: 'Green' },
  { key: 'teal', label: 'Teal' },
  { key: 'amber', label: 'Amber' },
  { key: 'purple', label: 'Purple' },
  { key: 'slate', label: 'Slate' }
] as const

export const getAvatarStyle = (colorKey?: string): CSSProperties => ({
  background: getAvatarColor(colorKey)
})
