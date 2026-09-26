import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import { FlaskLogo } from '@/components/flask-logo'

const EmptyConversationBanner = ({
  onStartResearch
}: {
  onStartResearch?: (prompt: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div
      data-testid="empty-conversation-banner"
      className="pointer-events-none absolute inset-x-0 top-[42%] flex -translate-y-1/2 flex-col items-center gap-4 px-6 text-center"
    >
      <FlaskLogo className="size-28 text-text-300 opacity-40 md:size-32 dark:opacity-80" />
      <div className="flex flex-col gap-2">
        <h2 className="text-balance text-lg font-normal text-text-000 md:text-xl">
          {t('What will you research in Open-Science?')}
        </h2>
        <p className="text-xs text-text-100">
          {t('Attach data or papers, then describe what you want to find out.')}
        </p>
      </div>
      {onStartResearch ? (
        <div className="pointer-events-auto flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onStartResearch(t('Analyze my data and explain the main findings.'))}
          >
            {t('Analyze data')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onStartResearch(t('Compare these papers and summarize their evidence.'))}
          >
            {t('Compare papers')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export { EmptyConversationBanner }
