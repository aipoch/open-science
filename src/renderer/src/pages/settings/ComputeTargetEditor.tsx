import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ComputeAccountDialog } from './ComputeAccountControls'
import { computeAccountActionsAvailable, useComputeAccount } from './use-compute-account'
import {
  COMPUTE_ACCOUNT_CONNECTION_REQUIRED,
  type ComputeAccountProvider
} from '../../../../shared/compute-accounts'
import { useTranslation } from 'react-i18next'
import type { ExternalComputeTarget } from '../../../../shared/compute'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  computeAccountProviderForBackend,
  type ComputeTargetBackend,
  type ComputeTargetEditorView
} from '@/lib/settings-navigation'
import { useComputeStore } from '@/stores/compute-store'
import type { SettingsEditorLeaveState } from './SettingsLayout'

type Field = {
  name: string
  label: string
  paired?: boolean
  optional?: boolean
  initial?: number
  min?: number
  max?: number
  step?: number | 'any'
}
const name: Field = { name: 'displayName', label: 'Name' }
const image: Field = { name: 'image', label: 'Container image' }
const fields: Record<ComputeTargetBackend, readonly Field[]> = {
  hosted: [
    name,
    { name: 'bucket', label: 'Private bucket (owner/name)' },
    { name: 'namespace', label: 'Billing namespace' },
    image,
    { name: 'flavor', paired: true, label: 'Hardware flavor' },
    {
      name: 'timeoutSeconds',
      paired: true,
      label: 'Timeout (seconds)',
      min: 1,
      max: 604800,
      initial: 14400
    }
  ],
  modal: [
    name,
    { name: 'environmentName', paired: true, label: 'Modal environment' },
    { name: 'appName', paired: true, label: 'Modal App' },
    image,
    { name: 'cpus', paired: true, label: 'CPUs', min: 0.001, step: 'any', initial: 1 },
    { name: 'memoryMiB', paired: true, label: 'Memory (MiB)', min: 1, initial: 1024 },
    { name: 'gpu', label: 'GPU (optional)', optional: true }
  ],
  kubernetes: [
    name,
    { name: 'context', paired: true, label: 'Context' },
    { name: 'namespace', paired: true, label: 'Namespace' },
    image,
    { name: 'transferImage', label: 'Transfer image' },
    { name: 'sizeMiB', label: 'Volume size (MiB)', min: 1, max: 2147483647, initial: 1024 }
  ],
  ray: [
    name,
    { name: 'endpoint', label: 'Ray Dashboard URL' },
    { name: 'sharedRoot', label: 'Local shared directory' },
    { name: 'remoteRoot', label: 'Driver shared directory' },
    { name: 'cpus', paired: true, label: 'CPUs', min: 0, step: 'any', initial: 1 },
    { name: 'gpus', paired: true, label: 'GPUs', min: 0, step: 'any', initial: 0 }
  ]
}

async function save(view: ComputeTargetEditorView, values: Record<string, string>): Promise<void> {
  const api = window.api.compute
  const { displayName, image, namespace } = values
  const { providerId } = view
  switch (view.backend) {
    case 'hosted': {
      const config = {
        displayName,
        image,
        namespace,
        bucket: values.bucket,
        flavor: values.flavor,
        timeoutSeconds: Number(values.timeoutSeconds)
      }
      if (providerId) await api.updateTarget(providerId, config)
      else await api.createHostedTarget(config)
      return
    }
    case 'modal': {
      const gpu = values.gpu.trim()
      const config = {
        displayName,
        image,
        environmentName: values.environmentName,
        appName: values.appName,
        cpus: Number(values.cpus),
        memoryMiB: Number(values.memoryMiB),
        ...(gpu && { gpu })
      }
      if (providerId) await api.updateTarget(providerId, config)
      else await api.createModalTarget(config)
      return
    }
    case 'ray': {
      const config = {
        displayName,
        endpoint: values.endpoint,
        sharedRoot: values.sharedRoot,
        remoteRoot: values.remoteRoot,
        cpus: Number(values.cpus),
        gpus: Number(values.gpus)
      }
      if (providerId) await api.updateTarget(providerId, config)
      else await api.createRayTarget(config)
      return
    }
    case 'kubernetes': {
      const config = {
        displayName,
        image,
        namespace,
        context: values.context,
        transferImage: values.transferImage,
        sizeMiB: Number(values.sizeMiB)
      }
      if (providerId) await api.updateTarget(providerId, config)
      else await api.createKubernetesTarget(config)
    }
  }
}

