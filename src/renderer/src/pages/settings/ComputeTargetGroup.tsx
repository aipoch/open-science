import { COMPUTE_ACCOUNT_CONNECTION_REQUIRED } from '../../../../shared/compute-accounts'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { ComputeAccountDialog } from './ComputeAccountControls'
import {
  computeAccountActionsAvailable,
  computeAccountStatusLabel,
  useComputeAccount
} from './use-compute-account'
import { CircleCheck, ExternalLink, LoaderCircle, Pencil, Plus, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import huggingFaceIcon from '@/assets/provider-icons/huggingface.svg'
import modalIcon from '@/assets/provider-icons/modal.svg'
import rayIcon from '@/assets/provider-icons/ray.svg'
import kubernetesIcon from '@/assets/provider-icons/kubernetes.svg'
import { DiagnosticDetails } from '@/components/diagnostic-details'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  computeAccountProviderForBackend,
  computeTargetAddLabels,
  type ComputeTargetBackend,
  type ComputeView
} from '@/lib/settings-navigation'
import { useComputeStore } from '@/stores/compute-store'
import { ComputeHostRemovalDialog } from './ComputeHostRemovalDialog'
import { SettingsSection } from './SettingsLayout'

// Hugging Face mark via LobeHub (bundled MIT license), Modal from its official favicon,
// and the monochrome Ray and Kubernetes marks from Simple Icons (CC0).
const groups = {
  hosted: {
    title: 'Hugging Face Jobs',
    icon: huggingFaceIcon,
    website: { name: 'Hugging Face Jobs', url: 'https://huggingface.co/settings/jobs' }
  },
  modal: {
    title: 'Modal Sandboxes',
    icon: modalIcon,
    website: { name: 'Modal', url: 'https://modal.com/apps' }
  },
  kubernetes: { title: 'Kubernetes', icon: kubernetesIcon, website: null },
  ray: { title: 'Ray Jobs', icon: rayIcon, website: null }
} as const

export type ComputeGroupNavigation = { onNavigate: (view: ComputeView) => void }

export function ComputeAddButton({
  label,
  onClick,
  disabled,
  anchor
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  anchor?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={label}
      data-settings-anchor={anchor}
      disabled={disabled}
      onClick={onClick}
    >
      <Plus className="size-4" aria-hidden="true" />
      {t('Add')}
    </Button>
  )
}

type TargetRowData = { providerId: string; displayName: string }
type AccessCheck = { scope: string; state: 'checking' | 'success' | 'error' }

function ComputeTargetRow({
  target,
  description,
  verificationScope,
  local,
  onEdit,
  onRemoved
}: {
  target: TargetRowData
  description: string
  verificationScope?: string
  local: boolean
  onEdit: () => void
  onRemoved: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<AccessCheck>()
  if (result && result.scope !== verificationScope) setResult(undefined)

  async function verify(): Promise<void> {
    if (!verificationScope || result?.state === 'checking' || !computeAccountActionsAvailable())
      return
    const attempt: AccessCheck = { scope: verificationScope, state: 'checking' }
    setResult(attempt)
    let state: AccessCheck['state'] = 'success'
    try {
      await window.api.compute.verifyTarget(target.providerId)
    } catch {
      state = 'error'
    }
    setResult((current) => (current === attempt ? { ...attempt, state } : current))
  }

  const checking = result?.state === 'checking'
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
      <div className="min-w-0 flex-1 basis-36">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 break-words text-sm font-medium text-foreground" dir="auto">
            {target.displayName}
          </p>
          {result?.state === 'success' && (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-xs text-status-success-foreground dark:text-status-success-dark-foreground"
            >
              <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
              {t('Access verified')}
            </span>
          )}
        </div>
        <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground" dir="auto">
          {description}
        </p>
        {result?.state === 'error' && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {t('Could not verify access to this configuration.')}
          </p>
        )}
      </div>
      {local && (
        <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {verificationScope && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-busy={checking}
              aria-disabled={checking}
              onClick={() => void verify()}
            >
              {checking ? (
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <ShieldCheck className="size-3.5" aria-hidden="true" />
              )}
              {t('Verify access')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('Edit {{name}}', { name: target.displayName })}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            {t('Edit')}
          </Button>
          <ComputeHostRemovalDialog host={target} triggerVariant="outline" onRemoved={onRemoved} />
        </div>
      )}
    </li>
  )
}

