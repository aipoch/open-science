// Unified composer menu for per-session agent controls: permission profile + auto-review.
// Replaces the separate ComposerPermissionProfilePicker and ComposerAutoReviewToggle buttons
// with a single icon trigger. A primary-color dot on the trigger marks any deviation from the
// defaults (profile 'ask', auto-review off); session grants keep their own count pill.
// The first-level menu shows the current permission level as a borderless colored capsule
// (ask = neutral, auto = blue, full = warning amber); picking a level lives in a submenu.

import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import type { AcpPermissionGrant } from '../../../../shared/acp'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ScanEye,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { useState } from 'react'
import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

// Mirrors composerIconButtonClassName in ConversationPanel, but hugs the icon + grants pill.
const triggerButtonClassName =
  'relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-text-300 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50'

type ComposerAgentControlsMenuProps = {
  profile: PermissionProfileId
  profileState?: SessionPermissionProfileState
  grants?: AcpPermissionGrant[]
  autoReviewEnabled: boolean
  disabled?: boolean
  autoReviewDisabled?: boolean
  onProfileChange: (profile: PermissionProfileId) => void
  onAutoReviewChange: (enabled: boolean) => void
  onRevokeGrant?: (categoryKey: string) => void
  onClearGrants?: () => void
}

const permissionProfiles: Array<{
  id: PermissionProfileId
  label: string
  // Short label for the first-level capsule, where the full label would wrap.
  shortLabel: string
  description: string
  icon: typeof Shield
}> = [
  {
    id: 'ask',
    label: 'Ask for approval',
    shortLabel: 'Ask',
    description: 'Ask before file edits, commands, network, and MCP tools.',
    icon: Shield
  },
  {
    id: 'auto',
    label: 'Auto-approve edits',
    shortLabel: 'Auto',
    description:
      'Auto-approve edits to files in the workspace. Still ask before commands, network, and MCP.',
    icon: ShieldCheck
  },
  {
    id: 'full',
    label: 'Full access',
    shortLabel: 'Full access',
    description: 'Run everything without prompts, including commands and network.',
    icon: ShieldAlert
  }
]

// Borderless capsule colors per level: ask stays neutral, auto is blue, full warns in amber.
const profileCapsuleClassName: Record<PermissionProfileId, string> = {
  ask: 'bg-bg-200 text-text-100',
  auto: 'bg-blue-500/10 text-blue-600',
  full: 'bg-amber-500/10 text-amber-600'
}

