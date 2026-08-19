/* Hallmark · SpecialistAppearancePicker 8-state development preview; not mounted in production. */
import {
  SpecialistAppearancePicker,
  type AppearancePickerPreviewState
} from './SpecialistAppearancePicker'
import { useTranslation } from 'react-i18next'

const STATES: AppearancePickerPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const SpecialistAppearancePickerPreview = (): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="grid max-w-sm gap-3 bg-background p-5 text-foreground">
      <h1 className="text-base font-semibold">{t('Specialist appearance picker — 8 states')}</h1>
      {STATES.map((state) => (
        <div key={state} className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
          <span className="text-xs text-muted-foreground">{state}</span>
          <SpecialistAppearancePicker
            name={`${state} preview`}
            iconKey="microscope"
            colorKey="teal"
            disabled={state === 'disabled'}
            previewState={state}
            onChange={async () => undefined}
          />
        </div>
      ))}
    </div>
  )
}

export { SpecialistAppearancePickerPreview }
