import { useTranslation } from 'react-i18next'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { APP } from '../../../shared/app-config'
import { isLocale } from '../../../shared/locale'
import type { UpdateStatus } from '../../../shared/update'

export const UpdateReleaseNotes = ({ status }: { status: UpdateStatus }): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const releaseUrl = `${APP.links.githubReleases}/tag/v${status.latest ?? ''}`
  const activeLanguage = i18n.resolvedLanguage ?? i18n.language
  const locale = isLocale(activeLanguage) ? activeLanguage : 'en'
  const localizedNotes = locale === 'en' ? undefined : status.localizedNotes?.[locale]
  const releaseNotes = localizedNotes ?? status.notes
  const isEnglishFallback = locale !== 'en' && !localizedNotes && Boolean(status.notes)
  return (
    <>
      {releaseNotes ? (
        <section aria-label={t("What's new")}>
          <h3 className="mb-3 text-sm font-semibold">{t("What's new")}</h3>
          {isEnglishFallback ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {t('Localized release notes are unavailable; showing English.')}
            </p>
          ) : null}
          <div className="text-sm leading-relaxed">
            <AgentMarkdown content={releaseNotes} />
          </div>
          <ExternalTextLink href={releaseUrl} className="mt-4 text-xs">
            {t('View full release notes on GitHub')}
          </ExternalTextLink>
        </section>
      ) : (
        <div className="rounded-lg border border-border bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
          {t("Release notes aren't available in-app for this version.")}{' '}
          <ExternalTextLink href={releaseUrl} className="text-xs">
            {t('View release notes on GitHub')}
          </ExternalTextLink>
        </div>
      )}
    </>
  )
}
