import { AlertTriangle } from 'lucide-react'
import { useEffect } from 'react'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import { useSpecialistStore } from '@/stores/specialist-store'
import { SpecialistAvatar } from '../settings/specialist-avatar'

// The redacted delete approval payload carried by the ACP request. Only the public name travels in
// the payload (main-side redaction); description / capabilities are resolved renderer-side by name,
// matching the main process `getByName` validation identity exactly.
type DeleteApprovalPayload = {
  name: string
}

const getDeletePayload = (request: AcpPermissionRequest): DeleteApprovalPayload | undefined => {
  const raw = request.rawInput
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const approval = (raw as Record<string, unknown>).specialistApproval
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return undefined
  const payload = approval as Record<string, unknown>
  if (payload.kind !== 'delete') return undefined
  const name = typeof payload.name === 'string' ? payload.name : undefined
  if (!name) return undefined
  return { name }
}

// Friendly detail block for an approved specialist delete: resolved identity, capability scope, and
// the fail-closed binding warning. Replaces the raw redacted JSON on the permission card.
const SpecialistDeleteDetail = ({
  request
}: {
  request: AcpPermissionRequest
}): React.JSX.Element => {
  const items = useSpecialistStore((state) => state.items)
  const isLoaded = useSpecialistStore((state) => state.isLoaded)
  const load = useSpecialistStore((state) => state.load)
  // Kept at the top with the other hooks: the detail block can be replaced by a fallback
  // branch on later renders, so hook order must not depend on the resolved profile.
  useEffect(() => {
    if (!isLoaded) void load()
  }, [isLoaded, load])

  const payload = getDeletePayload(request)
  if (!payload) return <></>

  const name = payload.name
  const profile = items.find((item) => item.kind === 'custom' && item.name === name)

  // The target name can no longer be resolved (renamed or removed since the request started).
  // Approval will fail main-side name validation; surface that before the user decides.
  if (!profile || profile.kind !== 'custom') {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
        <div className="text-sm font-semibold text-destructive">{name}</div>
        <p className="text-xs leading-relaxed text-destructive">
          This Specialist can no longer be resolved by name — it was renamed or removed since the
          request started. Approving will be rejected.
        </p>
      </div>
    )
  }

  const capabilityLabel =
    profile.capabilityMode === 'full' ? 'Full access' : 'Selected capabilities'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex w-full items-start gap-3 rounded-xl border border-border bg-muted/60 p-3 text-left">
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
              <span className="inline-flex items-center rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground">
                Disabled
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">will be permanently removed</div>
        </div>
      </div>
      {/* Fail-closed binding warning (design.md §10): bound conversations are NOT switched to Main
          Agent — they resolve unavailable until the user explicitly picks a replacement. */}
      <div className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <p className="text-foreground">
          Conversations still bound to <b>{profile.displayName ?? profile.name}</b> will become{' '}
          <b>unavailable</b> and will <b>not</b> be switched to Main Agent automatically. For each
          affected conversation you&apos;ll explicitly choose a new specialist or Main Agent before
          it can send again.
        </p>
      </div>
    </div>
  )
}

export { SpecialistDeleteDetail }
