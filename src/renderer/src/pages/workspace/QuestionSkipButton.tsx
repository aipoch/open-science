import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import {
  SplitButton,
  SplitButtonGroup,
  SplitButtonPrimary,
  SplitButtonTrigger,
  SplitButtonContent
} from '@/components/ui/split-button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

type QuestionSkipButtonProps = {
  disabled: boolean
  onSkip: () => void
  onSkipAll: () => void
}

export const QuestionSkipButton = ({
  disabled,
  onSkip,
  onSkipAll
}: QuestionSkipButtonProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoredEscapeFocus = useRef(false)
  if (disabled && open) setOpen(false)
  return (
    <SplitButton
      disabled={disabled}
      open={open}
      onOpenChange={(next) => {
        if (next) restoredEscapeFocus.current = false
        setOpen(next)
      }}
    >
      <SplitButtonGroup data-testid="question-skip-control" className="bg-secondary">
        <SplitButtonPrimary
          className="border-0 bg-transparent px-3 hover:bg-surface-control-hover focus-visible:z-10"
          variant="secondary"
          onClick={() => {
            setOpen(false)
            onSkip()
          }}
        >
          {t('Skip')}
        </SplitButtonPrimary>
        <SplitButtonTrigger
          ref={triggerRef}
          className="border-0 bg-transparent hover:bg-surface-control-hover focus-visible:z-10 aria-expanded:bg-transparent aria-expanded:hover:bg-surface-control-hover"
          variant="secondary"
          size="icon"
          aria-label={t('More skip options')}
        >
          <ChevronDown className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </SplitButtonTrigger>
      </SplitButtonGroup>
      <SplitButtonContent
        data-testid="question-skip-menu"
        className="scrollbar-auto-hide min-w-0 p-1"
        matchWidth
        side="bottom"
        align="end"
        collisionPadding={8}
        sticky="always"
        onEscapeKeyDown={() => {
          restoredEscapeFocus.current = true
          triggerRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (restoredEscapeFocus.current) event.preventDefault()
          restoredEscapeFocus.current = false
        }}
      >
        <DropdownMenuItem
          className="whitespace-normal break-words text-status-warning-foreground data-[highlighted]:bg-status-warning-surface data-[highlighted]:text-status-warning-foreground dark:text-status-warning-dark-foreground dark:data-[highlighted]:bg-status-warning-dark-surface dark:data-[highlighted]:text-status-warning-dark-foreground"
          disabled={disabled}
          onSelect={onSkipAll}
        >
          {t('Skip all')}
        </DropdownMenuItem>
      </SplitButtonContent>
    </SplitButton>
  )
}
