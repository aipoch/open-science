import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import type { AcpPermissionGrant } from '../../../../shared/acp'
import { AlertTriangle, Check, ChevronUp, Shield, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import { AlertDialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type ComposerPermissionProfilePickerProps = {
  value: PermissionProfileId
  state?: SessionPermissionProfileState
  grants?: AcpPermissionGrant[]
  disabled?: boolean
  onChange: (profile: PermissionProfileId) => void
  onRevokeGrant?: (categoryKey: string) => void
  onClearGrants?: () => void
}

const permissionProfiles: Array<{
  id: PermissionProfileId
  label: string
  description: string
  icon: typeof Shield
}> = [
  {
    id: 'ask',
    label: 'Ask for approval',
    description: 'Ask before file edits, commands, network, and MCP tools.',
    icon: Shield
  },
  {
    id: 'auto',
    label: 'Auto-approve edits',
    description:
      'Auto-approve edits to files in the workspace. Still ask before commands, network, and MCP.',
    icon: ShieldCheck
  },
  {
    id: 'full',
    label: 'Full access',
    description: 'Run everything without prompts, including commands and network.',
    icon: ShieldAlert
  }
]

const ComposerPermissionProfilePicker = ({
  value,
  state,
  grants,
  disabled = false,
  onChange,
  onRevokeGrant,
  onClearGrants
}: ComposerPermissionProfilePickerProps): React.JSX.Element => {
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const selectedProfile = permissionProfiles.find((profile) => profile.id === value)!
  const SelectedIcon = selectedProfile.icon
  const fullAccessUnavailable = state?.fullAccessAvailable === false
  // Grants only apply while asking for approval; the count pill hints at active always-allows.
  const hasGrants = value === 'ask' && (grants?.length ?? 0) > 0

  const selectProfile = (profile: PermissionProfileId): void => {
    if (profile === value) return

    if (profile === 'full') {
      setConfirmFullAccess(true)
      return
    }

    onChange(profile)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="ghost"
            className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-100 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={`Permission mode: ${selectedProfile.label}`}
          >
            <SelectedIcon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            {/* Count pill stays visible even when the label collapses so grants aren't hidden. */}
            {hasGrants ? (
              <span
                className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-bg-300 px-1 text-[10px] font-medium leading-none text-text-100"
                aria-label={`${grants!.length} always-allowed this session`}
              >
                {grants!.length}
              </span>
            ) : null}
            <span className="max-w-32 truncate @max-[28rem]/composer:hidden">
              {selectedProfile.label}
            </span>
            <ChevronUp
              className="size-3 shrink-0 @max-[28rem]/composer:hidden"
              strokeWidth={2}
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-80 p-1.5">
          {permissionProfiles.map((profile) => {
            const ProfileIcon = profile.icon
            const isSelected = profile.id === value
            const isDisabled = profile.id === 'full' && fullAccessUnavailable

            return (
              <DropdownMenuItem
                key={profile.id}
                disabled={isDisabled}
                className="items-center gap-2.5 px-2.5 py-2"
                onSelect={() => selectProfile(profile.id)}
              >
                <ProfileIcon
                  className="size-4 shrink-0 text-text-200"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-5">{profile.label}</span>
                  <span className="block text-[11px] leading-4 text-text-300">
                    {isDisabled
                      ? 'The current agent does not support native bypass mode.'
                      : profile.description}
                  </span>
                </span>
                {isSelected ? (
                  <Check className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                ) : null}
              </DropdownMenuItem>
            )
          })}
          {value === 'auto' && state?.autoReviewStrategy === 'conservative' ? (
            <div className="mx-1 mt-1 rounded-md bg-bg-200 px-2 py-1.5 text-[11px] leading-4 text-text-200">
              This agent has no native auto mode. Open Science auto-approves only edits to files
              inside the workspace — commands, network, and MCP tools still ask.
            </div>
          ) : null}
          {hasGrants ? (
            <div className="mt-1 border-t border-border-200 pt-1.5">
              <div className="flex items-center justify-between px-2.5 pb-1">
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
                    className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] text-text-200"
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
                  onClick={() => onChange('full')}
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

export { ComposerPermissionProfilePicker }
