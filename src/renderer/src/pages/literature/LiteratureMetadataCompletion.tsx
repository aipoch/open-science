import { Check, LoaderCircle } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { literatureMetadataProviderLabel } from '../../../../shared/literature'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import type { LiteratureItemView, LiteratureMetadataField } from '../../../../shared/literature'
import { LiteratureMetadataLookup } from './LiteratureMetadataLookup'
import { useLiteratureMetadata } from './useLiteratureMetadata'

import { metadataValuesMatch } from './literature-item-display'

export function LiteratureMetadataCompletion({
  selectedItem,
  metadata,
  metadataFieldLabel,
  onOpenChange
}: {
  selectedItem: LiteratureItemView
  metadata: ReturnType<typeof useLiteratureMetadata>
  metadataFieldLabel: (field: LiteratureMetadataField) => string
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const accessibilityId = useId()
  const activeMetadataCompletion =
    metadata.completion?.item.id === selectedItem.id ? metadata.completion : undefined
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 text-sm">
      <LiteratureMetadataLookup
        key={selectedItem.id}
        busy={metadata.completing}
        error={
          metadata.completionError?.itemId === selectedItem.id
            ? metadata.completionError.message
            : undefined
        }
        hasResult={Boolean(activeMetadataCompletion)}
        item={selectedItem}
        onOpenChange={onOpenChange}
        onReset={() => {
          metadata.resetCompletion()
        }}
        onSearch={(identifier) => void metadata.complete('preview', identifier)}
      >
        {activeMetadataCompletion ? (
          <div className="space-y-4">
            {activeMetadataCompletion.sources?.map((source, index) => (
              <p key={index} className="text-xs text-muted-foreground">
                <ExternalTextLink href={source.sourceUrl ?? activeMetadataCompletion.sourceUrl}>
                  {literatureMetadataProviderLabel(source.provider)}
                </ExternalTextLink>
              </p>
            ))}
            {activeMetadataCompletion.failures?.length ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t('Some sources were unavailable. Results may be incomplete.')}
              </p>
            ) : null}
            {activeMetadataCompletion.filled.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {activeMetadataCompletion.mode === 'commit'
                    ? t('Fields completed: {{total}}', {
                        total: activeMetadataCompletion.filled.length
                      })
                    : t('Fields to add: {{total}}', {
                        total: activeMetadataCompletion.filled.length
                      })}
                </p>
                <dl className="mt-2 divide-y divide-border-300/70 rounded-lg border border-border-300/70 bg-bg-000">
                  {activeMetadataCompletion.filled.map(({ field, value }) => (
                    <div
                      key={`${field}:${value}`}
                      className="grid grid-cols-[7rem_1fr] gap-3 px-3 py-2"
                    >
                      <dt className="text-xs text-muted-foreground">{metadataFieldLabel(field)}</dt>
                      <dd className="min-w-0 break-words text-xs">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('No missing metadata was found.')}</p>
            )}
            {activeMetadataCompletion.conflicts.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('Existing values kept')}
                </p>
                <div className="mt-2 space-y-2">
                  {activeMetadataCompletion.conflicts.map(({ currentValue, field, value }) => {
                    const valuesMatch = metadataValuesMatch(currentValue, value)
                    const providerLabel = [
                      ...new Set(
                        (
                          activeMetadataCompletion.sources ?? [
                            { provider: activeMetadataCompletion.provider }
                          ]
                        ).map((source) => literatureMetadataProviderLabel(source.provider))
                      )
                    ].join(' / ')
                    return (
                      <div
                        key={field}
                        className="rounded-lg border border-border-300/70 bg-bg-000 px-3 py-2 text-xs"
                      >
                        <p id={`${accessibilityId}-${field}-label`} className="font-medium">
                          {metadataFieldLabel(field)}
                        </p>
                        <div className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
                          <span className="py-1 text-muted-foreground">{t('Kept')}</span>
                          <p className="min-w-0 break-words py-1 leading-5 text-foreground">
                            {currentValue}
                          </p>
                          <span aria-hidden="true" />
                          <span className="py-1 text-muted-foreground">{providerLabel}</span>
                          <p
                            id={`${accessibilityId}-${field}-candidate`}
                            className="min-w-0 break-words py-1 leading-5 text-foreground"
                          >
                            {value}
                          </p>
                          {valuesMatch ? (
                            <span className="self-start rounded-full bg-bg-200 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                              {t('Unchanged')}
                            </span>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 self-start px-3 text-xs"
                              aria-pressed={metadata.overwriteFields.has(field)}
                              aria-describedby={`${accessibilityId}-${field}-label ${accessibilityId}-${field}-candidate`}
                              onClick={() => metadata.toggleOverwrite(field)}
                            >
                              {metadata.overwriteFields.has(field) ? (
                                <Check className="size-3" aria-hidden="true" />
                              ) : null}
                              {providerLabel === 'PubMed'
                                ? t('Use PubMed')
                                : providerLabel === 'Crossref'
                                  ? t('Use Crossref')
                                  : t('Use {{source}}', {
                                      source: providerLabel
                                    })}
                            </Button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
            {activeMetadataCompletion.mode === 'preview' &&
            (activeMetadataCompletion.filled.length > 0 || metadata.overwriteFields.size > 0) ? (
              <div className="flex justify-end gap-2 border-t border-border-300/80 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={metadata.completing}
                  onClick={() => metadata.resetCompletion()}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={metadata.completing}
                  onClick={() => void metadata.complete('commit')}
                >
                  {metadata.completing ? (
                    <LoaderCircle
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Check className="size-3.5" aria-hidden="true" />
                  )}
                  {t('Apply metadata')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </LiteratureMetadataLookup>
    </div>
  )
}
