import type { TFunction } from 'i18next'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-contract'
import type {
  ManagedFileIdentity,
  ManagedFileVersionDescriptor
} from '../../../../../shared/managed-file-versions'
import { diffPptxOutlines, type PptxSlideDiff } from '../../../../../shared/pptx-edit'
import type { PptxEditSessionView } from '../../../../../shared/pptx-edit-session'
import { changeLabel } from './pptx-version-labels'
import { OfficePreviewContent } from './renderers/OfficePreview'
import { usePptxVersionView } from './use-pptx-outline'

type PptxVersionCompareProps = {
  item: PreviewFileItem
  source: PreviewFileSource
  identity: ManagedFileIdentity
  base: ManagedFileVersionDescriptor
  target: ManagedFileVersionDescriptor
  onClose: () => void
}

const entryTitle = (entry: PptxSlideDiff, t: TFunction): string =>
  t('Slide {{number}}', {
    number: (entry.kind === 'removed' ? entry.fromIndex : entry.toIndex) + 1
  })

const entryDetail = (entry: PptxSlideDiff, t: TFunction): string => {
  if (entry.kind === 'added') return t('Slide added')
  if (entry.kind === 'removed') return t('Slide removed')
  return [
    ...(entry.moved ? [t('Moved from slide {{number}}', { number: entry.fromIndex + 1 })] : []),
    ...entry.changes.map((change) => changeLabel(change, t))
  ].join(', ')
}

type ComparePaneProps = {
  item: PreviewFileItem
  source: PreviewFileSource
  label: string
  view: PptxEditSessionView
  // Undefined when the selected slide does not exist in this version.
  slideIndex: number | undefined
  serial: number
}

const ComparePane = ({
  item,
  source,
  label,
  view,
  slideIndex,
  serial
}: ComparePaneProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <section aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-2 py-1 text-xs font-medium text-text-000">{label}</div>
      <div className="relative min-h-0 flex-1">
        {slideIndex === undefined ? (
          <div className="flex size-full items-center justify-center p-4 text-xs text-text-300">
            {t('This slide is not in this version.')}
          </div>
        ) : (
          <OfficePreviewContent
            item={item}
            source={source}
            slideRequest={{ slideIndex, serial }}
            staged={{ key: view.stagedKey, slideIndex, onSlideView: () => undefined }}
          />
        )}
      </div>
    </section>
  )
}

const PptxVersionCompare = ({
  item,
  source,
  identity,
  base,
  target,
  onClose
}: PptxVersionCompareProps): React.JSX.Element => {
  const { t } = useTranslation()
  const before = usePptxVersionView(identity, base.id, true)
  const after = usePptxVersionView(identity, target.id, true)
  const [selection, setSelection] = useState({ index: 0, serial: 0 })
  const diff = useMemo(
    () =>
      before.view && after.view
        ? diffPptxOutlines(before.view.outline, after.view.outline)
        : undefined,
    [after.view, before.view]
  )
  const entry = diff?.slides[selection.index] ?? diff?.slides[0]
  const baseLabel = t('Version {{number}}', { number: base.versionNumber })
  const targetLabel = t('Version {{number}}', { number: target.versionNumber })
  return (
    <div className="flex size-full min-h-0 flex-col" data-testid="pptx-version-compare">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-300 px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-text-000">
          {t('Changes from {{base}} to {{target}}', { base: baseLabel, target: targetLabel })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('Close comparison')}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {before.failed || after.failed ? (
        <div role="alert" className="p-4 text-xs text-destructive">
          {t('These versions could not be compared.')}
        </div>
      ) : !diff || !before.view || !after.view ? null : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul
            aria-label={t('Changed slides')}
            className="max-h-40 shrink-0 overflow-y-auto border-b border-border-300 p-1 md:max-h-none md:w-48 md:border-b-0 md:border-r"
          >
            {diff.slideSizeChanged ? (
              <li className="px-2 py-1 text-xs text-text-300">{t('The slide size changed.')}</li>
            ) : null}
            {diff.slides.length === 0 ? (
              <li className="px-2 py-1 text-xs text-text-300">{t('No slides changed.')}</li>
            ) : null}
            {diff.slides.map((candidate, index) => (
              <li key={`${candidate.kind}:${candidate.slideId}`}>
                <button
                  type="button"
                  aria-current={candidate === entry ? 'true' : undefined}
                  className={`w-full rounded px-2 py-1 text-left text-xs hover:bg-bg-200 ${candidate === entry ? 'bg-bg-200' : ''}`}
                  onClick={() => setSelection((current) => ({ index, serial: current.serial + 1 }))}
                >
                  <span className="block font-medium text-text-000">
                    {entryTitle(candidate, t)}
                  </span>
                  <span className="block text-text-300">{entryDetail(candidate, t)}</span>
                </button>
              </li>
            ))}
          </ul>
          {entry ? (
            <div className="flex min-h-0 flex-1 flex-col gap-1 sm:flex-row">
              <ComparePane
                item={item}
                source={source}
                label={baseLabel}
                view={before.view}
                slideIndex={entry.kind === 'added' ? undefined : entry.fromIndex}
                serial={selection.serial}
              />
              <ComparePane
                item={item}
                source={source}
                label={targetLabel}
                view={after.view}
                slideIndex={entry.kind === 'removed' ? undefined : entry.toIndex}
                serial={selection.serial}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export { PptxVersionCompare }
export type { PptxVersionCompareProps }
