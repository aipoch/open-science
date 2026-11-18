import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { InlineNotice } from '@/components/ui/inline-notice'
import { ImageErrorNotice } from '@/components/image-error-notice'
import type {
  ImageModelTestRequest,
  ImageModelTestResult
} from '../../../../shared/image-model-settings'

export function ImageServiceTest({
  request,
  disabled
}: {
  request: ImageModelTestRequest
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const [testing, setTesting] = useState(false)
  const pending = useRef(false)
  const testButton = useRef<HTMLButtonElement>(null)
  const testRegion = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const [tested, setTested] = useState<{ draft: string; result: ImageModelTestResult }>()
  // Include credentials and every destination/model field: a result proves only this exact draft.
  const draft = JSON.stringify(request)
  if (tested && tested.draft !== draft) setTested(undefined)
  useEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [draft])
  const result = tested?.draft === draft ? tested.result : undefined
  const model = request.models[0]
  const test = async (): Promise<void> => {
    if (pending.current || disabled) return
    pending.current = true
    const token = generation.current
    setTesting(true)
    setConfirm(false)
    setTested(undefined)
    try {
      const result = await window.api.settings.testImageModel(request)
      if (token === generation.current) setTested({ draft, result })
    } catch {
      // Losing the RPC response does not prove the provider did not process the request.
      if (token === generation.current)
        setTested({ draft, result: { ok: false, error: { code: 'OUTCOME_UNKNOWN' } } })
    } finally {
      pending.current = false
      setTesting(false)
    }
  }
  return (
    <div ref={testRegion} tabIndex={-1} className="space-y-3 px-5 pb-3">
      <Button
        ref={testButton}
        type="button"
        variant="outline"
        disabled={disabled || testing}
        onClick={() => setConfirm(true)}
      >
        {testing ? t('Testing…') : t('Test generation')}
      </Button>
      {result?.ok && (
        <InlineNotice level="success" role="status">
          {t('Image generation test passed.')}
        </InlineNotice>
      )}
      {result && !result.ok && <ImageErrorNotice error={result.error} />}
      <ConfirmActionDialog
        open={confirm}
        title={t('Test image generation?')}
        description={t(
          'Generate one test image with {{model}}. Your provider may charge for this request.',
          { model: model?.label ?? model?.wireModelId ?? '' }
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Test generation')}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void test()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const button = testButton.current
          ;(button && !button.disabled ? button : testRegion.current)?.focus()
        }}
      />
    </div>
  )
}
