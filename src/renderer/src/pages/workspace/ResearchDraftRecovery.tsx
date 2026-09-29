import { useRef, useState } from 'react'
import { ErrorNotice } from '@/components/error-notice'
import { useTranslation } from 'react-i18next'
import type { ResearchDraftRecoveryProps } from './use-research-draft-recovery'
export const ResearchDraftRecovery = ({
  drafts,
  saving,
  error,
  onRestore,
  onDiscard,
  onRefresh
}: ResearchDraftRecoveryProps): React.JSX.Element => {
  const { t } = useTranslation()
  const busy = useRef(false)
  const [pending, setPending] = useState<string>()
  const act = async (id: string, action: () => Promise<void>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setPending(id)
    try {
      await action()
    } finally {
      busy.current = false
      setPending(undefined)
    }
  }
  return (
    <div className="space-y-2 px-3 py-2 text-xs text-muted-foreground">
      <p role="status">
        {saving ? t('Saving research draft…') : t('Research drafts are saved on this device.')}
      </p>
      {error ? <ErrorNotice tone="amber" description={error} /> : null}
      {drafts.length ? (
        <details>
          <summary className="cursor-pointer">{t('Recover saved research drafts')}</summary>
          <ul className="mt-2 space-y-2">
            {drafts.map((draft) => (
              <li key={draft.id} className="rounded border border-border-200 p-2">
                <p className="line-clamp-2 whitespace-pre-wrap">
                  {draft.payload.doc.nodes
                    .map((node) =>
                      node.type === 'text' || node.type === 'pasted-text' ? node.text : ''
                    )
                    .join('') || t('Draft with attachments or references')}
                </p>
                <p>
                  {draft.payload.attachments
                    .map((file) => file.originalName || file.name)
                    .join(', ')}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-border-200 px-2 py-1"
                    disabled={pending !== undefined}
                    onClick={() => void act(draft.id, () => onRestore(draft))}
                  >
                    {t('Restore draft')}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-border-200 px-2 py-1"
                    disabled={pending !== undefined}
                    onClick={() => void act(draft.id, () => onDiscard(draft))}
                  >
                    {t('Discard draft')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <button type="button" className="underline" onClick={onRefresh}>
        {t('Check for saved drafts')}
      </button>
    </div>
  )
}
