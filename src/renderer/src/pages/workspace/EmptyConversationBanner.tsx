import { useTranslation } from 'react-i18next'

import { FlaskLogo } from '@/components/flask-logo'

// Centered placeholder for a brand-new conversation with no messages yet. Mounted as an absolute
// overlay inside MessageScroller (not MessageScrollerContent — the scroller only measures Content's
// direct children), so it never participates in scroll anchoring. Purely decorative: the dotted
// flask mark inherits a low-key text token via currentColor, which keeps one SVG legible in both
// light and dark themes.
const EmptyConversationBanner = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div
      data-testid="empty-conversation-banner"
      className="pointer-events-none absolute inset-x-0 top-[42%] flex -translate-y-1/2 flex-col items-center gap-4 px-6 text-center"
    >
      <FlaskLogo className="size-28 text-text-300 opacity-40 md:size-32 dark:opacity-80" />
      <div className="flex flex-col gap-2">
        <h2 className="text-balance text-lg font-normal text-text-000 md:text-xl">
          {t('What will you research in Open Science?')}
        </h2>
        <p className="text-xs text-text-100">
          {t('Discover, share, and collaborate on research that matters')}
        </p>
      </div>
    </div>
  )
}

export { EmptyConversationBanner }
