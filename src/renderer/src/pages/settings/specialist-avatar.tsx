import { APP_ICONS, DEFAULT_APP_ICON } from '@/components/app-icons/registry'
import { getAvatarStyle } from './specialist-icons'

// The specialist avatar: an app icon glyph on a rounded pastel tile. Rendered both
// in the settings list (size "md") and as a live preview in the editor (size "lg").
// Direct map access (not a resolver call) keeps react-hooks/static-components happy.
export const SpecialistAvatar = ({
  iconKey,
  colorKey,
  size = 'md'
}: {
  iconKey?: string
  colorKey?: string
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element => {
  const Icon = iconKey ? (APP_ICONS[iconKey] ?? DEFAULT_APP_ICON) : DEFAULT_APP_ICON
  const tile = size === 'lg' ? 'size-14' : size === 'sm' ? 'size-5' : 'size-7'
  const glyph = size === 'lg' ? 'size-7' : size === 'sm' ? 'size-3' : 'size-3.5'
  const radius = size === 'sm' ? 'rounded-md' : 'rounded-lg'
  return (
    <span
      className={`flex ${tile} ${radius} shrink-0 items-center justify-center text-[13px]`}
      style={getAvatarStyle(colorKey)}
      data-avatar-size={size}
      aria-hidden="true"
    >
      <Icon className={glyph} data-specialist-icon={iconKey ?? 'brain'} />
    </span>
  )
}
