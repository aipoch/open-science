import { Ellipsis, MessageCircleMore } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenu,
  type ActionMenuDefinition,
  type ActionMenuRecipeEntry
} from '@/components/action-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const catalog = {
  'new-side-chat': { labelKey: 'New side chat', icon: MessageCircleMore }
} satisfies Record<string, ActionMenuDefinition>
const recipe = [
  { kind: 'action', action: 'new-side-chat' }
] as const satisfies readonly ActionMenuRecipeEntry<keyof typeof catalog>[]
const targetId = 'session-header-menu'

const MenuButton = ({ expanded }: { expanded: boolean }): React.JSX.Element => {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          asChild
          onFocus={(event) => {
            if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
          }}
        >
          <button
            type="button"
            data-testid="session-header-menu-trigger"
            aria-label={t('Session actions')}
            aria-haspopup="menu"
            aria-expanded={expanded}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 transition-colors hover:bg-surface-control-hover hover:text-text-000 focus-visible:keyboard-focus aria-expanded:bg-surface-control-hover aria-expanded:text-text-000"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              openMenu({
                targetId,
                pointer: { x: rect.right, y: rect.bottom + 4 },
                align: 'end',
                focusTarget: event.currentTarget
              })
            }}
          >
            <Ellipsis className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          {t('Session actions')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export const SessionHeaderMenu = ({
  sessionId,
  createSideChat,
  disabledReason
}: {
  sessionId: string
  createSideChat?: () => string | undefined
  disabledReason?: string
}): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false)
  return (
    <ActionMenuProvider
      testId="session-header-menu"
      contentClassName="min-w-48"
      onOpenChange={(_, open) => setExpanded(open)}
    >
      <ActionMenuTarget
        asChild
        targetId={targetId}
        identityKey={sessionId}
        invocation={sessionId}
        catalog={catalog}
        recipe={recipe}
        bindings={{
          'new-side-chat': {
            execute: () => {
              createSideChat?.()
            },
            disabled: Boolean(disabledReason) || !createSideChat,
            disabledDescription: disabledReason
          }
        }}
        compact={false}
      >
        <span className="contents">
          <MenuButton expanded={expanded} />
        </span>
      </ActionMenuTarget>
    </ActionMenuProvider>
  )
}
