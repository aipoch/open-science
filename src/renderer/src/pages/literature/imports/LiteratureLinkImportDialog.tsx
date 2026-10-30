import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import { dialogFooterClassName } from '@/components/ui/dialog-chrome'
import { parseLiteratureLink } from '../../../../../shared/literature-link'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import { useLiteratureHost } from '../renderer-host'
import { LiteratureImportDialogFrame } from './LiteratureImportDialogFrame'

export function LiteratureLinkImportDialog({
  onClose,
  onCloseAutoFocus,
  onResolved
}: {
  onClose: () => void
  onCloseAutoFocus?: (event: Event) => void
  onResolved: (item: LiteratureItemInput, source: 'DOI' | 'arXiv') => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const id = useId()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const isArxiv = parseLiteratureLink(input)?.startsWith('arxiv:') ?? false
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
    const reference = parseLiteratureLink(input)
    if (!reference) {
      setError(
        t(
          'This identifier or link is not supported. Try a DOI, a doi.org link, or an arXiv abstract or PDF link, or import a bibliography file.'
        )
      )
      return
    }
    phase.current = 'pending'
    setError(undefined)
    setBusy(true)
    try {
      const item = await api.literature.lookupMetadata(reference)
      if (isClosed()) return
      if (!item.title.trim()) throw new Error('Metadata has no title.')
      onResolved(item, reference.startsWith('arxiv:') ? 'arXiv' : 'DOI')
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
      // Metadata lookup is read-only; cancellation remains available while it runs.
      busy={false}
      onClose={close}
      onCloseAutoFocus={onCloseAutoFocus}
      title={t('Add from DOI or link')}
      description={t(
        'Find reference details to review before saving. Full-text PDFs can be added later.'
      )}
      footer={
        <div className={dialogFooterClassName}>
          <Button variant="outline" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button disabled={busy || !input.trim()} aria-busy={busy} onClick={() => void search()}>
            {busy ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {busy ? t('Searching…') : t('Find reference')}
          </Button>
        </div>
      }
    >
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-5">
        <div className="space-y-2">
          <label htmlFor={id} className="text-sm font-medium">
            {t('DOI or arXiv link')}
          </label>
          <Input
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
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void search()
              }
            }}
          />
          <p id={`${id}-help`} className="text-sm text-muted-foreground">
            {t('For example: {{doi}} or {{url}}', {
              doi: '10.1038/nphys1170',
              url: 'https://arxiv.org/abs/2401.12345'
            })}
          </p>
        </div>
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
