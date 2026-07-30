import type { CSSProperties } from 'react'
import {
  Brain,
  Beaker,
  BookOpen,
  FlaskConical,
  Microscope,
  Search,
  type LucideIcon
} from 'lucide-react'

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

export const AVATAR_ICONS: Record<string, LucideIcon> = {
  brain: Brain,
  beaker: Beaker,
  'book-open': BookOpen,
  'flask-conical': FlaskConical,
  microscope: Microscope,
  search: Search
}

export const getAvatarStyle = (colorKey?: string): CSSProperties => ({
  background: colorKey ? (AVATAR_COLORS[colorKey] ?? DEFAULT_AVATAR_COLOR) : DEFAULT_AVATAR_COLOR
})
