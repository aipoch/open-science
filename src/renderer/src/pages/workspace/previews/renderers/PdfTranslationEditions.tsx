import { formatPdfTranslationGlossary } from '../../../../../../shared/pdf-translation'
import { useId, useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import * as AlertDialog from '@/components/ui/alert-dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import { Info, LoaderCircle, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PdfTranslationEdition } from '../../../../../../shared/pdf-translation'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PdfTranslationActionHint } from './PdfTranslationActionHint'

export function PdfTranslationEditions({
  editions,
  selectedKey,
  disabledReason,
  loading,
  error,
  onSelect,
  onRetry,
  onDelete
}: {
  editions: readonly PdfTranslationEdition[]
  selectedKey?: string
  disabledReason?: string
  loading?: boolean
  error?: boolean
  onSelect: (id: string) => void
  onRetry: () => void
  onDelete?: (id: string) => Promise<boolean>
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const [deletingEdition, setDeletingEdition] = useState<PdfTranslationEdition>()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  const labelId = useId()
  const parametersId = useId()
  const selected = editions.find((edition) => edition.key === selectedKey)
  if (!editions.length && !error) return null
  const date = (time: number): string =>
    new Date(time).toLocaleString(i18n.resolvedLanguage, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  const language = (value: string): string => t(value, { defaultValue: value })
  const label = (edition: PdfTranslationEdition, index: number): string =>
    `#${index + 1} ${language(edition.language)} · ${edition.model.modelId ?? t('Default')}`
  return (
    <AlertDialog.Root
      open={Boolean(deletingEdition)}
      onOpenChange={(open) => {
        if (!open && !deleting) setDeletingEdition(undefined)
      }}
    >
      <div className="min-w-0 text-xs">
        {editions.length ? (
          <>
            <label id={labelId} className="sr-only">
              {t('Saved translations')}
            </label>
            <div className="flex min-w-0 items-center gap-1">
              <PdfTranslationActionHint
                reason={disabledReason}
                className="min-w-0 flex-1 [&>button]:w-full"
              >
                <Select
                  value={selected?.id ?? ''}
                  disabled={Boolean(disabledReason)}
                  onValueChange={onSelect}
                >
                  <SelectTrigger
                    className="h-7 text-xs"
                    aria-labelledby={labelId}
                    aria-busy={loading}
                  >
                    <SelectValue placeholder={t('Choose a saved translation')}>
                      {selected ? label(selected, editions.indexOf(selected)) : undefined}
                    </SelectValue>
                    {loading ? (
                      <LoaderCircle
                        className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    className="z-[120] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)] [&_[data-slot=select-item]>span:first-child]:min-w-0 [&_[data-slot=select-item]>span:first-child]:flex-1"
                  >
                    {editions.map((edition, index) => (
                      <SelectItem
                        key={edition.id}
                        value={edition.id}
                        aria-label={`${label(edition, index)} · ${date(edition.updatedAt)}`}
                      >
                        <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
                          <span className="truncate">{label(edition, index)}</span>
                          <span className="text-xs text-muted-foreground">
                            {date(edition.updatedAt)}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </PdfTranslationActionHint>
              {selected ? (
                <Popover key={selected.key}>
                  <TooltipProvider delayDuration={100}>
                    <Tooltip>
                      <TooltipTrigger
                        asChild
                        onFocus={(event) => {
                          if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                        }}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 shrink-0 text-muted-foreground"
                            aria-label={t('Saved translation parameters')}
                          >
                            <Info className="size-3.5" aria-hidden="true" />
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent className="z-[140]">
                        {t('Saved translation parameters')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <PopoverContent
                    align="end"
                    side="bottom"
                    collisionPadding={12}
                    aria-labelledby={parametersId}
                    className="z-[130] max-h-[min(28rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-24px)] overflow-y-auto border border-border bg-popover p-4 text-popover-foreground shadow-lg"
                  >
                    <h3 id={parametersId} className="mb-4 text-sm font-medium">
                      {t('Saved translation parameters')}
                    </h3>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs [&_dt]:mb-1 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere]">
                      <div className="col-span-2">
                        <dt>{t('Model')}</dt>
                        <dd className="text-sm font-medium">
                          {selected.model.modelId ?? t('Default')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('Target language')}</dt>
                        <dd>{language(selected.language)}</dd>
                      </div>
                      <div>
                        <dt>{t('Translation method')}</dt>
                        <dd>
                          {selected.model.mode === 'api' ||
                          selected.model.frameworkId === 'direct-api'
                            ? t('Direct API')
                            : selected.model.mode === 'local'
                              ? t('Local model')
                              : t('Agent')}
                        </dd>
                      </div>
                      {selected.model.frameworkId !== 'direct-api' ? (
                        <div>
                          <dt>{t('Framework')}</dt>
                          <dd>{selected.model.frameworkId}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>{t('Concurrent translations')}</dt>
                        <dd>{selected.concurrency}x</dd>
                      </div>
                      {selected.model.reasoningEffort ? (
                        <div>
                          <dt>{t('Reasoning effort')}</dt>
                          <dd>{selected.model.reasoningEffort}</dd>
                        </div>
                      ) : null}
                      <div className="col-span-2">
                        <dt>{t('Provider')}</dt>
                        <dd>
                          {selected.model.providerName ??
                            providers.find(({ id }) => id === selected.model.providerId)?.name ??
                            t('Not recorded')}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt>{t('Updated')}</dt>
                        <dd>
                          <time dateTime={new Date(selected.updatedAt).toISOString()}>
                            {date(selected.updatedAt)}
                          </time>
                        </dd>
                      </div>
                      <div className="col-span-2 border-t border-border pt-3">
                        <dt>{t('Translation glossary')}</dt>
                        <dd className="line-clamp-3 whitespace-pre-wrap">
                          {selected.glossary.length
                            ? formatPdfTranslationGlossary(selected.glossary)
                            : t('None')}
                        </dd>
                      </div>
                    </dl>
                  </PopoverContent>
                </Popover>
              ) : null}
              {selected && onDelete ? (
                <PdfTranslationActionHint reason={disabledReason}>
                  <TooltipProvider delayDuration={100}>
                    <Tooltip>
                      <TooltipTrigger
                        asChild
                        onFocus={(event) => {
                          if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                        }}
                      >
                        <AlertDialog.Trigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label={t('Delete translation')}
                            disabled={Boolean(disabledReason)}
                            onClick={() => {
                              setDeleteError(false)
                              setDeletingEdition(selected)
                            }}
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </Button>
                        </AlertDialog.Trigger>
                      </TooltipTrigger>
                      <TooltipContent className="z-[140]">{t('Delete translation')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </PdfTranslationActionHint>
              ) : null}
            </div>
          </>
        ) : null}
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
            aria-busy={deleting}
          >
            <div className={dialogHeaderClassName}>
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Delete translation?')}
              </AlertDialog.Title>
            </div>
            <div className={dialogBodyClassName}>
              <p className="mb-2 break-words font-medium">
                {deletingEdition
                  ? `${language(deletingEdition.language)} · ${deletingEdition.model.modelId ?? t('Default')}`
                  : ''}
              </p>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {t(
                  'This removes this saved translation from all entries for this PDF. The original PDF and other translations are kept. This cannot be undone.'
                )}
              </AlertDialog.Description>
              {deleteError ? (
                <ErrorNotice
                  inline
                  role="alert"
                  className="mt-3"
                  title={t('Could not delete the saved translation. Try again.')}
                />
              ) : null}
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button variant="outline" disabled={deleting}>
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <PdfTranslationActionHint reason={disabledReason}>
                <Button
                  className="border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white"
                  disabled={deleting || Boolean(disabledReason)}
                  onClick={async () => {
                    if (!deletingEdition || !onDelete || deleting || disabledReason) return
                    setDeleting(true)
                    setDeleteError(false)
                    try {
                      if (await onDelete(deletingEdition.id)) setDeletingEdition(undefined)
                      else setDeleteError(true)
                    } catch {
                      setDeleteError(true)
                    } finally {
                      setDeleting(false)
                    }
                  }}
                >
                  {deleting ? t('Deleting…') : t('Delete translation')}
                </Button>
              </PdfTranslationActionHint>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
        {error ? (
          <div role="alert" className="flex items-center gap-2 text-muted-foreground">
            <p>{t('Could not load the saved translation.')}</p>
            <PdfTranslationActionHint reason={disabledReason}>
              <Button
                size="sm"
                variant="ghost"
                onClick={onRetry}
                disabled={Boolean(disabledReason)}
              >
                {t('Retry')}
              </Button>
            </PdfTranslationActionHint>
          </div>
        ) : null}
      </div>
    </AlertDialog.Root>
  )
}
