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
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t("What's new")}</p>
          {isEnglishFallback ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {t('Localized release notes are unavailable; showing English.')}
            </p>
          ) : null}
          <div className="rounded-lg bg-muted px-3 py-2">
            <AgentMarkdown content={releaseNotes} />
          </div>
          <ExternalTextLink href={releaseUrl} className="mt-2 text-xs">
            {t('View full release notes on GitHub')}
          </ExternalTextLink>
        </div>
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
