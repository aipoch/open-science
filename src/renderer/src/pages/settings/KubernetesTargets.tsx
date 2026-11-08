import { ComputeHostRemovalDialog } from './ComputeHostRemovalDialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useComputeStore } from '@/stores/compute-store'
import type { KubernetesTargetConfig } from '../../../../shared/compute'

const fields = [
  ['displayName', 'Name'],
  ['context', 'Context'],
  ['namespace', 'Namespace'],
  ['image', 'Image'],
  ['transferImage', 'Transfer image']
] as const

export function KubernetesTargets(): React.JSX.Element {
  const { t } = useTranslation()
  const local =
    typeof document === 'undefined' ||
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) !== 'remote'
  const targets = useComputeStore((state) => state.kubernetesTargets)
  const loadError = useComputeStore((state) => state.kubernetesLoadError)
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
        <h3 className="text-base font-medium">{t('Kubernetes targets')}</h3>
        {local && !adding && (
          <Button variant="outline" disabled={busy} onClick={() => setAdding(true)}>
            {t('Add Kubernetes target')}
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
            <p className="font-mono text-xs text-muted-foreground">
              {target.context} / {target.namespace}
            </p>
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
            const config: KubernetesTargetConfig = {
              displayName: String(data.get('displayName')),
              context: String(data.get('context')),
              namespace: String(data.get('namespace')),
              image: String(data.get('image')),
              transferImage: String(data.get('transferImage')),
              sizeMiB: Number(data.get('sizeMiB'))
            }
            void submit(() => window.api.compute.createKubernetesTarget(config))
          }}
        >
          {fields.map(([key, label]) => (
            <label className="grid gap-1 text-sm" key={key}>
              {t(label)}
              <Input name={key} required disabled={busy} />
            </label>
          ))}
          <label className="grid gap-1 text-sm">
            {t('Volume size (MiB)')}
            <Input
              name="sizeMiB"
              type="number"
              min="1"
              max="2147483647"
              step="1"
              required
              defaultValue="1024"
              disabled={busy}
            />
          </label>
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
