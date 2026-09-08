import {
  parseLiteratureDeletionError,
  type LiteratureDeletionDiagnostic
} from '../../../../shared/literature-deletion'
import { LiteratureDeletionNotice } from './LiteratureDeletionNotice'
import { useRef, useState } from 'react'
import { FileText, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { LiteratureItemView } from '../../../../shared/literature'
import { formatBytes } from '../../../../shared/update'
import {
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenu,
  type ActionMenuDefinition,
  type ActionMenuRecipeEntry
} from '@/components/action-menu'

type Version = LiteratureItemView['attachments'][number]['versions'][number]
type AttachmentAction = 'verify' | 'remove'
const attachmentActionCatalog: Record<AttachmentAction, ActionMenuDefinition> = {
  verify: { labelKey: 'Retry file verification', icon: RotateCcw },
  remove: { labelKey: 'Remove attachment', icon: Trash2, danger: true }
}
const attachmentActionRecipe: readonly ActionMenuRecipeEntry<AttachmentAction>[] = [
  { kind: 'action', action: 'verify' },
  { kind: 'separator' },
  { kind: 'action', action: 'remove' }
]

const AttachmentMenuButton = ({
  targetId,
  title
}: {
  targetId: string
  title: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <button
      type="button"
      aria-label={t('Attachment actions for {{title}}', { title })}
      className="m-1 rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        openMenu({
          targetId,
          pointer: { x: bounds.left, y: bounds.bottom },
          focusTarget: event.currentTarget
        })
      }}
    >
      <MoreHorizontal className="size-4" aria-hidden="true" />
    </button>
  )
}

export const LiteratureAttachments = ({
  item,
  onChanged,
  onPreview
}: {
  item: LiteratureItemView
  onChanged: (item: LiteratureItemView) => void
  onPreview: (version: Version) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [error, setError] = useState<string>()
  const [deletionDiagnostic, setDeletionDiagnostic] = useState<LiteratureDeletionDiagnostic>()
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const run = async (
    action: AttachmentAction,
    attachmentId: string,
    versionId?: string
  ): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try {
      setError(undefined)
      setDeletionDiagnostic(undefined)
      const receipt = await window.api.literature.transact(
        action === 'remove'
          ? { kind: 'delete-attachment', itemId: item.id, attachmentId }
          : { kind: 'verify-attachment', itemId: item.id, versionId: versionId! }
      )
      if (action === 'remove') {
        // The command committed; preserve that result even if the subsequent refresh fails.
        onChanged({
          ...item,
          attachments: item.attachments.filter((entry) => entry.id !== attachmentId)
        })
      }
      if (receipt.cleanupPending)
        setError(t('Attachment removed. Storage cleanup could not finish.'))
      const updated = await window.api.literature.get(item.id).catch(() => undefined)
      if (updated) onChanged(updated)
      else
        setError(
          t(
            'The attachment operation completed, but details could not be refreshed. Reopen this reference.'
          )
        )
    } catch (error) {
      if (action === 'verify') {
        const updated = await window.api.literature.get(item.id).catch(() => undefined)
        if (updated) onChanged(updated)
      }
      throw error
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <ActionMenuProvider
      onActionError={(error) => {
        const diagnostic = parseLiteratureDeletionError(error)
        setDeletionDiagnostic(diagnostic)
        if (!diagnostic) setError(t('The attachment operation failed. Try again.'))
      }}
    >
      <div className="mt-2 space-y-2">
        {deletionDiagnostic ? <LiteratureDeletionNotice diagnostic={deletionDiagnostic} /> : null}
        {error ? (
          <p role="alert" className="text-sm text-danger-000">
            {error}
          </p>
        ) : null}
        {item.attachments.map((attachment) => {
          const version = attachment.versions[0]
          const title = version?.filename ?? attachment.title
          const targetId = `literature-attachment:${attachment.id}`
          const failure = version?.verificationFailure
          const health =
            version?.availability === 'unavailable'
              ? failure === 'missing'
                ? t('File missing')
                : [
                      'checksum-mismatch',
                      'size-mismatch',
                      'not-file',
                      'changed-during-verification'
                    ].includes(failure ?? '')
                  ? t('File damaged')
                  : t('File unavailable')
              : version?.availability === 'available'
                ? t('File integrity verified')
                : t('File integrity not yet verified')
          return (
            <ActionMenuTarget
              key={attachment.id}
              asChild
              targetId={targetId}
              identityKey={`${item.id}:${attachment.id}`}
              catalog={attachmentActionCatalog}
              recipe={attachmentActionRecipe}
              invocation={undefined}
              bindings={{
                verify: {
                  execute: () => run('verify', attachment.id, version?.id),
                  disabled: pending || !version
                },
                remove: { execute: () => run('remove', attachment.id), disabled: pending }
              }}
            >
              <div className="flex items-center rounded-lg border border-border bg-background">
                <button
                  type="button"
                  disabled={!version || version.availability === 'unavailable'}
                  aria-label={t('Preview {{title}}', { title })}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => version && onPreview(version)}
                >
                  <FileText className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{title}</span>
                    {version ? (
                      <span className="block text-xs text-muted-foreground">
                        {formatBytes(version.sizeBytes)}
                      </span>
                    ) : null}
                    <span
                      className={
                        version?.availability === 'unavailable'
                          ? 'block text-xs text-danger-000'
                          : 'block text-xs text-muted-foreground'
                      }
                    >
                      {health}
                    </span>
                    {version && !version.pageCount ? (
                      <span className="block text-xs text-muted-foreground">
                        {version.sizeBytes > 50 * 1024 * 1024
                          ? t('PDF not validated: exceeds the 50 MiB automatic processing limit.')
                          : t('PDF structure not yet validated.')}
                      </span>
                    ) : null}
                  </span>
                </button>
                <AttachmentMenuButton targetId={targetId} title={title} />
              </div>
            </ActionMenuTarget>
          )
        })}
      </div>
    </ActionMenuProvider>
  )
}
