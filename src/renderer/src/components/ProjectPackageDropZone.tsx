import { useRef, useState, type ComponentPropsWithRef } from 'react'
import { useTranslation } from 'react-i18next'
import { PackageOpen, X } from 'lucide-react'
import { Button } from './ui/button'
import { sessionPackageImportAvailable } from './session-package-import-menu-model'
import { importSessionPackage } from '@/lib/session-package-import'

type Props = ComponentPropsWithRef<'main'> & {
  projectId: string
  projectName: string
  canImport: boolean
}

// Capture package drops before nested attachment zones; ordinary files retain their own targets.
export const ProjectPackageDropZone = ({
  projectId,
  projectName,
  canImport,
  children,
  ...props
}: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string>()
  const isPageFileDrag = (event: React.DragEvent<HTMLElement>): boolean =>
    sessionPackageImportAvailable() &&
    event.currentTarget.contains(event.target as Node) &&
    Array.from(event.dataTransfer.types).includes('Files')
  const reset = (): void => {
    depth.current = 0
    setDragging(false)
  }
  return (
    <main
      {...props}
      onDragEnterCapture={(event) => {
        if (!isPageFileDrag(event)) return
        depth.current++
        setDragging(true)
      }}
      onDragOverCapture={(event) => {
        if (!isPageFileDrag(event)) return
        event.preventDefault()
      }}
      onDragLeaveCapture={(event) => {
        if (!isPageFileDrag(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDropCapture={(event) => {
        if (!isPageFileDrag(event)) return
        reset()
        const files = Array.from(event.dataTransfer.files)
        if (!files.some((file) => /\.science$/i.test(file.name))) return
        event.preventDefault()
        event.stopPropagation()
        if (files.length !== 1) {
          setNotice(t('Drop one .science file at a time. No files were added.'))
          return
        }
        if (!canImport || !projectId) {
          setNotice(t('This Project is unavailable for import.'))
          return
        }
        setNotice(undefined)
        void importSessionPackage(projectId, files[0])
      }}
      onDragEndCapture={reset}
    >
      {children}
      {(dragging || notice) && (
        <div className="pointer-events-none fixed inset-x-4 top-4 z-50 flex justify-center">
          <div
            role="status"
            className="flex max-w-xl items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground shadow-lg"
          >
            <PackageOpen className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 break-words">
              {notice ??
                t('Drop a .science file to import into “{{project}}”', { project: projectName })}
            </span>
            {notice && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="pointer-events-auto shrink-0"
                aria-label={t('Dismiss')}
                onClick={() => setNotice(undefined)}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
