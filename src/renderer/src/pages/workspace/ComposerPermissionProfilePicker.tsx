import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import { AlertTriangle, Check, ChevronUp, Shield, ShieldCheck, Zap } from 'lucide-react'
import { useState } from 'react'
import { AlertDialog } from 'radix-ui'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type ComposerPermissionProfilePickerProps = {
  value: PermissionProfileId
  state?: SessionPermissionProfileState
  disabled?: boolean
  onChange: (profile: PermissionProfileId) => void
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
    description: 'Ask before risky commands, file changes, or network access.',
    icon: Shield
  },
  {
    id: 'auto',
    label: 'Approve for me',
    description: 'Automatically approve only low-risk operations.',
    icon: ShieldCheck
  },
  {
    id: 'full',
    label: 'Full access',
    description: 'Run without approval prompts in this conversation.',
    icon: Zap
  }
]

const ComposerPermissionProfilePicker = ({
  value,
  state,
  disabled = false,
  onChange
}: ComposerPermissionProfilePickerProps): React.JSX.Element => {
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const selectedProfile = permissionProfiles.find((profile) => profile.id === value)!
  const SelectedIcon = selectedProfile.icon
  const fullAccessUnavailable = state?.fullAccessAvailable === false

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
          <button
            type="button"
            className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-100 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={`Permission mode: ${selectedProfile.label}`}
          >
            <SelectedIcon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            <span className="max-w-32 truncate">{selectedProfile.label}</span>
            <ChevronUp className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
          </button>
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
                className="items-start gap-2.5 px-2.5 py-2"
                onSelect={() => selectProfile(profile.id)}
              >
                <ProfileIcon
                  className="mt-0.5 size-4 shrink-0 text-text-200"
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
                  <Check className="mt-0.5 size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                ) : null}
              </DropdownMenuItem>
            )
          })}
          {value === 'auto' && state?.autoReviewStrategy === 'conservative' ? (
            <div className="mx-1 mt-1 rounded-md bg-bg-200 px-2 py-1.5 text-[11px] leading-4 text-text-200">
              This agent has no native auto mode. Only structured reads, searches, and workspace
              edits are approved automatically.
            </div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog.Root open={confirmFullAccess} onOpenChange={setConfirmFullAccess}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
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
                <button
                  type="button"
                  className="rounded-lg border border-border-200 px-3 py-2 text-sm hover:bg-bg-200"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
                  onClick={() => onChange('full')}
                >
                  Enable Full access
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  )
}

export { ComposerPermissionProfilePicker }
