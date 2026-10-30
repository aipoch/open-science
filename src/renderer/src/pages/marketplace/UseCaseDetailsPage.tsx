import { useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  UseCaseDetailsContent,
  type UseCaseDetailsContentProps
} from '../home/UseCaseDetailsContent'

export const UseCaseDetailsPage = ({
  onBack,
  ...props
}: UseCaseDetailsContentProps & { onBack: () => void }): React.JSX.Element => {
  const { t } = useTranslation()
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true })
  }, [])
  return (
    <section
      aria-label={t('Case details')}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="shrink-0 px-4 py-1">
        <Button ref={backRef} variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('Back to list')}
        </Button>
      </div>
      <UseCaseDetailsContent {...props} />
    </section>
  )
}
