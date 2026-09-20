import { Redo2, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'
import { usePdfAnnotations } from './pdf-annotations-context'

export const PdfAnnotationHistoryControls = ({
  source,
  onError
}: {
  source: PdfAnnotationSource
  onError: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const annotations = usePdfAnnotations()
  const history = annotations.history(source)
  return (
    <TooltipProvider delayDuration={250}>
      <div role="group" aria-label={t('Annotation history')} className="flex items-center gap-0.5">
        {(
          [
            {
              direction: 'undo',
              label: t('Undo annotation change'),
              icon: Undo2,
              enabled: history.canUndo,
              emptyReason: t('No annotation changes to undo.')
            },
            {
              direction: 'redo',
              label: t('Redo annotation change'),
              icon: Redo2,
              enabled: history.canRedo,
              emptyReason: t('No annotation changes to redo.')
            }
          ] as const
        ).map(({ direction, label, icon: Icon, enabled, emptyReason }) => (
          <Tooltip key={direction}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={label}
                aria-disabled={!annotations.available || history.busy || !enabled}
                className={
                  !annotations.available || history.busy || !enabled
                    ? 'opacity-50 cursor-not-allowed'
                    : undefined
                }
                onClick={() => {
                  if (annotations.available && !history.busy && enabled)
                    void annotations[direction](source).catch(onError)
                }}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="z-[120]">
              {!annotations.available
                ? t('PDF annotations are unavailable for this source.')
                : history.busy
                  ? t('Saving…')
                  : !enabled
                    ? emptyReason
                    : label}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}
