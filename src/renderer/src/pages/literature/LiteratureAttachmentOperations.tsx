import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseLiteratureDeletionError } from '../../../../shared/literature-deletion'
import { LiteratureDeletionNotice } from './LiteratureDeletionNotice'
import type { LiteratureDetailController } from './LiteratureDetailController'
import {
  useAttachmentOperations,
  type AttachmentOperation
} from './literature-attachment-operations'

export function AttachmentOperationStatus({
  operation
}: {
  operation: AttachmentOperation
}): React.JSX.Element {
  const { t } = useTranslation()
  const diagnostic = parseLiteratureDeletionError(operation.error)
  if (diagnostic) return <LiteratureDeletionNotice diagnostic={diagnostic} />
  const message = operation.pending
    ? operation.action === 'verify'
      ? t('Verifying file…')
      : t('Removing attachment…')
    : operation.error
      ? t('The attachment operation failed. Try again.')
      : operation.receipt?.cleanupPending
        ? t('Attachment removed. Storage cleanup could not finish.')
        : operation.refreshFailed
          ? t(
              'The attachment operation completed, but details could not be refreshed. Reopen this reference.'
            )
          : operation.action === 'verify'
            ? t('File integrity verified')
            : t('Attachment removed.')
  const warning = !!operation.error || operation.receipt?.cleanupPending || operation.refreshFailed
  return (
    <p
      role={warning ? 'alert' : 'status'}
      title={message}
      className={`min-w-0 truncate text-sm ${warning ? 'text-danger-000' : 'text-muted-foreground'}`}
    >
      {operation.pending ? (
        <LoaderCircle
          className="mr-1 inline size-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      {message}
    </p>
  )
}

export function LiteratureAttachmentOperations({
  detailController,
  onChanged
}: {
  detailController: LiteratureDetailController
  onChanged: (operation: AttachmentOperation) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const detailItemId = useSyncExternalStore(
    detailController.subscribe,
    detailController.getSnapshot
  ).item?.id
  const operations = useAttachmentOperations((state) => state.operations)
  const receive = useEffectEvent(onChanged)
  useEffect(
    () =>
      useAttachmentOperations.subscribe((state, previous) => {
        state.operations.forEach((operation) => {
          if (!operation.pending && !previous.operations.includes(operation)) receive(operation)
        })
      }),
    []
  )
  return (
    <div className="space-y-2">
      {operations
        .filter((operation) => operation.itemId !== detailItemId)
        .map((operation) => (
          <div
            key={`${operation.itemId}:${operation.attachmentId}`}
            className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <p className="truncate text-sm font-medium">{operation.title}</p>
              <AttachmentOperationStatus operation={operation} />
            </div>
            {!operation.pending ? (
              <button
                type="button"
                aria-label={t('Dismiss attachment result for {{title}}', {
                  title: operation.title
                })}
                className="rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => useAttachmentOperations.getState().dismiss(operation)}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
    </div>
  )
}
