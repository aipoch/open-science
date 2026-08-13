import { ScrollText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SkillDetailView as SkillDetail } from '../../../../shared/settings'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsToggle } from './SettingsLayout'

type SkillDetailViewProps = {
  skillId: string
}

// Elapsed whole days since an ISO date, or null when it can't be parsed. Stays pure and locale-free
// like relativeTimeParts: the caller picks the wording through the catalog, because "Updated today"
// vs "{{count}} 天前更新" differ in word order, not just in a suffix.
const daysSince = (iso: string): number | null => {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000))
}

// One label/value row in the Details section.
const DetailRow = ({ label, value }: { label: string; value: string }): React.JSX.Element => (
  <div className="flex flex-col gap-0.5 py-1.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <span className="text-sm text-foreground">{value}</span>
  </div>
)

const metadataLabel = (key: string): string =>
  key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const DEDICATED_METADATA_KEYS = new Set([
  'author',
  'license',
  'third-party',
  'third_party',
  'thirdparty'
])

// Read-only detail view for one bundled skill: header (name + badge + updated + description), the
// rendered SKILL.md under "Files", and frontmatter metadata under "Details". The breadcrumb and back
// control live in the settings header, not here.
const SkillDetailView = ({ skillId }: SkillDetailViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const skill = useSettingsStore((state) => state.skills.find((item) => item.id === skillId))
  const setSkillEnabled = useSettingsStore((state) => state.setSkillEnabled)
  const [detail, setDetail] = useState<SkillDetail | null>(null)

  useEffect(() => {
    let active = true
    void window.api.settings.getSkillDetail(skillId).then((result) => {
      if (active) setDetail(result)
    })
    return () => {
      active = false
    }
  }, [skillId])

  const enabled = skill?.enabled ?? detail?.enabled ?? false
  const name = skill?.name ?? detail?.name ?? ''
  const description = detail?.description ?? skill?.description ?? ''
  const elapsedDays = detail ? daysSince(detail.updatedAt) : null
  const updated =
    elapsedDays === null
      ? ''
      : elapsedDays === 0
        ? t('Updated today')
        : t('Updated {{count}} days ago', {
            defaultValue_one: 'Updated {{count}} day ago',
            count: elapsedDays
          })
  // Badge reflects the skill's actual source; imported and personal skills are not "Featured".
  const source = skill?.source ?? detail?.source
  const sourceLabel =
    source === 'imported' ? t('Imported') : source === 'personal' ? t('Personal') : t('Featured')
  const genericMetadata = Object.entries(detail?.metadata ?? {}).filter(
    ([key]) => !DEDICATED_METADATA_KEYS.has(key.toLowerCase())
  )

  return (
    <div className="p-5">
      {/* Header: icon + name + Featured badge + toggle, then updated + description below. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ScrollText className="size-6 shrink-0 text-primary" aria-hidden="true" />
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">{name}</h1>
            <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {sourceLabel}
            </span>
          </div>
        </div>
        <SettingsToggle
          enabled={enabled}
          aria-label={t('Toggle {{name}}', { name })}
          onToggle={() => void setSkillEnabled(skillId, !enabled)}
        />
      </div>

      {updated ? <p className="mt-1 text-xs text-muted-foreground">{updated}</p> : null}
      {description ? (
        <p className="mt-2 text-sm text-muted-foreground [text-wrap:pretty]">{description}</p>
      ) : null}

      {/* Files: the rendered SKILL.md body. */}
      <section className="mt-6 border-t border-border pt-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">{t('Files')}</h2>
        {detail ? <AgentMarkdown content={detail.body} /> : null}
      </section>

      {/* Details: frontmatter metadata (author, license, third-party notices, ...). */}
      {detail &&
      (detail.author || detail.license || detail.thirdParty || genericMetadata.length > 0) ? (
        <section className="mt-6 border-t border-border pt-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">{t('Details')}</h2>
          {detail.author ? <DetailRow label={t('Author')} value={detail.author} /> : null}
          {detail.license ? <DetailRow label={t('License')} value={detail.license} /> : null}
          {detail.thirdParty ? (
            <DetailRow
              label={t('Third-party software, content, terms, and information')}
              value={detail.thirdParty}
            />
          ) : null}
          {genericMetadata.map(([key, value]) => (
            <DetailRow key={key} label={metadataLabel(key)} value={value} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

export { SkillDetailView }