const ComposerAgentControlsMenu = ({
  profile,
  profileState,
  grants,
  autoReviewEnabled,
  disabled = false,
  autoReviewDisabled = false,
  onProfileChange,
  onAutoReviewChange,
  onRevokeGrant,
  onClearGrants
}: ComposerAgentControlsMenuProps): React.JSX.Element => {
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const selectedProfile = permissionProfiles.find((candidate) => candidate.id === profile)!
  const SelectedIcon = selectedProfile.icon
  const fullAccessUnavailable = profileState?.fullAccessAvailable === false
  // Grants only apply while asking for approval; the count pill hints at active always-allows.
  const hasGrants = profile === 'ask' && (grants?.length ?? 0) > 0
  // Anything other than the defaults (ask + auto-review off) gets a dot on the trigger.
  const isNonDefault = profile !== DEFAULT_PERMISSION_PROFILE || autoReviewEnabled

  const selectProfile = (next: PermissionProfileId): void => {
    if (next === profile) return

    if (next === 'full') {
      setConfirmFullAccess(true)
      return
    }

    onProfileChange(next)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            className={triggerButtonClassName}
            aria-label={`Agent controls: ${selectedProfile.label}, auto-review ${autoReviewEnabled ? 'on' : 'off'}`}
            data-testid="composer-controls-trigger"
          >
            <SlidersHorizontal className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            {/* Dot marks non-default settings: primary color, small, hugging the icon's corner. */}
            {isNonDefault ? (
              <span
                data-testid="controls-nondefault-dot"
                className="absolute right-1 top-1 size-1.5 rounded-full bg-primary ring-1 ring-bg-000"
                aria-hidden="true"
              />
            ) : null}
            {hasGrants ? (
              <span
                className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-bg-300 px-1 text-[10px] font-medium leading-none text-text-100"
                aria-label={`${grants!.length} always-allowed this session`}
              >
                {grants!.length}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72 p-1">
          {/* Permission row: label + colored capsule of the current level; levels live in the submenu. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="items-center justify-between gap-2 px-2 py-1.5">
              <span className="text-[13px] font-medium leading-5">Permission mode</span>
              <span
                data-testid="profile-capsule"
                className={cn(
                  'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
                  profileCapsuleClassName[profile]
                )}
              >
                <SelectedIcon className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
                {selectedProfile.shortLabel}
                <ChevronRight
                  className="size-3 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 p-1">
              {permissionProfiles.map((candidate) => {
                const ProfileIcon = candidate.icon
                const isSelected = candidate.id === profile
                const isFull = candidate.id === 'full'
                const isDisabled = isFull && fullAccessUnavailable

                return (
                  <DropdownMenuItem
                    key={candidate.id}
                    disabled={isDisabled}
                    className="items-center gap-2 px-2 py-1.5"
                    onSelect={() => selectProfile(candidate.id)}
                  >
                    {/* Full access reads as a warning row: amber icon/title, softer amber description. */}
                    <ProfileIcon
                      className={cn('size-4 shrink-0', isFull ? 'text-amber-600' : 'text-text-200')}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block text-[13px] font-medium leading-5',
                          isFull && 'text-amber-600'
                        )}
                      >
                        {candidate.label}
                      </span>
                      <span
                        className={cn(
                          'block text-[11px] leading-4',
                          isFull ? 'text-amber-600/70' : 'text-text-300'
                        )}
                      >
                        {isDisabled
                          ? 'The current agent does not support native bypass mode.'
                          : candidate.description}
                      </span>
                    </span>
                    {isSelected ? (
                      <Check className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                    ) : null}
                  </DropdownMenuItem>
                )
              })}
              {profile === 'auto' && profileState?.autoReviewStrategy === 'conservative' ? (
                <div className="mx-1 mt-1 rounded-md bg-bg-200 px-2 py-1.5 text-[11px] leading-4 text-text-200">
                  This agent has no native auto mode. Open Science auto-approves only edits to files
                  inside the workspace — commands, network, and MCP tools still ask.
                </div>
              ) : null}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* The whole row toggles auto-review; the Switch is a non-interactive indicator so
              clicking it does not double-toggle. preventDefault keeps the menu open. */}
          <DropdownMenuItem
            disabled={autoReviewDisabled}
            className="items-center gap-2 px-2 py-1.5"
            onSelect={(event) => {
              event.preventDefault()
              onAutoReviewChange(!autoReviewEnabled)
            }}
          >
            <ScanEye className="size-4 shrink-0 text-text-200" strokeWidth={2} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-5">Auto-review</span>
              <span className="block text-[11px] leading-4 text-text-300">
                A reviewer agent checks every change before it lands.
              </span>
            </span>
            <Switch
              size="sm"
              checked={autoReviewEnabled}
              tabIndex={-1}
              aria-hidden="true"
              className="pointer-events-none"
            />
          </DropdownMenuItem>

          {hasGrants ? (
            <div className="mt-1 border-t border-border-200 pt-1">
              <div className="flex items-center justify-between px-2 pb-0.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-text-300">
                  Always allowed this session
                </span>
                {/* One-click clear for a long session; swallow the event so the menu stays open. */}
                <button
                  type="button"
                  className="shrink-0 text-[11px] text-text-300 hover:text-text-000"
                  aria-label="Clear all always-allow grants"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onClearGrants?.()
                  }}
                >
                  Clear all
                </button>
              </div>
              {/* Cap the list so a long session of grants scrolls instead of stretching the menu. */}
              <div className="max-h-40 overflow-y-auto">
                {grants!.map((grant) => (
                  <div
                    key={grant.categoryKey}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] text-text-200"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono leading-4"
                      title={grant.label}
                    >
                      {grant.label}
                    </span>
                    {/* Revoke must not close the menu or re-select a profile, so swallow the event. */}
                    <button
                      type="button"
                      className="flex size-5 shrink-0 items-center justify-center rounded text-text-300 hover:bg-bg-200 hover:text-text-000"
                      aria-label={`Revoke always-allow for ${grant.label}`}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onRevokeGrant?.(grant.categoryKey)
                      }}
                    >
                      <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog.Root open={confirmFullAccess} onOpenChange={setConfirmFullAccess}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overscroll-contain rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                <AlertTriangle className="size-5" strokeWidth={2} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <AlertDialog.Title className="text-base font-semibold">
                  Enable Full access?
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
                  The agent can run commands, change files, execute notebook code, and make network
                  requests without asking first. Authentication failures and execution errors can
                  still stop the run.
                </AlertDialog.Description>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="border-border-200 bg-bg-000 text-text-000 hover:bg-bg-200 hover:text-text-000"
                >
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  onClick={() => onProfileChange('full')}
                >
                  Enable
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  )
}

export { ComposerAgentControlsMenu }
