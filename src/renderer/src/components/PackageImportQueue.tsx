import { useState } from 'react'
import { ListOrdered } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { packageOperationActive } from '@/stores/package-operation-store'
import type {
  PackageOperationRequest,
  PackageOperationSnapshot
} from '../../../shared/session-package'

export const PackageImportQueue = ({
  operation,
  onAction
}: {
  operation: PackageOperationSnapshot
  onAction: (request: PackageOperationRequest) => Promise<void>
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const count = operation.pendingImports?.length ?? 0
  if (!count) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={
            operation.importQueueFull
              ? 'h-7 shrink-0 gap-1.5 px-2 text-status-warning-foreground dark:text-status-warning-dark-foreground'
              : 'h-7 shrink-0 gap-1.5 px-2 text-muted-foreground'
          }
          aria-label={`${t('Waiting packages')} (${count})`}
          title={`${t('Waiting packages')} (${count})`}
        >
          <ListOrdered className="size-4" aria-hidden="true" />
          <span className="text-xs tabular-nums">{count}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('Waiting packages')}
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-menu"
      >
        <h3 className="border-b border-border px-4 py-3 text-sm font-semibold">
          {t('Waiting packages')} ({count})
        </h3>
        {count ? (
          <ul className="max-h-56 overflow-y-auto p-2">
            {operation.pendingImports?.map((file) => (
              <li key={file.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate" title={file.filename}>
                  {file.filename}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void onAction({
                      action: 'discard-import',
                      operationId: operation.id,
                      requestId: file.id
                    })
                  }
                >
                  {t('Remove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {!packageOperationActive(operation) && !operation.cleanupPending && count ? (
          <div className="border-t border-border p-3">
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                setOpen(false)
                void onAction({ action: 'next-import', operationId: operation.id })
              }}
            >
              {t('Open next package')}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
