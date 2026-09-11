/* Hallmark · component scope · existing Open-Science tokens · P5 H5 E5 S5 R5 V4 */
import { useMemo, useState } from 'react'
import * as Dialog from '@/components/ui/dialog'
import { BookOpenText, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import type { LiteratureItemView } from '../../../../shared/literature'
import { MAX_SESSION_PDF_CONTEXTS } from '../../../../shared/session-persistence'
import type { PdfReadingDocument } from '@/stores/navigation-store'
import { literatureReadingDocument } from './literature-reading'

export const LiteratureReadingDialog = ({
  entries,
  error,
  onClose,
  onContinue
}: {
  entries?: readonly LiteratureItemView[]
  error?: string
  onClose: () => void
  onContinue: (documents: readonly PdfReadingDocument[]) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const rows = useMemo(
    () => entries?.map((entry) => ({ entry, document: literatureReadingDocument(entry) })) ?? [],
    [entries]
  )
  const [chosen, setChosen] = useState<Set<string>>()
  const available = rows.filter(({ document }) => document)
  const selectedIds =
    chosen ??
    new Set(
      available.length <= MAX_SESSION_PDF_CONTEXTS ? available.map(({ entry }) => entry.id) : []
    )
  const selected = rows.flatMap(({ entry, document }) =>
    selectedIds.has(entry.id) && document ? [document] : []
  )

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[calc(100vh-2rem)] w-[min(560px,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{t('Read with agent')}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t('Choose up to {{limit}} PDFs to read together.', {
                  limit: MAX_SESSION_PDF_CONTEXTS
                })}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('Close')}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className={`${dialogBodyClassName} min-h-0 overflow-y-auto`}>
            {error ? (
              <LiteratureErrorNotice title={error} />
            ) : !entries ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t('Loading…')}
              </p>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between gap-2 text-sm">
                  <span>
                    {t('{{count}} selected', {
                      count: selected.length,
                      defaultValue_one: '{{count}} selected'
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={selected.length === 0}
                    onClick={() => setChosen(new Set())}
                  >
                    {t('Clear selection')}
                  </Button>
                </div>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {rows.map(({ entry, document }) => (
                    <label key={entry.id} className="flex items-start gap-3 px-3 py-3">
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0 accent-primary"
                        aria-label={t('Read {{title}}', { title: entry.item.title })}
                        checked={selectedIds.has(entry.id)}
                        disabled={
                          !document ||
                          (!selectedIds.has(entry.id) &&
                            selected.length >= MAX_SESSION_PDF_CONTEXTS)
                        }
                        onChange={(event) => {
                          const next = new Set(selectedIds)
                          if (event.target.checked) next.add(entry.id)
                          else next.delete(entry.id)
                          setChosen(next)
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium break-words">{entry.item.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground break-all">
                          {document?.item.name ?? t('No readable PDF')}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <div
            className={`${dialogFooterClassName} flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
          >
            <Button variant="outline" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              disabled={
                Boolean(error) ||
                selected.length === 0 ||
                selected.length > MAX_SESSION_PDF_CONTEXTS
              }
              onClick={() => onContinue(selected)}
            >
              <BookOpenText className="size-4" aria-hidden="true" />
              {t('Continue')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
