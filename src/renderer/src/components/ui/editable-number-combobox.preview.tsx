/* Hallmark · EditableNumberCombobox 8-state development preview; not mounted in production. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  EditableNumberCombobox,
  type EditableNumberComboboxPreviewState
} from './editable-number-combobox'

const STATES: EditableNumberComboboxPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const PRESETS = [32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000] as const

const PreviewRow = ({
  state
}: {
  state: EditableNumberComboboxPreviewState
}): React.JSX.Element => {
  const [value, setValue] = useState('200000')

  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
      <span className="text-xs text-muted-foreground">{state}</span>
      <EditableNumberCombobox
        id={`editable-number-combobox-${state}`}
        ariaLabel={state}
        value={value}
        presets={PRESETS}
        onValueChange={setValue}
        disabled={state === 'disabled'}
        previewState={state}
      />
    </div>
  )
}

const EditableNumberComboboxPreview = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div className="grid max-w-sm gap-3 bg-background p-5 text-foreground">
      <h1 className="text-base font-semibold">{t('Context window')}</h1>
      {STATES.map((state) => (
        <PreviewRow key={state} state={state} />
      ))}
    </div>
  )
}

export { EditableNumberComboboxPreview }
