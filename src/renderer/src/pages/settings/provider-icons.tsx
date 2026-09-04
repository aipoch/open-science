import { CirclePlus, Sparkles } from 'lucide-react'

// Import the bare icon components so this shared renderer stays free of @lobehub/ui.
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import Codex from '@lobehub/icons/es/Codex/components/Mono'
import NvidiaColor from '@lobehub/icons/es/Nvidia/components/Color'
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono'
import TencentCloudColor from '@lobehub/icons/es/TencentCloud/components/Color'

import { cn } from '@/lib/utils'
import anthropicLogo from '@/assets/provider-icons/anthropic.svg'
import apodexLogo from '@/assets/provider-icons/apodex.svg'
import claudeLogo from '@/assets/provider-icons/claude.svg'
// CodeBuddy is a third-party product mark used only to identify its compatible ACP runtime.
// Keep it separate from Open Science branding and avoid implying affiliation or endorsement.
import codebuddyLogo from '@/assets/provider-icons/codebuddy.svg'
import grokLogo from '@/assets/provider-icons/grok.svg'
import bailianLogo from '@/assets/provider-icons/bailian.svg'
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
import type { AgentFrameworkId } from '../../../../shared/settings'

// The same framework marks are used by Settings cards and completed-message metadata.
export const AgentFrameworkIcon = ({
  frameworkId,
  size = 20,
  className
}: {
  frameworkId: AgentFrameworkId
  size?: number
  className?: string
}): React.JSX.Element => {
  if (frameworkId === 'claude-code') return <ClaudeColor size={size} className={className} />
  if (frameworkId === 'opencode') {
    return <OpenCode size={size} className={cn('text-foreground', className)} />
  }
  if (frameworkId === 'codebuddy') {
    return <img src={codebuddyLogo} alt="" width={size} height={size} className={className} />
  }
  return <Codex size={size} className={cn('text-foreground', className)} />
}

// Official vendor brand marks, bundled as assets. Providers from the same vendor share one mark:
// Bailian and Bailian for Plan, Kimi and Kimi For Coding, Zhipu and GLM Coding Plan, and StepFun and
// Step Plan. Tencent providers use the bundled icon component below. Any vendor without an entry
// falls back to a neutral glyph rather than a made-up logo.
// Custom uses a plus-in-circle.
const VENDOR_LOGO: Partial<Record<OfficialVendorId, string>> = {
  openai: openaiLogo,
  anthropic: anthropicLogo,
  xai: grokLogo,
  apodex: apodexLogo,
  deepseek: deepseekLogo,
  bailian: bailianLogo,
  bailianplan: bailianLogo,
  minimax: minimaxLogo,
  stepfun: stepfunLogo,
  stepplan: stepfunLogo,
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

  if (kindKey === 'xai-subscription') {
    return <img src={grokLogo} alt="" className={cn('size-5 shrink-0', className)} />
  }

  if (
    kindKey === 'claude-subscription' ||
    kindKey === 'claude-shared' ||
    kindKey === 'claude-isolated'
  ) {
    return <img src={claudeLogo} alt="" className={cn('size-5 shrink-0', className)} />
  }

  if (kindKey === 'official:opencode-go' || kindKey === 'official:opencode') {
    return (
      <OpenCode
        size={20}
        className={cn('size-5 shrink-0 text-foreground', className)}
        aria-hidden="true"
      />
    )
  }

  if (kindKey === 'official:nvidia') {
    return <NvidiaColor size={20} className={cn('size-5 shrink-0', className)} aria-hidden="true" />
  }

  if (
    kindKey === 'official:tencent' ||
    kindKey === 'official:tencentcodingplan' ||
    kindKey === 'official:tencenttokenplan'
  ) {
    return (
      <TencentCloudColor
        size={20}
        className={cn('size-5 shrink-0', className)}
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
