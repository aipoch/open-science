import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type {
  ManagedFileVersionDescriptor,
  ManagedFileVersionInspectResult
} from '../../../../shared/managed-file-versions'

export function VersionCleanupDialog({
  inspect,
  tooltipClassName,
  onPreview,
  onDeleted
}: {
  inspect: ManagedFileVersionInspectResult
  tooltipClassName?: string
  onPreview: (version: ManagedFileVersionDescriptor) => void
  onDeleted: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<ManagedFileVersionDescriptor[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<'load' | 'delete' | number>()
  const [reload, setReload] = useState(0)
  const { source, projectId, fileId } = inspect
  const prepareHistoryLoad = (): void => {
    setLoading(true)
    setError(undefined)
    setVersions([])
    setSelected(new Set())
    setConfirm(false)
  }
  useEffect(() => {
    if (!open) return
    let active = true
    void (async () => {
      const collected: ManagedFileVersionDescriptor[] = []
      let cursor: string | undefined
      do {
        const result = await window.api.managedFileVersions.inspect({
          source,
          projectId,
          fileId,
          cursor
        })
        if (!active) return
        if (!result.ok) throw new Error(result.error.message)
        collected.push(...result.value.versions.filter((v) => v.id !== result.value.headVersionId))
        cursor = result.value.nextCursor
      } while (cursor)
      setVersions(collected.sort((a, b) => b.versionNumber - a.versionNumber))
    })()
      .catch(() => {
        if (active) setError('load')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, source, projectId, fileId, reload])
  if (
    typeof window.api.managedFileVersions?.deleteVersions !== 'function' ||
    inspect.unavailableReason === 'PROJECT_NOT_WRITABLE' ||
    inspect.unavailableReason === 'FILE_DELETED'
  )
    return null
  const selectedVersions = versions.filter((v) => selected.has(v.id))
  const size = (selectedVersions.reduce((sum, v) => sum + v.sizeBytes, 0) / 1024 / 1024).toFixed(2)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.api.managedFileVersions.deleteVersions({
        source,
        projectId,
        fileId,
        versionIds: [...selected]
      })
      if (!result.ok) {
        if (result.error.code === 'VERSION_IN_USE' && result.error.versionNumber !== undefined) {
          setConfirm(false)
          setError(result.error.versionNumber)
          return
        }
        throw new Error(result.error.message)
      }
      setOpen(false)
      onDeleted()
    } catch {
      setError('delete')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (busy) return
        if (value) prepareHistoryLoad()
        setOpen(value)
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <Dialog.Trigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-text-000 hover:text-text-000"
                aria-label={t('Select versions to delete')}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </Dialog.Trigger>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>
            {t('Select versions to delete')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 flex max-h-[80vh] w-[min(36rem,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border-300 bg-bg-000 p-5 shadow-xl">
          <Dialog.Title className="font-semibold">{t('Select versions to delete')}</Dialog.Title>
          <Dialog.Description className="text-sm text-text-200">
            {t(
              'The latest version is retained. Deleted content cannot be restored, and links to these versions in earlier messages will no longer open.'
            )}
          </Dialog.Description>
          <p className="truncate text-sm">{inspect.displayName}</p>
          {error && (
            <ErrorNotice
              title={
                typeof error === 'number'
                  ? t('Version {{number}} is in use. Deselect it to continue.', { number: error })
                  : error === 'load'
                    ? t('Could not load version history.')
                    : t('Failed to delete file versions')
              }
              primaryButton={
                error === 'load'
                  ? {
                      label: t('Retry'),
                      onClick: () => {
                        prepareHistoryLoad()
                        setReload((value) => value + 1)
                      }
                    }
                  : undefined
              }
            />
          )}
          {loading ? (
            <p>{t('Loading…')}</p>
          ) : (
            <div className="min-h-0 overflow-auto">
              {versions.map((version) => (
                <label
                  key={version.id}
                  className="flex items-center gap-3 border-b border-border-300 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    disabled={busy || confirm}
                    checked={selected.has(version.id)}
                    onChange={(event) => {
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (event.target.checked) next.add(version.id)
                        else next.delete(version.id)
                        return next
                      })
                    }}
                    aria-label={t('Version {{number}}', { number: version.versionNumber })}
                  />
                  <span>{t('Version {{number}}', { number: version.versionNumber })}</span>
                  <time className="flex-1" dateTime={version.createdAt}>
                    {new Date(version.createdAt).toLocaleString()}
                  </time>
                  <span>
                    {new Intl.NumberFormat(undefined, {
                      style: 'unit',
                      unit: 'kilobyte',
                      maximumFractionDigits: 1
                    }).format(version.sizeBytes / 1024)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false)
                      onPreview(version)
                    }}
                  >
                    {t('Preview')}
                  </Button>
                </label>
              ))}
            </div>
          )}
          <p className="text-sm">
            {t('Selected versions: {{total}} ({{size}} MB)', { total: selected.size, size })}
          </p>
          {confirm && <p className="text-sm">{t('Permanently delete the selected versions?')}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (confirm) setConfirm(false)
                else setOpen(false)
              }}
            >
              {t('Cancel')}
            </Button>
            <Button
              disabled={busy || loading || selected.size === 0}
              onClick={() => {
                if (confirm) void remove()
                else setConfirm(true)
              }}
            >
              {t('Delete selected versions')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
