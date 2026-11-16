import { FileDiff, History } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format-datetime'
import { resolveLocaleFromTags } from '../../../../../shared/locale'
import type {
  ManagedFileVersionDescriptor,
  ManagedFileVersionInspectResult
} from '../../../../../shared/managed-file-versions'
import { authorLabel, versionSummaryLabel } from './pptx-version-labels'

type PptxVersionHistoryProps = {
  inspect: ManagedFileVersionInspectResult
  comparing: boolean
  onSelect: (versionId: string) => void
  onCompare: (base: ManagedFileVersionDescriptor, target: ManagedFileVersionDescriptor) => void
}

// The version that came before the selected one, from the loaded page or the inspect neighbours.
const previousOf = (
  inspect: ManagedFileVersionInspectResult
): ManagedFileVersionDescriptor | undefined => {
  const index = inspect.versions.findIndex((version) => version.id === inspect.selectedVersionId)
  return (index > 0 ? inspect.versions[index - 1] : undefined) ?? inspect.previousVersion
}

const selectedOf = (
  inspect: ManagedFileVersionInspectResult
): ManagedFileVersionDescriptor | undefined =>
  inspect.selectedVersion ??
  inspect.versions.find((version) => version.id === inspect.selectedVersionId)

const PptxVersionHistory = ({
  inspect,
  comparing,
  onSelect,
  onCompare
}: PptxVersionHistoryProps): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const locale = resolveLocaleFromTags([i18n.resolvedLanguage ?? i18n.language])
  const [open, setOpen] = useState(false)
  const selected = selectedOf(inspect)
  const previous = previousOf(inspect)
  const describe = (version: ManagedFileVersionDescriptor): string =>
    [authorLabel(version.author, t), versionSummaryLabel(version.summary, t)]
      .filter(Boolean)
      .join(' · ')
  const newestFirst = [...inspect.versions].reverse()
  return (
    <div data-testid="pptx-version-history" className="shrink-0 border-b border-border-300/60">
      <div className="flex min-h-8 flex-wrap items-center gap-1 px-2 py-0.5 text-xs">
        <span className="min-w-0 flex-1 truncate text-text-300">
          {selected ? describe(selected) : null}
        </span>
        <Button
          type="button"
          variant={comparing ? 'secondary' : 'ghost'}
          size="sm"
          disabled={!selected || !previous}
          onClick={() => {
            if (selected && previous) onCompare(previous, selected)
          }}
        >
          <FileDiff aria-hidden="true" />
          {t('Compare with previous version')}
        </Button>
        <Button
          type="button"
          variant={open ? 'secondary' : 'ghost'}
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <History aria-hidden="true" />
          {t('Version history')}
        </Button>
      </div>
      {open ? (
        <ul aria-label={t('Version history')} className="max-h-48 overflow-y-auto px-1 pb-1">
          {newestFirst.map((version) => {
            const current = version.id === inspect.selectedVersionId
            return (
              <li key={version.id}>
                <button
                  type="button"
                  aria-current={current ? 'true' : undefined}
                  className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs hover:bg-bg-200 ${current ? 'bg-bg-200 font-medium' : ''}`}
                  onClick={() => onSelect(version.id)}
                >
                  <span className="shrink-0 text-text-000">v{version.versionNumber}</span>
                  <span className="min-w-0 flex-1 truncate text-text-300">{describe(version)}</span>
                  <span className="shrink-0 text-text-400">
                    {formatDateTime(version.createdAt, locale)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

export { PptxVersionHistory }
export type { PptxVersionHistoryProps }
