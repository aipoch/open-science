import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type {
  LiteratureCitationStyle,
  LiteratureCitationStyleView,
  LiteratureFormatReferencesResult
} from '../../../../shared/literature'

type CitationCopyKind = 'bibtex' | 'inText' | 'reference' | 'ris'

type LiteratureCitationPanelProps = Readonly<{
  initialStyle: LiteratureCitationStyle
  itemId: string
  locale: 'en-US' | 'zh-CN'
  onManageStyles: () => void
  onOpenChange: (open: boolean) => void
  onStyleChange: (style: LiteratureCitationStyle) => void
  styles?: readonly LiteratureCitationStyleView[]
}>

const LiteratureCitationPanel = ({
  initialStyle,
  itemId,
  locale,
  onManageStyles,
  onOpenChange,
  onStyleChange,
  styles
}: LiteratureCitationPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [style, setStyle] = useState(initialStyle)
  const [formatState, setFormatState] = useState<{
    key: string
    value?: LiteratureFormatReferencesResult
    error?: string
  }>()
  const [copied, setCopied] = useState<CitationCopyKind>()
  const styleOptions = styles ?? [
    { id: 'apa', title: t('APA'), source: 'built-in' as const },
    { id: 'mla', title: t('MLA'), source: 'built-in' as const },
    { id: 'vancouver', title: t('Vancouver'), source: 'built-in' as const }
  ]
  const requestKey = `${itemId}:${style}:${locale}`
  const result = formatState?.key === requestKey ? formatState.value : undefined
  const error = formatState?.key === requestKey ? formatState.error : undefined
  const formattedCitation = result?.references[0]

  useEffect(() => {
    let active = true
    void window.api.literature.formatReferences({ itemIds: [itemId], styleId: style, locale }).then(
      (value) => {
        if (!active) return
        setFormatState(
          value.references[0]
            ? { key: requestKey, value }
            : { key: requestKey, error: t('Citation could not be formatted.') }
        )
      },
      () => {
        if (active)
          setFormatState({ key: requestKey, error: t('Citation could not be formatted.') })
      }
    )
    return () => {
      active = false
    }
  }, [itemId, locale, requestKey, style, t])

  const copyCitation = async (kind: CitationCopyKind): Promise<void> => {
    const text =
      kind === 'bibtex' || kind === 'ris' ? result?.exports[kind] : formattedCitation?.[kind]
    if (!text || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(text)
      setFormatState((current) =>
        current?.key === requestKey ? { ...current, error: undefined } : current
      )
      setCopied(kind)
      window.setTimeout(
        () => setCopied((current) => (current === kind ? undefined : current)),
        1_500
      )
    } catch {
      setFormatState((current) =>
        current?.key === requestKey
          ? { ...current, error: t('Citation could not be copied.') }
          : current
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            {t('Citation style')}
            <Select
              value={style}
              onValueChange={(value) => {
                setCopied(undefined)
                setStyle(value)
                onStyleChange(value)
              }}
              onOpenChange={onOpenChange}
            >
              <SelectTrigger className="mt-2 w-full" aria-label={t('Citation style')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {styleOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="mt-1 h-auto px-0"
            onClick={onManageStyles}
          >
            {t('Manage citation styles…')}
          </Button>
        </div>
        <div data-testid="citation-preview" className="min-h-48">
          {error ? (
            <div className="flex min-h-48 items-center justify-center rounded-lg border border-border-300/80 bg-bg-000 p-4">
              <p role="alert" className="text-sm text-danger-000">
                {error}
              </p>
            </div>
          ) : !result ? (
            <div
              role="status"
              aria-label={t('Loading citation…')}
              className="min-h-48 divide-y divide-border-300/80 rounded-lg border border-border-300/80 bg-bg-000"
            >
              <span className="sr-only">{t('Loading citation…')}</span>
              {[t('Reference'), t('In-text citation')].map((label, index) => (
                <div key={label} className="grid grid-cols-[1fr_auto] gap-3 p-3">
                  <div className="min-w-0 motion-safe:animate-pulse">
                    <p className="text-xs font-medium text-muted-foreground">{label}</p>
                    <div
                      className={cn('mt-3 h-3 rounded bg-muted', index === 0 ? 'w-5/6' : 'w-2/5')}
                    />
                    {index === 0 ? <div className="mt-2 h-3 w-3/5 rounded bg-muted" /> : null}
                  </div>
                  <div className="size-7" aria-hidden="true" />
                </div>
              ))}
            </div>
          ) : formattedCitation ? (
            <div className="min-h-48 divide-y divide-border-300/80 rounded-lg border border-border-300/80 bg-bg-000">
              {(
                [
                  ['reference', t('Reference')],
                  ['inText', t('In-text citation')]
                ] as const
              ).map(([kind, label]) => (
                <div key={kind} className="grid grid-cols-[1fr_auto] gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">{label}</p>
                    <p className="mt-1 whitespace-pre-wrap leading-6">{formattedCitation[kind]}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    disabled={!navigator.clipboard?.writeText}
                    aria-label={
                      copied === kind
                        ? t('Copied')
                        : kind === 'inText'
                          ? t('Copy in-text citation')
                          : t('Copy reference')
                    }
                    onClick={() => void copyCitation(kind)}
                  >
                    {copied === kind ? (
                      <Check className="size-3.5" aria-hidden="true" />
                    ) : (
                      <Copy className="size-3.5" aria-hidden="true" />
                    )}
                    {copied === kind ? t('Copied') : t('Copy')}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-border-300/80 px-5 py-3">
        {(['bibtex', 'ris'] as const).map((format) => (
          <Button
            key={format}
            type="button"
            variant="outline"
            size="sm"
            disabled={!formattedCitation || !navigator.clipboard?.writeText}
            aria-label={
              copied === format
                ? t('Copied')
                : format === 'bibtex'
                  ? t('Copy BibTeX')
                  : t('Copy RIS')
            }
            onClick={() => void copyCitation(format)}
          >
            {copied === format ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {format === 'bibtex' ? t('BibTeX') : t('RIS')}
          </Button>
        ))}
      </div>
    </div>
  )
}

export { LiteratureCitationPanel }
