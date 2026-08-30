/* Hallmark · RestoreDefaultPermissionsButton 8-state development preview; not mounted in production. */
import {
  RestoreDefaultPermissionsButton,
  type RestoreDefaultPermissionsPreviewState
} from './RestoreDefaultPermissionsButton'

const STATES: RestoreDefaultPermissionsPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const RestoreDefaultPermissionsButtonPreview = (): React.JSX.Element => (
  <div className="grid max-w-xl gap-3 bg-background p-5 text-foreground">
    {STATES.map((state) => (
      <div
        key={state}
        className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-[6rem_minmax(0,1fr)]"
      >
        <span className="text-xs text-muted-foreground">{state}</span>
        <RestoreDefaultPermissionsButton
          state={state === 'loading' || state === 'error' || state === 'success' ? state : 'idle'}
          previewState={state}
          onRestore={() => undefined}
        />
      </div>
    ))}
  </div>
)

export { RestoreDefaultPermissionsButtonPreview }
