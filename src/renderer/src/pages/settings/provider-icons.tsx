import { CirclePlus, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import claudeLogo from '@/assets/provider-icons/claude.svg'
import deepseekLogo from '@/assets/provider-icons/deepseek.svg'
import minimaxLogo from '@/assets/provider-icons/minimax.svg'
import stepfunLogo from '@/assets/provider-icons/stepfun.svg'
import openaiLogo from '@/assets/provider-icons/openai.svg'
import zhipuLogo from '@/assets/provider-icons/zhipu.svg'
import kimiLogo from '@/assets/provider-icons/kimi.svg'
import openrouterLogo from '@/assets/provider-icons/openrouter.svg'
import xiaomimimoLogo from '@/assets/provider-icons/xiaomimimo.svg'
import sensenovaLogo from '@/assets/provider-icons/sensenova.svg'
import volcengineLogo from '@/assets/provider-icons/volcengine.svg'
import type { OfficialVendorId } from '../../../../shared/provider-registry'

// Official vendor brand marks, bundled as assets. Both Kimi providers (the general Moonshot platform
// and Kimi For Coding) share the one Kimi mark, and both GLM providers (pay-as-you-go Zhipu and the
// GLM Coding Plan) share the one GLM mark. Any vendor without an entry falls back to a neutral glyph
// rather than a made-up logo. Custom uses a plus-in-circle.
const VENDOR_LOGO: Partial<Record<OfficialVendorId, string>> = {
  openai: openaiLogo,
  anthropic: claudeLogo,
  deepseek: deepseekLogo,
  minimax: minimaxLogo,
  stepfun: stepfunLogo,
  zhipu: zhipuLogo,
  glmcodingplan: zhipuLogo,
  kimi: kimiLogo,
  kimiforcode: kimiLogo,
  openrouter: openrouterLogo,
  xiaomimimo: xiaomimimoLogo,
  sensenova: sensenovaLogo,
  volcengine: volcengineLogo
}

// Renders the icon for a provider-kind key ('custom' or `official:<vendorId>`).
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

  if (
    kindKey === 'codex-subscription' ||
    kindKey === 'codex-shared' ||
    kindKey === 'codex-isolated'
  ) {
    return <img src={openaiLogo} alt="" className={cn('size-5 shrink-0', className)} />
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
