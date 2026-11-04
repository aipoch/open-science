import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogFormLabelClassName,
  dialogFormTextareaClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { parseLiteratureLink } from '../../../../../shared/literature-link'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import { useLiteratureHost } from '../renderer-host'
import { LiteratureTable, LiteratureTextTooltip } from '../LiteratureTable'
import { LiteratureImportDialogFrame } from './LiteratureImportDialogFrame'

export function LiteratureLinkImportDialog({
  onClose,
  onCloseAutoFocus,
  onResolved,
  onBatchResolved
}: {
  onClose: () => void
  onCloseAutoFocus?: (event: Event) => void
  onBatchResolved: (items: LiteratureItemInput[]) => void
  onResolved: (item: LiteratureItemInput, source: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const id = useId()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [results, setResults] = useState<{ input: string; item?: LiteratureItemInput }[]>([])
  const canReview = !busy && results.some((row) => row.item)
  const isArxiv = input
    .split(/\r?\n/u)
    .some((line) => parseLiteratureLink(line)?.startsWith('arxiv:'))
  const phase = useRef<'idle' | 'pending' | 'closed'>('idle')
  useEffect(() => {
    phase.current = 'idle'
    return () => {
      phase.current = 'closed'
    }
  }, [])
  const isClosed = (): boolean => phase.current === 'closed'
  const close = (): void => {
    phase.current = 'closed'
    onClose()
  }
  const search = async (): Promise<void> => {
    if (phase.current !== 'idle') return
    const lines = input
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length > 100) {
      setError(t('Enter at most 100 references, one per line.'))
      return
    }
    if (!lines.length) return
    if (lines.length === 1 && !parseLiteratureLink(lines[0])) {
      setError(t('Use a DOI, arXiv ID, PMID, PMCID, or a supported article link.'))
      return
    }
    phase.current = 'pending'
    setError(undefined)
    setBusy(true)
    setResults([])
    const rows: { input: string; item?: LiteratureItemInput }[] = []
    const seen = new Set<string>()
    try {
      for (const line of lines) {
        if (isClosed()) return
        const reference = parseLiteratureLink(line)
        if (reference && seen.has(reference)) continue
        if (reference) seen.add(reference)
        let item: LiteratureItemInput | undefined
        if (reference) {
          try {
            const found = await api.literature.lookupMetadata(reference)
            if (found.title.trim()) item = found
          } catch {
            // One failed lookup must not discard successful rows or stop later inputs.
          }
        }
        if (isClosed()) return
        if (lines.length === 1) {
          if (!item || !reference) throw new Error('Metadata has no title.')
          phase.current = 'closed'
          onResolved(
            item,
            reference.startsWith('arxiv:')
              ? 'arXiv'
              : reference.startsWith('pmcid:')
                ? 'PMCID'
                : reference.startsWith('pmid:')
                  ? 'PMID'
                  : 'DOI'
          )
          return
        }
        rows.push({ input: line, item })
        setResults([...rows])
      }
    } catch {
      if (!isClosed())
        setError(
          t(
            'Reference details could not be retrieved. Check the identifier and try again, or import a PDF or bibliography file.'
          )
        )
    } finally {
      if (!isClosed()) {
        phase.current = 'idle'
        setBusy(false)
      }
    }
  }
  return (
    <LiteratureImportDialogFrame
      className="w-[min(640px,calc(100vw-2rem))]"
      // Metadata lookup is read-only; cancellation remains available while it runs.
      busy={false}
      onClose={close}
      onCloseAutoFocus={onCloseAutoFocus}
      title={t('Add from DOI or link')}
      footer={
        <div className={dialogFooterClassName}>
          <Button variant="outline" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button
            variant={canReview ? 'outline' : 'default'}
            disabled={busy || !input.trim()}
            aria-busy={busy}
            onClick={() => void search()}
          >
            {busy ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {busy ? t('Searching…') : t('Find reference')}
          </Button>
          {canReview ? (
            <Button
              onClick={() => {
                if (phase.current !== 'idle') return
                phase.current = 'closed'
                onBatchResolved(results.flatMap((row) => (row.item ? [row.item] : [])))
              }}
            >
              {t('Review references')}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className={cn(dialogBodyClassName, 'min-h-0 space-y-4 overflow-y-auto')}>
        <div>
          <label htmlFor={id} className={dialogFormLabelClassName}>
            {t('DOI, arXiv, PMID, PMCID or links')}
          </label>
          <Textarea
            className={cn(dialogFormTextareaClassName, 'min-h-24 resize-y')}
            rows={6}
            id={id}
            value={input}
            disabled={busy}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help${isArxiv ? ` ${id}-version` : ''}${error ? ` ${id}-error` : ''}`}
            onChange={(event) => {
              setInput(event.currentTarget.value)
              setError(undefined)
              setResults([])
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                void search()
              }
            }}
          />
          <p id={`${id}-help`} className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t('Enter at most 100 references, one per line.')}
          </p>
        </div>
        {busy ? (
          <p role="status">{t('References checked: {{checked}}', { checked: results.length })}</p>
        ) : null}
        {results.length ? (
          <LiteratureTable
            className="w-full table-fixed text-left text-sm"
            aria-label={t('Lookup results')}
          >
            <thead className="border-b border-border-300/80 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-2/5 px-2 py-2 font-medium">
                  {t('Input')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('Result')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-300/60">
              {results.map((row, index) => (
                <tr key={index}>
                  <th scope="row" className="px-2 py-3 align-top font-normal text-muted-foreground">
                    <LiteratureTextTooltip text={row.input} overflowOnly>
                      <span tabIndex={0} className="block truncate">
                        {row.input}
                      </span>
                    </LiteratureTextTooltip>
                  </th>
                  <td className="px-2 py-3 align-top">
                    <LiteratureTextTooltip
                      text={row.item?.title ?? t('Lookup failed')}
                      overflowOnly
                    >
                      <span
                        tabIndex={0}
                        className={cn('block truncate', !row.item && 'text-muted-foreground')}
                      >
                        {row.item?.title ?? t('Lookup failed')}
                      </span>
                    </LiteratureTextTooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </LiteratureTable>
        ) : null}
        {error ? (
          <div id={`${id}-error`}>
            <ErrorNotice inline role="alert" description={error} />
          </div>
        ) : null}
        {isArxiv ? (
          <p id={`${id}-version`} className="text-sm text-muted-foreground">
            {t('Versioned arXiv links use the latest metadata.')}
          </p>
        ) : null}
      </div>
    </LiteratureImportDialogFrame>
  )
}
