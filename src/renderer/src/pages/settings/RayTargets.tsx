import { ComputeHostRemovalDialog } from './ComputeHostRemovalDialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useComputeStore } from '@/stores/compute-store'
import type { RayTargetConfig } from '../../../../shared/compute'

const fields = [
  ['displayName', 'Name'],
  ['endpoint', 'Ray Dashboard URL'],
  ['sharedRoot', 'Local shared directory'],
  ['remoteRoot', 'Driver shared directory']
] as const

export function RayTargets(): React.JSX.Element {
  const { t } = useTranslation()
  const local =
    typeof document === 'undefined' ||
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) !== 'remote'
  const targets = useComputeStore((state) => state.rayTargets)
  const loadError = useComputeStore((state) => state.rayLoadError)
  const reload = useComputeStore((state) => state.loadHosts)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      await reload()
      setAdding(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-8 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-base font-medium">{t('Ray Jobs targets')}</h3>
        {local && !adding && (
          <Button variant="outline" disabled={busy} onClick={() => setAdding(true)}>
            {t('Add Ray Jobs target')}
          </Button>
        )}
      </div>
      {targets.map((target) => (
        <div
          key={target.id}
          className="flex items-center justify-between gap-4 rounded-xl border px-3 py-2"
        >
          <div>
            <span>{target.displayName}</span>
            <p className="font-mono text-xs text-muted-foreground">{target.endpoint}</p>
          </div>
          {local && (
            <TooltipProvider>
              <ComputeHostRemovalDialog host={target} onRemoved={() => void reload()} />
            </TooltipProvider>
          )}
        </div>
      ))}
      {adding && (
        <form
          className="grid gap-3 rounded-xl border p-4"
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const config: RayTargetConfig = {
              displayName: String(data.get('displayName')),
              endpoint: String(data.get('endpoint')),
              sharedRoot: String(data.get('sharedRoot')),
              remoteRoot: String(data.get('remoteRoot')),
              cpus: Number(data.get('cpus')),
              gpus: Number(data.get('gpus'))
            }
            void submit(() => window.api.compute.createRayTarget(config))
          }}
        >
          {fields.map(([key, label]) => (
            <label className="grid gap-1 text-sm" key={key}>
              {t(label)}
              <Input name={key} required disabled={busy} />
            </label>
          ))}
          {(['cpus', 'gpus'] as const).map((key) => (
            <label key={key} className="grid gap-1 text-sm">
              {key === 'cpus' ? t('CPUs') : t('GPUs')}
              <Input
                name={key}
                type="number"
                min="0"
                step="any"
                defaultValue={key === 'cpus' ? 1 : 0}
                required
                disabled={busy}
              />
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              {t('Cancel')}
            </Button>
            <Button disabled={busy} type="submit">
              {t('Save')}
            </Button>
          </div>
        </form>
      )}
      {(error || loadError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || loadError}
        </p>
      )}
    </section>
  )
}
