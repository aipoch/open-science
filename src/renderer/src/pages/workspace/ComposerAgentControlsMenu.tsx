// Unified composer menu: per-session agent controls (permission profile + auto-review) and
// resource selection (specialist + compute), behind a single icon trigger. Replaces the
// earlier split into ComposerPermissionProfilePicker, ComposerAutoReviewToggle, the
// standalone SpecialistPicker, and ComputeHostSelector. A primary-color dot on the trigger
// marks any deviation from the defaults (profile 'ask', auto-review off); session grants
// keep their own count pill. The first-level menu shows the current permission level as a
// borderless colored capsule (ask = neutral, auto = blue, full = warning amber); picking a
// level lives in a submenu. Specialist and Compute are hover-expanded submenus below
// auto-review: Specialist offers None / personal specialists / Create new…; Compute folds
// the SSH host list and "Manage compute…" together. Both read from global stores.

import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId,
  type SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import type { AcpPermissionGrant } from '../../../../shared/acp'
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronLeft,
  ChevronRight,
  ScanEye,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import { SpecialistSubmenu } from './SpecialistSubmenu'
import { AgentControlMenuContent, AgentControlMenuItemTooltip } from './AgentControlMenuItemTooltip'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'

// Mirrors composerIconButtonClassName in ConversationPanel, but hugs the icon + grants pill.
const triggerButtonClassName =
  'relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-text-300 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50'

type ComposerAgentControlsMenuProps = {
  profile: PermissionProfileId
  profileState?: SessionPermissionProfileState
  grants?: AcpPermissionGrant[]
  autoReviewEnabled: boolean
  memoryEnabled?: boolean
  // Read-only while a session is running: the menu stays openable and the permission
  // submenu still expands on hover, but profiles, auto-review, and compute stay immutable.
  readOnly?: boolean
  // Memory may be reconfigured again after context replacement while transcript replay is pending.
  memoryReadOnly?: boolean
  memoryDisabledReason?: string
  // Auto-review is a durable preference and does not depend on the provider transcript state.
  autoReviewReadOnly?: boolean
  // Permission mode remains independently editable during a running prompt.
  permissionProfileReadOnly?: boolean
  // Grant revocation remains independently available while a turn is running.
  grantActionsReadOnly?: boolean
  autoReviewDisabled?: boolean
  onProfileChange: (profile: PermissionProfileId) => void
  onAutoReviewChange: (enabled: boolean) => void
  onMemoryChange?: (enabled: boolean) => void
  onRevokeGrant?: (categoryKey: string) => void
  onClearGrants?: () => void
  // Compute hosts: the SSH section is appended below auto-review. Optional so the menu still
  // renders without a compute binding (e.g. in isolation tests); the composer passes both.
  enabledComputeHosts?: string[]
  selectedComputeHosts?: string[]
  onComputeHostEnabledChange?: (providerId: string, enabled: boolean) => void
  onComputeHostSelectedChange?: (providerId: string, selected: boolean) => void
  // Specialist submenu: shown when showSpecialist is true (the composer decides, mirroring the
  // old standalone picker's visibility rule). specialistReadOnly marks a bound session whose
  // identity is fixed. It defaults to the menu's general read-only state for isolated consumers.
  showSpecialist?: boolean
  specialistId?: string
  specialistUnavailable?: boolean
  specialistReadOnly?: boolean
  onSpecialistChange?: (specialistId: string | undefined) => void
  openRequest?: number
  computeOpenRequest?: number
}

// `as const` (rather than a widened annotation) keeps the catalog keys as literals so t() stays
// compile-time checked against the English catalog.
const permissionProfiles = [
  {
    id: 'ask',
    labelKey: 'Ask for approval',
    shortLabelKey: 'Ask',
    descriptionKey: 'Ask before file edits, commands, network, and MCP tools.',
    icon: Shield
  },
  {
    id: 'auto',
    labelKey: 'Auto-approve edits',
    shortLabelKey: 'Auto',
    descriptionKey:
      'Auto-approve edits to files in the workspace. Still ask before commands, network, and MCP.',
    icon: ShieldCheck
  },
  {
    id: 'full',
    labelKey: 'Full access',
    shortLabelKey: 'Full access',
    descriptionKey: 'Run everything without prompts, including commands and network.',
    icon: ShieldAlert
  }
] as const satisfies ReadonlyArray<{
  id: PermissionProfileId
  labelKey: string
  shortLabelKey: string
  descriptionKey: string
  icon: typeof Shield
}>

