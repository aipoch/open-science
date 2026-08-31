/* Hallmark · DeviceCredentialEditor 8-state development preview; not mounted in production. */
import { DeviceCredentialEditor } from './DeviceCredentialEditor'

const STATES = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
] as const

export const DeviceCredentialEditorPreview = (): React.JSX.Element => (
  <div className="grid gap-5 bg-background p-5 text-foreground">
    {STATES.map((state) => (
      <section key={state} className="rounded-xl border border-border">
        <p className="px-5 pt-4 text-xs text-muted-foreground">{state}</p>
        <DeviceCredentialEditor
          previewState={state}
          onDone={() => undefined}
          onCancel={() => undefined}
        />
      </section>
    ))}
  </div>
)
