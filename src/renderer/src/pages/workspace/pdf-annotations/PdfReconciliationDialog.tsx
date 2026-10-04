import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { LiteratureImportDialogFrame } from '../../literature/imports/LiteratureImportDialogFrame'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTagStore } from '@/stores/tag-store'
import { tagPresentation } from '../../settings/tag-presentation'
import type {
  PdfAnnotationSource,
  PdfSharingDecision,
  PdfSharingPreview
} from '../../../../../shared/pdf-annotations'

export function PdfReconciliationDialog({
  source,
  onChanged
}: {
  source: PdfAnnotationSource
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tags = useTagStore((state) => state.tags)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PdfSharingPreview>()
  const [decisions, setDecisions] = useState<Record<string, PdfSharingDecision['choice']>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const review = async (commit = false): Promise<void> => {
    setOpen(true)
    setBusy(true)
    setError('')
    try {
      const result = await window.api.pdfAnnotations.reconcile({
        source,
        ...(commit && preview ? { token: preview.token } : {}),
        decisions: commit ? Object.entries(decisions).map(([key, choice]) => ({ key, choice })) : []
      })
      setDecisions({})
      if (!result || result.committed) {
        onChanged()
        setOpen(false)
        setPreview(undefined)
      } else setPreview(result)
    } catch {
      setPreview(undefined)
      setError(
        t('Notes changed or the source is unavailable. Review the current notes before retrying.')
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void review()}>
        {t('Resolve historical note conflicts')}
      </Button>
      {open ? (
        <LiteratureImportDialogFrame
          title={t('Resolve historical note conflicts')}
          description={t('These notes have conflicting edits or deletions. Choose what to keep.')}
          busy={busy}
          onClose={() => setOpen(false)}
          footer={
            <Button
              disabled={busy || !!preview?.conflicts.some((conflict) => !decisions[conflict.key])}
              onClick={() => void review(!!preview)}
            >
              {preview ? t('Apply choices') : t('Retry')}
            </Button>
          }
        >
          <div className="space-y-3 overflow-y-auto p-5">
            {preview?.conflicts.map((conflict) => (
              <div key={conflict.key} className="space-y-2 rounded-md border border-border p-3">
                {conflict.unknown ? (
                  <p className="text-sm">
                    {t(
                      'This historical annotation has no verifiable original identity. Choose how to retain it.'
                    )}
                  </p>
                ) : null}
                {[conflict.left, conflict.right].map((entry, index) => (
                  <div key={index} className="space-y-1 text-sm">
                    <p className="font-medium">
                      {index === 0 ? t('Existing notes') : t('Historical notes')}
                    </p>
                    <p className="whitespace-pre-wrap">
                      {entry ? entry.note || t('No comment') : t('Deleted or not imported')}
                    </p>
                    {entry ? (
                      <>
                        {entry.pageNumber ? (
                          <p>{t('Page {{page}}', { page: entry.pageNumber })}</p>
                        ) : null}
                        <p className="whitespace-pre-wrap text-muted-foreground">{entry.quote}</p>
                        {entry.color ? (
                          <p>
                            {
                              {
                                yellow: t('Yellow'),
                                blue: t('Blue'),
                                green: t('Green'),
                                pink: t('Pink'),
                                purple: t('Purple')
                              }[entry.color]
                            }
                          </p>
                        ) : null}
                        <p>
                          {entry.tagIds
                            .map((id) => {
                              const tag = tags.find((tag) => tag.id === id)
                              return tag ? tagPresentation(tag, t).name : id
                            })
                            .join(', ')}
                        </p>
                      </>
                    ) : null}
                  </div>
                ))}
                <Select
                  value={decisions[conflict.key] ?? ''}
                  disabled={busy}
                  onValueChange={(choice) =>
                    setDecisions((current) => ({
                      ...current,
                      [conflict.key]: choice as PdfSharingDecision['choice']
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('Resolve annotation conflict')}>
                    <SelectValue placeholder={t('Choose what to keep')} />
                  </SelectTrigger>
                  <SelectContent>
                    {conflict.left ? (
                      <SelectItem value="left">{t('Keep existing note')}</SelectItem>
                    ) : null}
                    {conflict.right ? (
                      <SelectItem value="right">{t('Keep historical note')}</SelectItem>
                    ) : null}
                    {conflict.left && conflict.right ? (
                      <SelectItem value="both">{t('Keep both as separate notes')}</SelectItem>
                    ) : null}
                    <SelectItem value="delete">{t('Keep deleted')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </LiteratureImportDialogFrame>
      ) : null}
    </>
  )
}
