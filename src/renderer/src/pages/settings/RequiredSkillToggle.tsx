import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsToggle } from './SettingsLayout'

type RequiredSkillToggleProps = {
  label: string
}

const RequiredSkillToggle = ({ label }: RequiredSkillToggleProps): React.JSX.Element => {
  const { t } = useTranslation()
  const explanation = t(
    'This built-in Skill supports core application features and is always enabled.'
  )

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex cursor-default"
            tabIndex={0}
            aria-label={explanation}
            data-testid="required-skill-toggle-tooltip"
          >
            <SettingsToggle
              enabled
              disabled
              aria-label={label}
              className="pointer-events-none"
              onToggle={() => undefined}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs leading-relaxed">
          {explanation}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { RequiredSkillToggle }
