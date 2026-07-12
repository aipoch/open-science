import { CirclePlus, Laptop, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import claudeLogo from '@/assets/provider-icons/claude.svg'
import deepseekLogo from '@/assets/provider-icons/deepseek.svg'
import minimaxLogo from '@/assets/provider-icons/minimax.svg'
import moonshotLogo from '@/assets/provider-icons/moonshot.svg'
import type { OfficialVendorId } from '../../../../shared/provider-registry'

// Official vendor brand marks, bundled as assets. GLM/Z.AI isn't included yet — drop its official SVG
// in ../../assets/provider-icons and map it below; until then it falls back to a neutral glyph rather
// than a made-up logo. Custom uses a plus-in-circle and local Claude a laptop (generic UI glyphs).
const VENDOR_LOGO: Partial<Record<OfficialVendorId, string>> = {
  anthropic: claudeLogo,
  deepseek: deepseekLogo,
  minimax: minimaxLogo,
  moonshot: moonshotLogo
}

// Renders the icon for a provider-kind key ('custom', 'claude-default', or `official:<vendorId>`).
export const ProviderKindIcon = ({
  kindKey,
  className
}: {
  kindKey: string
  className?: string
}): React.JSX.Element => {
  if (kindKey === 'custom') {
    return (
      <CirclePlus
        className={cn('size-5 shrink-0 text-muted-foreground', className)}
        aria-hidden="true"
      />
    )
  }

  if (kindKey === 'claude-default') {
    return (
      <Laptop
        className={cn('size-5 shrink-0 text-muted-foreground', className)}
        aria-hidden="true"
      />
    )
  }

  const vendorId = kindKey.slice('official:'.length) as OfficialVendorId
  const logo = VENDOR_LOGO[vendorId]

  if (logo) {
    return <img src={logo} alt="" className={cn('size-5 shrink-0', className)} />
  }

  // No official asset bundled for this vendor yet (e.g. GLM/Z.AI): neutral placeholder, not a guess.
  return (
    <Sparkles
      className={cn('size-5 shrink-0 text-muted-foreground', className)}
      aria-hidden="true"
    />
  )
}
