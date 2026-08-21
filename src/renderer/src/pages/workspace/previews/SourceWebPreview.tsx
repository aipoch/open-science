import { ExternalLink, Link2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  SOURCE_PREVIEW_FRAME_NAME,
  parseHttpsSourceUrl
} from '../../../../../shared/source-preview'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewSourceItem } from '@/stores/preview-workbench-store'

const SourceWebPreview = ({ item }: { item: PreviewSourceItem }): React.JSX.Element => {
  const { t } = useTranslation()
  const sourceUrl = parseHttpsSourceUrl(item.url)

  if (!sourceUrl) {
    return (
      <div className="flex size-full items-center justify-center px-6 text-center text-sm text-text-300">
        {t('Only HTTPS sources can be previewed')}
      </div>
    )
  }

  return (
    <div className="flex size-full min-h-0 flex-col bg-bg-000">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border-300/50 px-3">
        <Link2 className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text-100">{item.title}</div>
          <div className="truncate text-[10px] text-text-400" title={sourceUrl.href}>
            {t('Cited URL: {{hostname}}', { hostname: sourceUrl.hostname })}
          </div>
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Open source in browser')}
                onClick={() => window.open(sourceUrl.href, '_blank', 'noreferrer')}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Open source in browser')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </header>
      <iframe
        data-source-preview-frame=""
        name={SOURCE_PREVIEW_FRAME_NAME}
        title={t('Source preview: {{title}}', { title: item.title })}
        src={sourceUrl.href}
        sandbox="allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  )
}

export { SourceWebPreview }
