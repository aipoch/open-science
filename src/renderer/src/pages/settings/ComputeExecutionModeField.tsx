import { useTranslation } from 'react-i18next'

import type { ComputeExecutionMode } from '../../../../shared/compute'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

const EXECUTION_MODES: ReadonlyArray<{
  mode: ComputeExecutionMode
  label: 'Direct SSH' | 'Slurm'
  description:
    | 'Run jobs and command calls directly on the SSH login host.'
    | 'Submit and manage jobs through Slurm; command calls still run on the SSH login host.'
}> = [
  {
    mode: 'direct_ssh',
    label: 'Direct SSH',
    description: 'Run jobs and command calls directly on the SSH login host.'
  },
  {
    mode: 'slurm',
    label: 'Slurm',
    description:
      'Submit and manage jobs through Slurm; command calls still run on the SSH login host.'
  }
]

type ComputeExecutionModeFieldProps = Readonly<{
  value: ComputeExecutionMode
  onChange(mode: ComputeExecutionMode): void
  name: string
}>

export function ComputeExecutionModeField({
  value,
  onChange,
  name
}: ComputeExecutionModeFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const selected = EXECUTION_MODES.find((option) => option.mode === value)!

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${name}-select`}>{t('Execution mode')}</Label>
      <Select
        name={name}
        value={value}
        onValueChange={(mode) => onChange(mode as ComputeExecutionMode)}
      >
        <SelectTrigger id={`${name}-select`} aria-label={t('Execution mode')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EXECUTION_MODES.map((option) => (
            <SelectItem key={option.mode} value={option.mode}>
              {t(option.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t(selected.description)}</p>
    </div>
  )
}
