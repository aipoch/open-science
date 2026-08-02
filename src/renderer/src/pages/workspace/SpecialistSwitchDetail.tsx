import { ArrowUpRight } from 'lucide-react'
import { useEffect } from 'react'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useSettingsStore } from '@/stores/settings-store'
import { SpecialistAvatar } from '../settings/specialist-avatar'

// The redacted switch approval payload carried by the ACP request. Only public names travel in the
// payload (main-side redaction); description / capabilities are resolved renderer-side by name,
// matching the main process `getByName` validation identity exactly.
type SwitchApprovalPayload = {
  currentName: string | null
  targetName: string | null
}

const getSwitchPayload = (request: AcpPermissionRequest): SwitchApprovalPayload | undefined => {
  const raw = request.rawInput
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const approval = (raw as Record<string, unknown>).specialistApproval
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return undefined
  const payload = approval as Record<string, unknown>
  if (payload.kind !== 'switch') return undefined
  return {
    currentName:
      payload.currentName === null ? null : ((payload.currentName as string | undefined) ?? null),
    targetName:
      payload.targetName === null ? null : ((payload.targetName as string | undefined) ?? null)
  }
}

// Friendly detail block for an approved specialist switch: resolved identity, capability scope, and
// the current → target direction. Replaces the raw redacted JSON on the permission card.
const SpecialistSwitchDetail = ({
  request
}: {
  request: AcpPermissionRequest
}): React.JSX.Element => {
  const items = useSpecialistStore((state) => state.items)
  const isLoaded = useSpecialistStore((state) => state.isLoaded)
  const load = useSpecialistStore((state) => state.load)
  // Kept at the top with the other hooks: the detail block can be replaced by a fallback
  // branch on later renders, so hook order must not depend on the resolved profile.
  const openSettingsToSpecialist = useSettingsStore((state) => state.openSettingsToSpecialist)

  useEffect(() => {
    if (!isLoaded) void load()
  }, [isLoaded, load])

  const payload = getSwitchPayload(request)
  if (!payload) return <></>

  const targetName = payload.targetName
  const profile =
    targetName !== null
      ? items.find((item) => item.kind === 'custom' && item.name === targetName)
      : undefined

  // The direction line names both sides of the switch; a null side is the Main Agent. Public
  // names resolve to their display names through the catalog when available, matching the detail
  // block's identity presentation.
  const resolveLabel = (name: string | null): string => {
    if (name === null) return 'Main Agent'
    const found = items.find((item) => item.kind === 'custom' && item.name === name)
    return found && found.kind === 'custom' ? (found.displayName ?? found.name) : name
  }
  const currentLabel = resolveLabel(payload.currentName)
  const targetLabel = resolveLabel(targetName)

  const direction = (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">{currentLabel}</span>
      <span aria-hidden="true">→</span>
      <span className="font-semibold text-foreground">{targetLabel}</span>
    </div>
  )

  // Main Agent target: no profile exists, so a neutral statement never fabricated from
  // specialist data. Unresolved targets (renamed / removed) get their own stale treatment.
  if (targetName === null) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/60 p-3">
        <div className="text-sm font-semibold text-foreground">Main Agent</div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Reverts to the default agent. Specialist capability scoping is removed — all enabled
          skills and connectors become available again.
        </p>
        {direction}
      </div>
    )
  }

  // The target name can no longer be resolved (renamed or removed since the request started).
  // Approval will fail main-side name validation; surface that before the user decides.
  if (!profile || profile.kind !== 'custom') {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
        <div className="text-sm font-semibold text-destructive">{targetName}</div>
        <p className="text-xs leading-relaxed text-destructive">
          This Specialist can no longer be resolved by name — it was renamed or removed since the
          request started. Approving will be rejected.
        </p>
        {direction}
      </div>
    )
  }

  const capabilityLabel =
    profile.capabilityMode === 'full' ? 'Full access' : 'Selected capabilities'
  const openConfig = (): void => openSettingsToSpecialist(profile.id)

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-testid="specialist-detail"
        aria-label={`Open ${profile.displayName ?? profile.name} configuration`}
        onClick={openConfig}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openConfig()
          }
        }}
        className="group flex w-full items-start gap-3 rounded-xl border border-border bg-muted/60 p-3 text-left transition-[border-color,background-color,box-shadow] hover:border-border-strong hover:bg-card hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-strong"
      >
        <SpecialistAvatar iconKey={profile.iconKey} colorKey={profile.colorKey} size="md" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {profile.displayName ?? profile.name}
          </div>
          {profile.description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {profile.description}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {capabilityLabel}
            </span>
            {!profile.enabled ? (
              <span className="inline-flex items-center rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">
                Disabled
              </span>
            ) : null}
          </div>
          {!profile.enabled ? (
            <p className="mt-1 text-xs text-destructive">
              This Specialist is disabled. Approving will be rejected.
            </p>
          ) : null}
        </div>
        {/* Affordance that the block opens the specialist config; revealed on hover/focus. */}
        <span
          aria-hidden="true"
          className="ml-auto inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap text-[11.5px] font-semibold text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Configure
          <ArrowUpRight className="size-3" />
        </span>
      </button>
      {direction}
    </div>
  )
}

export { SpecialistSwitchDetail }
