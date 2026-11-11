import { Ellipsis, Video } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActionMenuItems,
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenuTarget,
  type ActionMenuRecipeEntry
} from './action-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { Button } from './ui/button'
import { ResearchVideoButton } from './research-video-button'
import type { ResearchVideoPresentationRequest } from '../../../shared/research-video-presentation'

const catalog = { film: { labelKey: 'Generate research film', icon: Video } }
const recipe = [
  { kind: 'action', action: 'film' }
] as const satisfies readonly ActionMenuRecipeEntry<keyof typeof catalog>[]

function Menu({ onOpen }: { onOpen?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const pointerDismissal = useRef(false)
  const { entries, execute, renderLabel } = useActionMenuTarget<keyof typeof catalog>()
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen?.()
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (pointerDismissal.current || !event.currentTarget.matches(':focus-visible'))
                event.preventDefault()
              pointerDismissal.current = false
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('More actions')}>
                <Ellipsis size={16} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('More actions')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent
        align="end"
        onPointerDownCapture={() => (pointerDismissal.current = true)}
        onKeyDownCapture={() => (pointerDismissal.current = false)}
        onPointerDownOutside={() => (pointerDismissal.current = true)}
      >
        <ActionMenuItems
          entries={entries}
          onSelect={(id) => void execute(id)}
          compact={false}
          renderLabel={renderLabel}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ResearchVideoMenu({
  onOpen,
  ...request
}: ResearchVideoPresentationRequest & { onOpen?: () => void }): React.JSX.Element {
  return (
    <ResearchVideoButton
      {...request}
      renderTrigger={(open, state) =>
        open ? (
          <ActionMenuProvider>
            <ActionMenuTarget
              asChild
              targetId="replay-research-film-menu"
              identityKey={JSON.stringify(request)}
              invocation={request}
              catalog={catalog}
              recipe={recipe}
              compact={false}
              bindings={{
                film: {
                  execute: open,
                  disabled: Boolean(state.disabledReason),
                  disabledDescription: state.disabledReason
                }
              }}
              renderLabel={() => state.label}
            >
              <span className="contents">
                <Menu onOpen={onOpen} />
              </span>
            </ActionMenuTarget>
          </ActionMenuProvider>
        ) : null
      }
    />
  )
}
