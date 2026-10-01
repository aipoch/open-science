import * as Dialog from '@/components/ui/dialog'
import { Check, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLiteratureCandidates } from './useLiteratureCandidates'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import type {
  LiteratureInboxCandidateView,
  LiteratureItemType
} from '../../../../shared/literature'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierValue
} from '../../../../shared/literature'

import {
  getExternalLiteratureUrl,
  inboxProviderLabel,
  itemDescription
} from './literature-item-display'

export function LiteratureCandidateDialog({
  selectedCandidate,
  onClose,
  itemTypeLabels,
  projectNames,
  busy,
  entriesFailed,
  changeCandidateState,
  restoreDismissedCandidates
}: {
  selectedCandidate?: LiteratureInboxCandidateView
  onClose: () => void
  itemTypeLabels: Record<LiteratureItemType, string>
  projectNames: string[]
  busy: boolean
  entriesFailed: boolean
  changeCandidateState: ReturnType<typeof useLiteratureCandidates>['changeCandidateState']
  restoreDismissedCandidates: ReturnType<
    typeof useLiteratureCandidates
  >['restoreDismissedCandidates']
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog.Root
      open={selectedCandidate !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {selectedCandidate ? (
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            className={dialogPanelClassName('flex w-[min(620px,calc(100vw-2rem))] flex-col p-0')}
          >
            <div className={cn(dialogHeaderClassName, 'px-5 py-3')}>
              <div className="min-w-0">
                <Dialog.Title className={cn(dialogTitleClassName, 'truncate')}>
                  {selectedCandidate.candidate.item.title}
                </Dialog.Title>
                <Dialog.Description
                  className={cn(dialogDescriptionClassName, 'mt-0.5 truncate text-xs')}
                >
                  {itemDescription(selectedCandidate.candidate.item) ||
                    itemTypeLabels[selectedCandidate.candidate.item.itemType]}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={dialogCloseButtonClassName}
                  aria-label={t('Close')}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>
            <div className="relative min-h-0 max-h-[70vh] divide-y divide-border-300/80 overflow-y-auto px-5 text-sm">
              {projectNames.length > 0 ? (
                <p className="py-4 text-sm leading-6 text-muted-foreground">
                  {t('Accepting will link to: {{projects}}', {
                    projects: projectNames.join(', ')
                  })}
                </p>
              ) : null}
              {selectedCandidate.candidate.item.abstract ? (
                <section className="py-4">
                  <h3 className="font-medium">{t('Abstract')}</h3>
                  <p className="mt-2 whitespace-pre-wrap leading-6 text-muted-foreground">
                    {selectedCandidate.candidate.item.abstract}
                  </p>
                </section>
              ) : null}
              {selectedCandidate.pdfs?.length ? (
                <section className="py-4">
                  <h3 className="font-medium">{t('Attachments')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('PDFs will be attached when you accept this reference.')}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {selectedCandidate.pdfs.map((pdf) => (
                      <li key={pdf.id} className="text-xs">
                        <p className="break-words">{pdf.filename}</p>
                        <ExternalTextLink href={pdf.sourceUrl} className="text-xs">
                          {t('Open source')}
                        </ExternalTextLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section className="py-4">
                <h3 className="font-medium">{t('Provider')}</h3>
                <p className="mt-1 text-muted-foreground">
                  {inboxProviderLabel(selectedCandidate.candidate.source.provider)}
                </p>
                {selectedCandidate.candidate.source.sourceUrl ? (
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {getExternalLiteratureUrl(selectedCandidate.candidate.source.sourceUrl) ? (
                      <ExternalTextLink href={selectedCandidate.candidate.source.sourceUrl}>
                        {selectedCandidate.candidate.source.sourceUrl}
                      </ExternalTextLink>
                    ) : (
                      selectedCandidate.candidate.source.sourceUrl
                    )}
                  </p>
                ) : null}
              </section>
              {selectedCandidate.candidate.item.identifiers.length > 0 ? (
                <section className="py-4">
                  <h3 className="font-medium">{t('Identifiers')}</h3>
                  <dl className="mt-2 space-y-2">
                    {selectedCandidate.candidate.item.identifiers.map((identifier) => {
                      const value = normalizeLiteratureIdentifierValue(
                        identifier.scheme,
                        identifier.value
                      )
                      const href = createLiteratureIdentifierUrl(identifier.scheme, value)
                      return (
                        <div
                          key={`${identifier.scheme}:${identifier.value}`}
                          className="flex gap-3"
                        >
                          <dt className="w-16 shrink-0 uppercase text-muted-foreground">
                            {identifier.scheme}
                          </dt>
                          <dd className="min-w-0 break-all">
                            {href ? (
                              <ExternalTextLink
                                href={href}
                                aria-label={`${identifier.scheme.toUpperCase()}: ${value}`}
                              >
                                {value}
                              </ExternalTextLink>
                            ) : (
                              value
                            )}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>
                </section>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-border-300/80 px-5 py-4">
              {selectedCandidate.state === 'dismissed' ? (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void restoreDismissedCandidates([selectedCandidate.id]).then((restored) => {
                      if (restored) onClose()
                    })
                  }
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  {t('Restore')}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || entriesFailed}
                    onClick={() => {
                      void changeCandidateState(selectedCandidate.id, 'dismiss-candidate').then(
                        (updated) => {
                          if (updated) onClose()
                        }
                      )
                    }}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                    {t('Dismiss')}
                  </Button>
                  <Button
                    type="button"
                    disabled={busy || entriesFailed}
                    onClick={() => {
                      void changeCandidateState(selectedCandidate.id, 'accept-candidate').then(
                        (updated) => {
                          if (updated) onClose()
                        }
                      )
                    }}
                  >
                    <Check className="size-3.5" aria-hidden="true" />
                    {t('Accept')}
                  </Button>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  )
}