export function ComputeTargetGroup<T extends { providerId: string; displayName: string }>({
  backend,
  targets,
  describe,
  loadError,
  onNavigate
}: ComputeGroupNavigation & {
  backend: ComputeTargetBackend
  targets: T[]
  describe: (target: T) => string
  loadError?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const local =
    typeof document === 'undefined' ||
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) !== 'remote'
  const loaded = useComputeStore((state) => state.isLoaded)
  const reload = useComputeStore((state) => state.loadHosts)
  const group = groups[backend]
  const websiteLabel =
    group.website && t('Open the {{appName}} website', { appName: group.website.name })
  const provider = computeAccountProviderForBackend(backend)
  const [connectingForAdd, setConnectingForAdd] = useState(false)
  const configured = targets.length > 0
  const account = useComputeAccount(local ? provider : undefined, configured)
  const accountAvailable = Boolean(provider && local && computeAccountActionsAvailable())
  const showAccountStatus = accountAvailable && configured
  const connected = account.status?.state === 'connected' && !account.error
  const canVerify =
    local &&
    typeof window.api?.compute?.verifyTarget === 'function' &&
    (backend === 'ray' || (Boolean(provider) && connected && !account.busy))
  const newTarget = (): void => onNavigate({ kind: 'target-editor', backend })
  return (
    <SettingsSection
      separated
      title={t(group.title)}
      headerClassName="items-center"
      titleAccessory={
        <>
          {group.website && websiteLabel && (
            <Button asChild variant="ghost" size="icon-xs" className="text-muted-foreground">
              <a
                href={group.website.url}
                target="_blank"
                rel="noreferrer"
                aria-label={websiteLabel}
                title={websiteLabel}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </Button>
          )}
          {showAccountStatus && (
            <Badge
              role="status"
              variant="secondary"
              title={connected ? account.status?.identity : undefined}
              className={
                connected
                  ? 'bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface/40 dark:text-status-success-dark-foreground'
                  : undefined
              }
            >
              {computeAccountStatusLabel(account, t)}
            </Badge>
          )}
        </>
      }
      icon={
        <img
          src={group.icon}
          alt=""
          className={
            backend === 'ray' || backend === 'kubernetes' ? 'size-5 dark:invert' : 'size-5'
          }
        />
      }
      action={
        local && (
          <ComputeAddButton
            label={t(computeTargetAddLabels[backend])}
            disabled={Boolean(provider && !accountAvailable)}
            onClick={() => (provider && !connected ? setConnectingForAdd(true) : newTarget())}
          />
        )
      }
    >
      {accountAvailable && provider && (
        <ComputeAccountDialog
          description={t(COMPUTE_ACCOUNT_CONNECTION_REQUIRED)}
          provider={provider}
          account={account}
          open={connectingForAdd}
          onClose={() => setConnectingForAdd(false)}
          onConnected={() => {
            setConnectingForAdd(false)
            newTarget()
          }}
        />
      )}
      {loadError && (
        <ErrorNotice role="alert" description={t("Couldn't load hosts.")}>
          <DiagnosticDetails detail={loadError} />
        </ErrorNotice>
      )}
      {targets.length > 0 ? (
        <TooltipProvider delayDuration={200}>
          <ul className="divide-y divide-border">
            {targets.map((target) => (
              <ComputeTargetRow
                key={target.providerId}
                target={target}
                description={describe(target)}
                local={local}
                verificationScope={
                  canVerify
                    ? JSON.stringify([account.status?.identity, account.status?.source, target])
                    : undefined
                }
                onEdit={() =>
                  onNavigate({ kind: 'target-editor', backend, providerId: target.providerId })
                }
                onRemoved={() => void reload()}
              />
            ))}
          </ul>
        </TooltipProvider>
      ) : (
        !loadError && (
          <p className="py-1 text-sm text-muted-foreground">
            {loaded ? t('Not configured') : t('Loading…')}
          </p>
        )
      )}
    </SettingsSection>
  )
}
