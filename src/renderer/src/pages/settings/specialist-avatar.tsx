import { Brain } from 'lucide-react'
import { AVATAR_ICONS, getAvatarStyle } from './specialist-icons'

// The specialist avatar: a lucide icon on a rounded pastel tile. Rendered both
// in the settings list (size "md") and as a live preview in the editor (size "lg").
export const SpecialistAvatar = ({
  iconKey,
  colorKey,
  size = 'md'
}: {
  iconKey?: string
  colorKey?: string
  size?: 'md' | 'lg'
}): React.JSX.Element => {
  const Icon = iconKey ? (AVATAR_ICONS[iconKey] ?? Brain) : Brain
  const tile = size === 'lg' ? 'size-14' : 'size-7'
  const glyph = size === 'lg' ? 'size-7' : 'size-3.5'
  return (
    <span
      className={`flex ${tile} shrink-0 items-center justify-center rounded-lg text-[13px]`}
      style={getAvatarStyle(colorKey)}
      aria-hidden="true"
    >
      <Icon className={glyph} data-specialist-icon={iconKey ?? 'brain'} />
    </span>
  )
}
