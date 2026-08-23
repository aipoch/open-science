/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { ZoomIn, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from 'radix-ui'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { NotebookRunRecord } from '../../../../shared/notebook'

import {
  formatNotebookFigureFilename,
  resolveNotebookRunFigures,
  type NotebookRunFigure
} from './notebook-run-figures'

type NotebookToolFigureOutputsProps = {
  run: NotebookRunRecord
}

// Transcript-only figure treatment. It deliberately sits beside the tool row rather than inside
// that row's detail panel, so the row can collapse without hiding the result. The owning tool group
// still controls whether this subtree exists.
const NotebookToolFigureOutputs = ({
  run
}: NotebookToolFigureOutputsProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const figures = resolveNotebookRunFigures(run)
  const [selectedFigure, setSelectedFigure] = useState<NotebookRunFigure>()
  const dialogFigure = useRetainedDialogValue(selectedFigure)

  if (figures.length === 0) return null

  const selectedFilename = dialogFigure ? formatNotebookFigureFilename(dialogFigure, t) : undefined

  return (
    <>
      <div
        className="mx-1 mb-1.5 mt-1.5 space-y-2 md:ml-[30px]"
        data-testid="notebook-tool-figure-outputs"
      >
        {figures.map((figure) => {
          const filename = formatNotebookFigureFilename(figure, t)

          return (
            <button
              key={figure.key}
              type="button"
              data-testid="notebook-tool-figure-button"
              className="group relative block w-full cursor-zoom-in overflow-hidden rounded-xl border border-border-200 bg-bg-000 text-left shadow-sm transition-[border-color,transform] duration-150 ease-out hover:border-border-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none motion-reduce:active:translate-y-0"
              aria-label={t('Preview {{name}}', { name: filename })}
              onClick={() => setSelectedFigure(figure)}
            >
              <span className="flex min-h-36 w-full items-center justify-center p-3 sm:p-4">
                <img
                  data-testid="notebook-tool-figure-image"
                  src={`data:${figure.mimeType};base64,${figure.payload}`}
                  alt={filename}
                  className="block max-h-[32rem] max-w-full object-contain"
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              </span>
              <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-3 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-4 pb-3 pt-16 text-white opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-5">
                  {filename}
                </span>
                <ZoomIn className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              </span>
            </button>
          )
        })}
      </div>

      <Dialog.Root
        open={Boolean(selectedFigure)}
        onOpenChange={(open) => {
          if (!open) setSelectedFigure(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className={`${dialogOverlayClassName} z-[70] !bg-black/75 backdrop-blur-[1px]`}
          />
          <Dialog.Content
            aria-describedby={undefined}
            data-testid="notebook-figure-preview-dialog"
            className={dialogPanelClassName(
              'z-[70] flex max-h-[94vh] w-[min(94vw,96rem)] max-w-none flex-col overflow-visible border-0 bg-transparent p-0 text-white shadow-none'
            )}
          >
            <Dialog.Title className="sr-only">
              {selectedFilename
                ? t('Preview {{name}}', { name: selectedFilename })
                : t('File preview')}
            </Dialog.Title>
            {dialogFigure ? (
              <figure className="min-h-0">
                <div className="relative flex max-h-[88vh] min-h-40 items-center justify-center overflow-hidden rounded-xl bg-bg-000 shadow-dialog">
                  <img
                    data-testid="notebook-figure-preview-image"
                    src={`data:${dialogFigure.mimeType};base64,${dialogFigure.payload}`}
                    alt={selectedFilename}
                    className="block max-h-[88vh] max-w-full object-contain"
                    draggable={false}
                  />
                  <Dialog.Close
                    type="button"
                    aria-label={t('Close preview')}
                    title={t('Close preview')}
                    className="absolute right-2 top-2 flex size-11 cursor-pointer items-center justify-center rounded-lg bg-black/65 text-white transition-colors duration-150 ease-out hover:bg-black/80 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/70 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none motion-reduce:active:translate-y-0"
                  >
                    <X className="size-5" strokeWidth={1.8} aria-hidden="true" />
                  </Dialog.Close>
                </div>
                <figcaption className="mt-3 flex min-w-0 items-center justify-center gap-2 px-2 font-mono text-[11px] text-white/75">
                  <span className="truncate text-white/90">{selectedFilename}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">{t('Esc to close')}</span>
                </figcaption>
              </figure>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

export { NotebookToolFigureOutputs }
