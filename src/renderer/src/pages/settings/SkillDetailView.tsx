import { ScrollText } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { SkillDetailView as SkillDetail } from '../../../../shared/settings'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { useSettingsStore } from '@/stores/settings-store'
import { SettingsToggle } from './SettingsLayout'

type SkillDetailViewProps = {
  skillId: string
}

// Formats an ISO date as a coarse "Updated N days ago" string for the detail header.
const formatUpdated = (iso: string): string => {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const days = Math.max(0, Math.round((Date.now() - then) / 86_400_000))
  if (days === 0) return 'Updated today'
  if (days === 1) return 'Updated 1 day ago'
  return `Updated ${days} days ago`
}

// One label/value row in the Details section.
const DetailRow = ({ label, value }: { label: string; value: string }): React.JSX.Element => (
  <div className="flex flex-col gap-0.5 py-1.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <span className="text-sm text-foreground">{value}</span>
  </div>
)

// Read-only detail view for one bundled skill: header (name + badge + updated + description), the
// rendered SKILL.md under "Files", and frontmatter metadata under "Details". The breadcrumb and back
// control live in the settings header, not here.
const SkillDetailView = ({ skillId }: SkillDetailViewProps): React.JSX.Element => {
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
  const updated = detail ? formatUpdated(detail.updatedAt) : ''

  return (
    <div className="p-5">
      {/* Header: icon + name + Featured badge + toggle, then updated + description below. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ScrollText className="size-6 shrink-0 text-primary" aria-hidden="true" />
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">{name}</h1>
            <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Featured
            </span>
          </div>
        </div>
        <SettingsToggle
          enabled={enabled}
          aria-label={`Toggle ${name}`}
          onToggle={() => void setSkillEnabled(skillId, !enabled)}
        />
      </div>

      {updated ? <p className="mt-1 text-xs text-muted-foreground">{updated}</p> : null}
      {description ? (
        <p className="mt-2 text-sm text-muted-foreground [text-wrap:pretty]">{description}</p>
      ) : null}

      {/* Files: the rendered SKILL.md body. */}
      <section className="mt-6 border-t border-border pt-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Files</h2>
        {detail ? <AgentMarkdown content={detail.body} /> : null}
      </section>

      {/* Details: frontmatter metadata (author, license, third-party notices, ...). */}
      {detail && (detail.author || detail.license || detail.thirdParty) ? (
        <section className="mt-6 border-t border-border pt-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">Details</h2>
          {detail.author ? <DetailRow label="Author" value={detail.author} /> : null}
          {detail.license ? <DetailRow label="License" value={detail.license} /> : null}
          {detail.thirdParty ? (
            <DetailRow
              label="Third-party software, content, terms, and information"
              value={detail.thirdParty}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

export { SkillDetailView }
