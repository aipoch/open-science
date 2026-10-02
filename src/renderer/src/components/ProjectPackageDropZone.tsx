import { useState, type ComponentPropsWithRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from './ui/button'
import { FileDropOverlay } from './FileDropOverlay'
import { sessionPackageImportAvailable } from './session-package-import-menu-model'
import { importSessionPackage } from '@/lib/session-package-import'
import { useFileDropZone } from '@/hooks/useFileDropZone'

type Props = ComponentPropsWithRef<'section'> & {
  projectId: string
  projectName: string
  canImport: boolean
  canAttach?: boolean
  onFiles?: (files: File[]) => void
}

// One conversation-scoped owner routes native file drops before nested editors see them.
export const ProjectPackageDropZone = ({
  projectId,
  projectName,
  canImport,
  canAttach = false,
  onFiles,
  children,
  ...props
}: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const [notice, setNotice] = useState<string>()
  const importAvailable = sessionPackageImportAvailable()
  const importEnabled = importAvailable && canImport && Boolean(projectId)
  const { isDragging, dropZoneProps } = useFileDropZone({
    // Even a disabled target consumes native drops to prevent browser navigation.
    enabled: true,
    onFiles: (files) => {
      if (importAvailable && files.some((file) => /\.science$/i.test(file.name))) {
        if (files.length !== 1) {
          setNotice(t('Drop one .science file at a time. No files were added.'))
          return
        }
        if (!importEnabled) {
          setNotice(t('This Project is unavailable for import.'))
          return
        }
        setNotice(undefined)
        void importSessionPackage(projectId, files[0])
      } else if (canAttach && onFiles) {
        setNotice(undefined)
        onFiles(files)
      } else {
        setNotice(t('Files cannot be attached right now.'))
      }
    }
  })
  const isLocalFileDrag = (event: React.DragEvent<HTMLElement>): boolean =>
    event.currentTarget.contains(event.target as Node) &&
    Array.from(event.dataTransfer.types).includes('Files')

  return (
    <section
      {...props}
      onDragEnterCapture={(event) => {
        if (!isLocalFileDrag(event)) return
        dropZoneProps.onDragEnter(event)
      }}
      onDragOverCapture={(event) => {
        if (!isLocalFileDrag(event)) return
        dropZoneProps.onDragOver(event)
        if (!canAttach && !importEnabled) event.dataTransfer.dropEffect = 'none'
      }}
      onDragLeaveCapture={(event) => {
        if (isLocalFileDrag(event)) dropZoneProps.onDragLeave(event)
      }}
      onDropCapture={(event) => {
        if (!isLocalFileDrag(event)) return
        event.stopPropagation()
        dropZoneProps.onDrop(event)
      }}
    >
      {children}
      {isDragging && (canAttach || importEnabled) && (
        <FileDropOverlay
          label={
            canAttach
              ? importEnabled
                ? t('Drop files to attach or import a .science package')
                : t('Drop files to attach')
              : t('Drop a .science file to import into “{{project}}”', { project: projectName })
          }
          className="rounded-lg px-6 text-center"
        />
      )}
      {notice && (
        <div className="pointer-events-none absolute inset-x-4 top-4 z-30 flex justify-center">
          <div
            role="status"
            className="flex max-w-xl items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg"
          >
            <span className="min-w-0 break-words">{notice}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="pointer-events-auto shrink-0"
              aria-label={t('Dismiss')}
              onClick={() => setNotice(undefined)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
