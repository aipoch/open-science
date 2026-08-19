import {
  BookOpen,
  Bookmark,
  Bot,
  Code2,
  Database,
  FlaskConical,
  Star,
  Tag as TagIcon
} from 'lucide-react'
import type { TFunction } from 'i18next'

import type { TagColorKey, TagIconKey, TagView } from '../../../../shared/tags'

const TAG_ICONS = {
  tag: TagIcon,
  star: Star,
  bookmark: Bookmark,
  'flask-conical': FlaskConical,
  'book-open': BookOpen,
  database: Database,
  'code-2': Code2,
  bot: Bot
} satisfies Record<TagIconKey, React.ComponentType<{ className?: string }>>

const TAG_COLORS: Record<TagColorKey, string> = {
  gray: 'border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300',
  red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  orange: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  green: 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300',
  blue: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  purple: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300',
  pink: 'border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300'
}

const tagPresentation = (
  tag: TagView,
  t: TFunction
): { name: string; iconKey: TagIconKey; colorKey: TagColorKey } =>
  'systemKey' in tag
    ? { name: t('Favorites'), iconKey: 'star', colorKey: 'amber' }
    : { name: tag.name, iconKey: tag.iconKey, colorKey: tag.colorKey }

export { TAG_COLORS, TAG_ICONS, tagPresentation }
