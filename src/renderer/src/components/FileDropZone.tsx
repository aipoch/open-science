import { LoaderCircle, Upload } from 'lucide-react'
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { cn } from '@/lib/utils'
import { ErrorNotice } from './error-notice'
import { FileDropOverlay } from './FileDropOverlay'
import { Button } from './ui/button'

/** File intake presentation only; callers own validation, destinations, and transfers. */
export function FileDropZone({
  onFiles,
  dropLabel,
  disabled = false,
  busy = false,
  picker,
  children,
  className,
  'data-slot': slot = 'file-drop-zone'
}: {
  onFiles: (files: File[]) => void
  dropLabel: string
  disabled?: boolean
  busy?: boolean
  picker?: {
    label: string
    description: string
    accept: string
    multiple?: boolean
    inputRef?: RefObject<HTMLInputElement | null>
  }
  children?: ReactNode
  className?: string
  'data-slot'?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const ownInputRef = useRef<HTMLInputElement>(null)
  const inputRef = picker?.inputRef ?? ownInputRef
  const descriptionId = useId()
  const [directoryError, setDirectoryError] = useState(false)
  const enabled = !disabled && !busy
  const receive = (files: File[]): void => {
    if (!enabled || files.length === 0) return
    setDirectoryError(false)
    onFiles(files)
  }
  const { isDragging, dropZoneProps } = useFileDropZone({ enabled, onFiles: receive })
  const handleDrag =
    (name: keyof typeof dropZoneProps) =>
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!Array.from(event.dataTransfer.types ?? []).includes('Files')) return
      // React portals bubble through their owner; only the physical drop target may claim files.
      if (!event.currentTarget.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      if (!enabled || event.currentTarget.closest('[inert], [aria-hidden="true"]')) {
        event.dataTransfer.dropEffect = 'none'
        return
      }
      if (
        name === 'onDrop' &&
        Array.from(event.dataTransfer.items ?? []).some(
          (item) => item.webkitGetAsEntry?.()?.isDirectory
        )
      ) {
        setDirectoryError(true)
        return
      }
      dropZoneProps[name](event)
    }
  return (
    <div
      data-slot={slot}
      className={cn('relative min-w-0', className)}
      aria-busy={busy || undefined}
      onDragEnter={handleDrag('onDragEnter')}
      onDragOver={handleDrag('onDragOver')}
      onDragLeave={handleDrag('onDragLeave')}
      onDrop={handleDrag('onDrop')}
    >
      {isDragging ? <FileDropOverlay label={dropLabel} className="rounded-lg" /> : null}
      {picker ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3">
          {busy ? (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Upload className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <p id={descriptionId} className="min-w-0 flex-1 text-sm text-muted-foreground">
            {picker.description}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={!enabled}
            onClick={() => inputRef.current?.click()}
            aria-describedby={descriptionId}
          >
            {picker.label}
          </Button>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label={picker.label}
            accept={picker.accept}
            multiple={picker.multiple}
            disabled={!enabled}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              receive(files)
            }}
          />
        </div>
      ) : null}
      {directoryError ? (
        <ErrorNotice
          inline
          role="alert"
          tone="amber"
          description={t('Folders cannot be added. Choose files instead.')}
        />
      ) : null}
      {children}
    </div>
  )
}