// Borderless capsule colors per level: ask stays neutral, auto is blue, full warns in amber.
const profileCapsuleClassName: Record<PermissionProfileId, string> = {
  ask: 'bg-bg-200 text-text-100',
  auto: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  full: 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
}

const ComposerAgentControlsMenu = ({
  profile,
  profileState,
  grants,
  autoReviewEnabled,
  memoryEnabled = true,
  readOnly = false,
  memoryReadOnly = readOnly,
  memoryDisabledReason,
  autoReviewReadOnly = readOnly,
  permissionProfileReadOnly = readOnly,
  grantActionsReadOnly = readOnly,
  autoReviewDisabled = false,
  onProfileChange,
  onAutoReviewChange,
  onMemoryChange = () => undefined,
  onRevokeGrant,
  onClearGrants,
  enabledComputeHosts,
  selectedComputeHosts,
  onComputeHostEnabledChange,
  onComputeHostSelectedChange,
  showSpecialist = false,
  specialistId,
  specialistUnavailable = false,
  specialistReadOnly = readOnly,
  onSpecialistChange,
  openRequest,
  computeOpenRequest
}: ComposerAgentControlsMenuProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [mobilePermissionOpen, setMobilePermissionOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [computeMenuOpen, setComputeMenuOpen] = useState(false)
  const [tooltipCollisionBoundary, setTooltipCollisionBoundary] = useState<HTMLElement | null>(null)
  const controlsTriggerRef = useRef<HTMLButtonElement>(null)
  const previousOpenRequest = useRef(openRequest)
  const previousComputeOpenRequest = useRef(computeOpenRequest)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const selectedProfile = permissionProfiles.find((candidate) => candidate.id === profile)!
  const SelectedIcon = selectedProfile.icon
  const fullAccessUnavailable = profileState?.fullAccessAvailable === false
  // Ask grants stay visible across profile switches so changing Auto/Full never appears to lose them.
  const hasGrants = (grants?.length ?? 0) > 0
  // A globally unavailable Memory capability is not a per-conversation customization.
  const isNonDefault =
    profile !== DEFAULT_PERMISSION_PROFILE ||
    autoReviewEnabled ||
    (!memoryEnabled && !memoryDisabledReason)

  useEffect(() => {
    if (openRequest === undefined || openRequest === previousOpenRequest.current) return
    previousOpenRequest.current = openRequest
    setMenuOpen(true)
  }, [openRequest])

  useEffect(() => {
    if (!menuOpen) return
    setTooltipCollisionBoundary(
      controlsTriggerRef.current?.closest<HTMLElement>('[data-slot="resizable-panel"]') ?? null
    )
  }, [menuOpen])

  const selectProfile = (next: PermissionProfileId): void => {
    if (next === profile) return

    if (next === 'full') {
      setConfirmFullAccess(true)
      return
    }

    onProfileChange(next)
  }

  // Compute hosts read from the global compute store (no prop drilling), mirroring
  // ComposerModelPicker. Lazy-loaded on first open so the menu stays cheap while closed.
  const hosts = useComputeStore((state) => state.hosts)
  const isLoaded = useComputeStore((state) => state.isLoaded)
  const loadHosts = useComputeStore((state) => state.loadHosts)
  const openSettingsToCompute = useSettingsStore((state) => state.openSettingsToCompute)

  const sshHosts = hosts.filter((host) => host.sshAlias)

  useEffect(() => {
    if (
      computeOpenRequest === undefined ||
      computeOpenRequest === previousComputeOpenRequest.current
    ) {
      return
    }
    previousComputeOpenRequest.current = computeOpenRequest
    setMenuOpen(true)
    setComputeMenuOpen(true)
    if (!isLoaded) void loadHosts()
  }, [computeOpenRequest, isLoaded, loadHosts])

  const handleOpenChange = (open: boolean): void => {
    setMenuOpen(open)
    if (!open) {
      setMobilePermissionOpen(false)
      setComputeMenuOpen(false)
    }
    if (open && !isLoaded) {
      void loadHosts()
    }
  }

  const permissionOptions = (
    <>
      {permissionProfiles.map((candidate) => {
        const ProfileIcon = candidate.icon
        const isSelected = candidate.id === profile
        const isFull = candidate.id === 'full'
        const isDisabled = isFull && fullAccessUnavailable
        const itemDisabled = permissionProfileReadOnly || isDisabled

        const description = isDisabled
          ? t('The current agent does not support native bypass mode.')
          : t(candidate.descriptionKey)

        return (
          <AgentControlMenuItemTooltip
            key={candidate.id}
            description={description}
            disabled={itemDisabled}
          >
            <DropdownMenuItem
              disabled={itemDisabled}
              className="items-center gap-2 px-2 py-1.5"
              onSelect={() => selectProfile(candidate.id)}
            >
              <ProfileIcon
                className={cn(
                  'size-4 shrink-0',
                  isFull ? 'text-amber-600 dark:text-amber-400' : 'text-text-200'
                )}
                strokeWidth={2}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px] font-medium leading-5',
                  isFull && 'text-amber-600 dark:text-amber-400'
                )}
              >
                {t(candidate.labelKey)}
              </span>
              {isSelected ? (
                <Check className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          </AgentControlMenuItemTooltip>
        )
      })}
      {profile === 'auto' && profileState?.autoReviewStrategy === 'conservative' ? (
        <div className="mx-1 mt-1 rounded-md bg-bg-200 px-2 py-1.5 text-[11px] leading-4 text-text-200">
          {t(
            'This agent has no native auto mode. Open Science auto-approves only edits to files inside the workspace — commands, network, and MCP tools still ask.'
          )}
        </div>
      ) : null}
    </>
  )

  const permissionSummary = (
    <>
      <Shield className="size-4 shrink-0 text-text-200" strokeWidth={2} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
        {t('Permission mode')}
      </span>
      <span
        data-testid="profile-capsule"
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
          profileCapsuleClassName[profile]
        )}
      >
        <SelectedIcon className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
        {t(selectedProfile.shortLabelKey)}
        <ChevronRight className="size-3 shrink-0 opacity-60" strokeWidth={2} aria-hidden="true" />
      </span>
    </>
  )

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleOpenChange}>
        {/* The trigger stays enabled in read-only mode so the menu (and its submenu)
            remains browsable while a session is running; only the controls are disabled. */}
        <DropdownMenuTrigger asChild>
          <button
            ref={controlsTriggerRef}
            type="button"
            className={triggerButtonClassName}
            aria-label={t('Agent controls: {{profile}}, auto-review {{autoReview}}', {
              profile: t(selectedProfile.labelKey),
              autoReview: autoReviewEnabled ? 'on' : 'off'
            })}
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
                aria-label={t('{{count}} allowed this session', { count: grants!.length })}
              >
                {grants!.length}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <AgentControlMenuContent
          boundary={tooltipCollisionBoundary}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="max-h-[calc(100dvh-1rem)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto p-1"
        >
          {isMobile && mobilePermissionOpen ? (
            <>
              {/* Mobile keeps the second level inside the same viewport-safe panel. */}
              <DropdownMenuItem
                className="items-center gap-2 px-2 py-1.5"
                data-testid="mobile-permission-back"
                onSelect={(event) => {
                  event.preventDefault()
                  setMobilePermissionOpen(false)
                }}
              >
                <ChevronLeft className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                <span className="text-[13px] font-medium leading-5">{t('Permission mode')}</span>
              </DropdownMenuItem>
              <div className="mx-1 mb-1 border-t border-border-200" />
              {permissionOptions}
            </>
          ) : (
            <>
              {/* On mobile, open the permission choices in this panel. Desktop keeps the submenu. */}
              {isMobile ? (
                <AgentControlMenuItemTooltip
                  description={t('Applies to future actions; completed actions are unchanged.')}
                >
                  <DropdownMenuItem
                    className="items-center gap-2 px-2 py-1.5"
                    data-testid="mobile-permission-trigger"
                    onSelect={(event) => {
                      event.preventDefault()
                      setMobilePermissionOpen(true)
                    }}
                  >
                    {permissionSummary}
                  </DropdownMenuItem>
                </AgentControlMenuItemTooltip>
              ) : (
                <DropdownMenuSub>
                  <AgentControlMenuItemTooltip
                    description={t('Applies to future actions; completed actions are unchanged.')}
                    submenu
                  >
                    <DropdownMenuSubTrigger className="items-center gap-2 px-2 py-1.5">
                      {permissionSummary}
                    </DropdownMenuSubTrigger>
                  </AgentControlMenuItemTooltip>
                  <DropdownMenuSubContent
                    collisionPadding={8}
                    className="max-h-[calc(100dvh-1rem)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto p-1"
                  >
                    {permissionOptions}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}

              {hasGrants ? (
                <div className="mt-1 border-t border-border-200 pt-1">
                  <div className="flex items-center justify-between px-2 pb-0.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-300">
                      {t('Allowed this session')}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-[11px] text-text-300 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-300"
                      aria-label={t('Clear all session grants')}
                      disabled={grantActionsReadOnly}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onClearGrants?.()
                      }}
                    >
                      {t('Clear all')}
                    </button>
                  </div>
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
                        <button
                          type="button"
                          className="flex size-5 shrink-0 items-center justify-center rounded text-text-300 hover:bg-bg-200 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-300"
                          aria-label={t('Revoke session grant for {{label}}', {
                            label: grant.label
                          })}
                          disabled={grantActionsReadOnly}
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

              <DropdownMenuSeparator />

              {/* The whole row toggles auto-review; the Switch is a visual indicator only. */}
              <AgentControlMenuItemTooltip
                description={t('A reviewer agent checks every change before it lands.')}
                disabled={autoReviewReadOnly || autoReviewDisabled}
              >
                <DropdownMenuItem
                  disabled={autoReviewReadOnly || autoReviewDisabled}
                  className="items-center gap-2 px-2 py-1.5"
                  onSelect={(event) => {
                    event.preventDefault()
                    onAutoReviewChange(!autoReviewEnabled)
                  }}
                >
                  <ScanEye
                    className="size-4 shrink-0 text-text-200"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
                    {t('Auto-review')}
                  </span>
                  <Switch
                    size="sm"
                    checked={autoReviewEnabled}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="pointer-events-none"
                  />
                </DropdownMenuItem>
              </AgentControlMenuItemTooltip>

              <AgentControlMenuItemTooltip
                description={
                  memoryDisabledReason ??
                  t('Let the agent recall and save memory in this conversation.')
                }
                disabled={memoryReadOnly}
              >
                <DropdownMenuItem
                  disabled={memoryReadOnly}
                  className="items-center gap-2 px-2 py-1.5"
                  onSelect={(event) => {
                    event.preventDefault()
                    onMemoryChange(!memoryEnabled)
                  }}
                >
                  <BrainCircuit
                    className="size-4 shrink-0 text-text-200"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
                    {t('Memory')}
                  </span>
                  <Switch
                    size="sm"
                    checked={memoryEnabled}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="pointer-events-none"
                  />
                </DropdownMenuItem>
              </AgentControlMenuItemTooltip>

              {/* Specialist + Compute are one resource-selection group: a single divider leads
                  the group (above Specialist when present, above Compute otherwise), so the two
                  hover submenus stay adjacent with nothing between them. */}
              {showSpecialist ? (
                <>
                  <DropdownMenuSeparator />
                  <SpecialistSubmenu
                    selectedId={specialistId}
                    onChange={onSpecialistChange ?? (() => undefined)}
                    unavailable={specialistUnavailable}
                    readOnly={specialistReadOnly}
                  />
                </>
              ) : (
                <DropdownMenuSeparator />
              )}

              <DropdownMenuSub open={computeMenuOpen} onOpenChange={setComputeMenuOpen}>
                <AgentControlMenuItemTooltip
                  description={t('Run jobs on a remote SSH host, or manage hosts.')}
                  submenu
                >
                  <DropdownMenuSubTrigger className="items-center gap-2 px-2 py-1.5">
                    <Server
                      className="size-4 shrink-0 text-text-200"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
                      {t('Compute')}
                    </span>
                    {/* Align the chevron with the capsule chevrons on the Permission/Specialist
                        rows: same px-2 (one vertical line) and text-text-100 (depth) as the
                        capsule chevrons — Compute has no capsule, so the color is set here. */}
                    <span className="flex shrink-0 items-center px-2 py-0.5 text-text-100">
                      <ChevronRight
                        className="size-3 shrink-0 opacity-60"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </span>
                  </DropdownMenuSubTrigger>
                </AgentControlMenuItemTooltip>
                <DropdownMenuSubContent
                  collisionPadding={8}
                  className="max-h-[calc(100dvh-1rem)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto p-1"
                >
                  {sshHosts.length > 0 ? (
                    <>
                      <DropdownMenuLabel className="text-[10.5px] font-normal uppercase tracking-wide text-text-300">
                        {t('SSH')}
                      </DropdownMenuLabel>
                      <DropdownMenuGroup>
                        {sshHosts.map((host) => {
                          const isEnabled = enabledComputeHosts?.includes(host.providerId) ?? false
                          const isSelected =
                            selectedComputeHosts?.includes(host.providerId) ?? false
                          return (
                            <div
                              key={host.providerId}
                              className="flex min-h-8 items-center gap-0.5 rounded-lg px-2 py-0.5"
                            >
                              <span className="min-w-0 flex-1 truncate text-[13px] text-text-100">
                                {host.displayName}
                              </span>
                              <DropdownMenuItem
                                disabled={readOnly}
                                role="menuitemcheckbox"
                                aria-checked={isEnabled}
                                aria-label={
                                  isEnabled
                                    ? t('Disable {{name}}', { name: host.displayName })
                                    : t('Enable {{name}}', { name: host.displayName })
                                }
                                data-testid={`compute-host-enabled-${host.providerId}`}
                                onSelect={(event) => {
                                  event.preventDefault()
                                  onComputeHostEnabledChange?.(host.providerId, !isEnabled)
                                }}
                                className="min-h-6 shrink-0 rounded-md px-1 py-0.5"
                              >
                                <Switch
                                  size="sm"
                                  checked={isEnabled}
                                  tabIndex={-1}
                                  aria-hidden="true"
                                  className="pointer-events-none"
                                />
                              </DropdownMenuItem>
                              <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <DropdownMenuItem
                                      disabled={readOnly}
                                      role="menuitemcheckbox"
                                      aria-checked={isSelected}
                                      aria-label={
                                        isSelected
                                          ? t('Remove {{name}} from run targets', {
                                              name: host.displayName
                                            })
                                          : t('Add {{name}} to run targets', {
                                              name: host.displayName
                                            })
                                      }
                                      data-testid={`compute-host-selected-${host.providerId}`}
                                      onSelect={(event) => {
                                        event.preventDefault()
                                        onComputeHostSelectedChange?.(host.providerId, !isSelected)
                                      }}
                                      className={cn(
                                        'size-6 min-h-6 shrink-0 justify-center rounded-md p-0',
                                        isSelected
                                          ? 'bg-primary/10 text-primary hover:bg-primary/15 data-[highlighted]:bg-primary/15 data-[highlighted]:text-primary'
                                          : 'text-text-300'
                                      )}
                                    >
                                      <ArrowRight
                                        className="size-2.5"
                                        strokeWidth={2.25}
                                        aria-hidden="true"
                                      />
                                    </DropdownMenuItem>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-[11px]">
                                    {isSelected
                                      ? t('Remove from target hosts')
                                      : t('Select as target host to run jobs')}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          )
                        })}
                      </DropdownMenuGroup>
                    </>
                  ) : (
                    <DropdownMenuItem disabled className="px-2 py-1.5 text-[13px] text-text-300">
                      {isLoaded ? t('No SSH hosts registered') : t('Loading…')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => openSettingsToCompute()}
                    className="items-center gap-2 px-2 py-1.5 text-[13px] text-text-200"
                  >
                    <Settings className="size-4 shrink-0" aria-hidden="true" />
                    {t('Manage compute...')}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
        </AgentControlMenuContent>
      </DropdownMenu>

      <AlertDialog.Root open={confirmFullAccess} onOpenChange={setConfirmFullAccess}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName(
              'w-[min(440px,calc(100vw-2rem))] overscroll-contain p-0'
            )}
          >
            <div className={dialogHeaderClassName}>
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  <AlertTriangle className="size-5" strokeWidth={2} aria-hidden="true" />
                </span>
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Enable Full access?')}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>
            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {t(
                  'The agent can run commands, change files, execute notebook code, and make network requests without asking first. Authentication failures and execution errors can still stop the run.'
                )}
              </AlertDialog.Description>
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  disabled={permissionProfileReadOnly || fullAccessUnavailable}
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  onClick={() => onProfileChange('full')}
                >
                  {t('Enable')}
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
