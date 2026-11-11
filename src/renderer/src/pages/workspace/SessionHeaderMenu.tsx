import type { ResearchVideoTriggerState } from '@/components/research-video-button'
import { Ellipsis, MessageCircleMore, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  ActionMenuItems,
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenuTarget,
  type ActionMenuRecipeEntry
} from '@/components/action-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  SESSION_ACTION_CATALOG,
  type createSessionActionBindings,
  type SessionActionInvocation
} from './session-action-menu'
import { projectPresentedSessionActionability } from './session-wait-reason'

const catalog = {
  ...SESSION_ACTION_CATALOG,
  'new-side-chat': { labelKey: 'New side chat', icon: MessageCircleMore },
  'research-explanation': { labelKey: 'Research film', icon: Video }
}
const recipe = [
  { kind: 'action', action: 'edit' },
  { kind: 'action', action: 'toggle-pin' },
  { kind: 'separator' },
  { kind: 'action', action: 'new-side-chat' },
  { kind: 'action', action: 'fork' },
  { kind: 'action', action: 'research-explanation' },
  { kind: 'separator' },
  {
    kind: 'submenu',
    labelKey: 'Export',
    icon: SESSION_ACTION_CATALOG.export.icon,
    actions: ['export', 'export-package', 'export-diagnostics']
  },
  { kind: 'separator' },
  { kind: 'action', action: 'archive' }
] as const satisfies readonly ActionMenuRecipeEntry<keyof typeof catalog>[]

const MenuButton = (): React.JSX.Element => {
  const { t } = useTranslation()
  const { entries, execute, renderLabel } = useActionMenuTarget<keyof typeof catalog>()
  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="session-header-menu-trigger"
                aria-label={t('Session actions')}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 transition-colors hover:bg-surface-control-hover hover:text-text-000 focus-visible:keyboard-focus aria-expanded:bg-surface-control-hover aria-expanded:text-text-000"
              >
                <Ellipsis className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            {t('Session actions')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent
        data-testid="session-header-menu"
        aria-label={t('Session actions')}
        align="end"
        sideOffset={4}
        className="min-w-52"
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

export const SessionHeaderMenu = ({
  session,
  bindings,
  createSideChat,
  openResearchExplanation,
  researchVideoTriggerState,
  credentialPending = false,
  rootPermissionPending,
  disabledReason
}: {
  session: SessionActionInvocation['session']
  bindings?: Partial<ReturnType<typeof createSessionActionBindings>>
  createSideChat?: () => string | undefined
  openResearchExplanation?: () => void
  researchVideoTriggerState?: ResearchVideoTriggerState
  credentialPending?: boolean
  rootPermissionPending?: boolean
  disabledReason?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const invocation: SessionActionInvocation = {
    session,
    presentedStatus: projectPresentedSessionActionability(session, {
      credentialPending,
      rootPermissionPending
    }).presentedStatus
  }
  return (
    <ActionMenuProvider testId="session-header-context-menu" contentClassName="min-w-52">
      <ActionMenuTarget
        asChild
        targetId="session-header-menu"
        identityKey={session.id}
        invocation={invocation}
        catalog={catalog}
        recipe={recipe}
        bindings={{
          ...bindings,
          ...(openResearchExplanation
            ? {
                'research-explanation': {
                  execute: openResearchExplanation,
                  disabled: Boolean(researchVideoTriggerState?.disabledReason),
                  disabledDescription: researchVideoTriggerState?.disabledReason
                }
              }
            : {}),
          'new-side-chat': {
            execute: () => {
              createSideChat?.()
            },
            disabled: Boolean(disabledReason) || !createSideChat,
            disabledDescription: disabledReason
          }
        }}
        compact={false}
        renderLabel={(entry, label) =>
          entry.action === 'research-explanation'
            ? (researchVideoTriggerState?.label ?? label)
            : entry.action === 'archive'
              ? t('Archive', { context: 'verb' })
              : label
        }
      >
        <span className="contents">
          <MenuButton key={session.id} />
        </span>
      </ActionMenuTarget>
    </ActionMenuProvider>
  )
}