type Props = {
  view: ComputeTargetEditorView
  target?: ExternalComputeTarget
  onLeaveStateChange: (state: SettingsEditorLeaveState | null) => void
  onBack: () => void
}

export function ComputeTargetEditor(props: Props): React.JSX.Element {
  const { t } = useTranslation()
  const remote = document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) === 'remote'
  if (remote || (props.view.providerId && !props.target)) {
    return (
      <p role="alert" className="p-5 text-sm text-muted-foreground">
        {t('This compute configuration is no longer available.')}
      </p>
    )
  }
  const provider = computeAccountProviderForBackend(props.view.backend)
  if (!props.view.providerId && provider) {
    if (!computeAccountActionsAvailable()) {
      return (
        <p role="alert" className="p-5 text-sm text-muted-foreground">
          {t('Connection unavailable')}
        </p>
      )
    }
    return <NewAccountTargetForm {...props} provider={provider} />
  }
  return <TargetForm {...props} />
}

function NewAccountTargetForm({
  provider,
  ...props
}: Props & { provider: ComputeAccountProvider }): React.JSX.Element {
  const { t } = useTranslation()
  const account = useComputeAccount(provider)
  const [admitted, setAdmitted] = useState(false)
  const [reconnect, setReconnect] = useState(false)
  const connected = account.status?.state === 'connected' && !account.error
  // History can reopen this page after disconnect. Once admitted, keep an in-progress draft.
  if (connected && !admitted) setAdmitted(true)
  return (
    <>
      {admitted ? (
        <TargetForm
          {...props}
          onConnectionRequired={() => {
            void account.check()
            setReconnect(true)
          }}
        />
      ) : (
        !account.status &&
        !account.error && (
          <p role="status" className="p-5 text-sm text-muted-foreground">
            {t('Checking…')}
          </p>
        )
      )}
      <ComputeAccountDialog
        description={t(COMPUTE_ACCOUNT_CONNECTION_REQUIRED)}
        provider={provider}
        account={account}
        open={reconnect || (!admitted && Boolean(account.status || account.error))}
        onClose={() => {
          if (admitted) setReconnect(false)
          else props.onBack()
        }}
        onConnected={() => {
          setAdmitted(true)
          setReconnect(false)
        }}
      />
    </>
  )
}

function TargetForm({
  view,
  target,
  onLeaveStateChange,
  onBack,
  onConnectionRequired
}: Props & { onConnectionRequired?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const definitions = fields[view.backend]
  const [initial] = useState(() => {
    const stored: Readonly<Record<string, unknown>> = target ?? {}
    return Object.fromEntries(
      definitions.map((field) => [field.name, String(stored[field.name] ?? field.initial ?? '')])
    ) as Record<string, string>
  })
  const [values, setValues] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const saving = useRef(false)
  const dirty = definitions.some((field) => values[field.name] !== initial[field.name])
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onLeaveStateChange(null)
    }
  }, [onLeaveStateChange])
  useLayoutEffect(() => onLeaveStateChange({ dirty, busy }), [dirty, busy, onLeaveStateChange])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError('')
    try {
      await save(view, values)
      await useComputeStore.getState().loadHosts()
      if (mounted.current) {
        onLeaveStateChange(null)
        onBack()
      }
    } catch (err) {
      if (mounted.current) {
        const message = err instanceof Error ? err.message : String(err)
        if (onConnectionRequired && message.endsWith(COMPUTE_ACCOUNT_CONNECTION_REQUIRED)) {
          onConnectionRequired()
        } else {
          setError(message)
        }
      }
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid max-w-3xl gap-5 p-5">
      <div className="@container">
        <div className="grid gap-x-4 gap-y-4 @md:grid-cols-2">
          {definitions.map((field) => (
            <label
              key={field.name}
              className={cn('grid min-w-0 gap-1.5', !field.paired && 'col-span-full')}
            >
              <span className="text-sm font-medium text-foreground">{t(field.label)}</span>
              <Input
                name={field.name}
                type={field.min === undefined ? 'text' : 'number'}
                min={field.min}
                max={field.max}
                step={field.step}
                required={!field.optional}
                disabled={busy}
                value={values[field.name]}
                onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              />
            </label>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" disabled={busy} onClick={onBack}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={busy || (Boolean(target) && !dirty)}>
          {busy ? t('Saving…') : t('Save')}
        </Button>
      </div>
    </form>
  )
}
