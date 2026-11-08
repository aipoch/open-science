import { ComputeHostRemovalDialog } from './ComputeHostRemovalDialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useComputeStore } from '@/stores/compute-store'
import type { ModalTargetConfig } from '../../../../shared/compute'

const fields = [
  ['displayName', 'Name'],
  ['environmentName', 'Modal environment'],
  ['appName', 'Modal App'],
  ['image', 'Container image'],
  ['gpu', 'GPU (optional)']
] as const

export function ModalTargets(): React.JSX.Element {
  const { t } = useTranslation()
  const local =
    typeof document === 'undefined' ||
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) !== 'remote'
  const targets = useComputeStore((state) => state.modalTargets)
  const loadError = useComputeStore((state) => state.modalLoadError)
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
        <h3 className="text-base font-medium">{t('Modal Sandbox targets')}</h3>
        {local && !adding && (
          <Button variant="outline" disabled={busy} onClick={() => setAdding(true)}>
            {t('Add Modal Sandbox target')}
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
              {target.environmentName} / {target.appName}
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
            const config: ModalTargetConfig = {
              displayName: String(data.get('displayName')),
              environmentName: String(data.get('environmentName')),
              appName: String(data.get('appName')),
              image: String(data.get('image')),
              cpus: Number(data.get('cpus')),
              memoryMiB: Number(data.get('memoryMiB')),
              ...(String(data.get('gpu') ?? '').trim() && { gpu: String(data.get('gpu')).trim() })
            }
            void submit(() => window.api.compute.createModalTarget(config))
          }}
        >
          {fields.map(([key, label]) => (
            <label className="grid gap-1 text-sm" key={key}>
              {t(label)}
              <Input name={key} required={key !== 'gpu'} disabled={busy} />
            </label>
          ))}
          {(['cpus', 'memoryMiB'] as const).map((key) => (
            <label key={key} className="grid gap-1 text-sm">
              {key === 'cpus' ? t('CPUs') : t('Memory (MiB)')}
              <Input
                name={key}
                type="number"
                min={key === 'cpus' ? '0.001' : '1'}
                step={key === 'cpus' ? 'any' : '1'}
                defaultValue={key === 'cpus' ? 1 : 1024}
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
