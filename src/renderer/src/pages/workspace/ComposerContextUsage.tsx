// Composer context-usage indicator: a compact "% of context window" pill with a hover breakdown,
// mirroring Claude Code's /context. The numerator (tokens in context) comes from the ACP usage_update
// the runtime records per session; the denominator is already bound to the same agent-context generation
// by the main process. Renders nothing until the active framework emits its first usage_update rather
// than showing a fabricated zero.

import { Gauge } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AcpContextUsage } from '../../../../shared/acp'

type ComposerContextUsageProps = {
  // Latest usage for the active session, or undefined when the framework never reported any.
  contextUsage: AcpContextUsage | undefined
}

// Compact token count: 1_000_000 -> "1M", 24_890 -> "25k", 512 -> "512".
const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

const ComposerContextUsage = ({
  contextUsage
}: ComposerContextUsageProps): React.JSX.Element | null => {
  if (!contextUsage || typeof contextUsage.used !== 'number') return null

  const size = contextUsage.size
  const used = contextUsage.used
  const percent = size && size > 0 ? Math.min(100, Math.round((used / size) * 100)) : undefined

  const label = percent !== undefined ? `${percent}%` : formatTokens(used)

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-000 transition-colors duration-200 ease-out hover:bg-bg-200"
            aria-label={`Context used: ${label}`}
          >
            <Gauge className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            <span className="tabular-nums @max-[28rem]/composer:hidden">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64">
          <div className="space-y-0.5 text-[12px]">
            <div className="font-medium">Context window</div>
            <div>
              {formatTokens(used)} / {formatTokens(size)} tokens
              {percent !== undefined ? ` (${percent}%)` : ''}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { ComposerContextUsage }
