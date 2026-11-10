import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import type {
  ComputePythonFailure,
  ComputePythonSelection
} from '../../../../shared/compute-python-runtime'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type { ComputePythonEnvironment } from './use-compute-python-environment'
const MANAGED_OPTION = 'managed'
function reasonLabel(
  reason: ComputePythonFailure,
  t: ReturnType<typeof useTranslation>['t'],
  provider: string
): string {
  switch (reason) {
    case 'disabled':
      return t(
        'This Python environment is disabled. Choose another environment or enable it in Runtimes.'
      )
    case 'recovery':
      return t(
        'This Python environment needs recovery. Review it in Runtimes or choose another environment.'
      )
    case 'install':
      return t('Could not prepare {{provider}} support. Retry or choose another environment.', {
        provider
      })
    case 'storage':
      return t('Could not save the Python environment. Try again.')
    case 'runtime-stale':
      return t('The Python environment changed. Choose it again.')
    case 'cancelled':
      return t('Preparation cancelled.')
    case 'dependency':
      return t(
        '{{provider}} is not available in this environment. Choose another environment or use Open-Science.',
        { provider }
      )
  }
}
export function ComputePythonEnvironmentControl({
  provider,
  environment,
  onSelect,
  onRetry
}: {
  provider: string
  environment: ComputePythonEnvironment
  onSelect: (selection: ComputePythonSelection) => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const picker = useRef<HTMLSelectElement>(null)
  const { selection, snapshot, phase, error } = environment
  const selected = selection.kind === 'managed' ? MANAGED_OPTION : selection.pythonPath
  const candidates = snapshot?.candidates ?? []
  const changeSelection = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    onSelect(
      event.target.value === MANAGED_OPTION
        ? { kind: 'managed' }
        : { kind: 'custom', pythonPath: event.target.value }
    )
  }
  return (
    <div className="mb-4 space-y-2">
      <label htmlFor="compute-python-environment" className="text-sm font-medium">
        {t('Python environment')}
      </label>
      <div className="flex gap-2">
        <select
          id="compute-python-environment"
          ref={picker}
          value={selected}
          disabled={!snapshot}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-2 text-sm"
          onChange={changeSelection}
        >
          <option value={MANAGED_OPTION}>{t('Open-Science (recommended)')}</option>
          {selection.kind === 'custom' &&
            !candidates.some((candidate) => candidate.interpreterPath === selected) && (
              <option value={selected}>
                {selection.kind === 'custom' ? selection.pythonPath : null}
              </option>
            )}
          {candidates.map((candidate) => (
            <option key={candidate.interpreterPath} value={candidate.interpreterPath}>
              {candidate.version
                ? t('{{name}} · Python {{version}}', {
                    name: candidate.label,
                    version: candidate.version
                  })
                : candidate.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          disabled={!snapshot}
          onClick={async () => {
            const path = await window.api.runtime.pickInterpreter()
            if (path) onSelect({ kind: 'custom', pythonPath: path })
          }}
        >
          {t('Browse…')}
        </Button>
      </div>
      {selection.kind === 'custom' && (
        <p className="break-all text-xs text-muted-foreground" dir="auto">
          {selection.pythonPath}
        </p>
      )}
      {(phase === 'preparing' || phase === 'checking') && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {phase === 'preparing'
            ? t('Preparing {{provider}}…', { provider })
            : t('Checking environment…')}
        </p>
      )}
      {error && (
        <ErrorNotice
          inline
          role="alert"
          description={reasonLabel(error, t, provider)}
          primaryButton={{ label: t('Retry'), onClick: onRetry }}
          secondaryButton={{
            label: t('Use another environment'),
            onClick: () => {
              picker.current?.focus()
              try {
                picker.current?.showPicker()
              } catch {
                /* Focus remains available where showPicker is unsupported. */
              }
            }
          }}
        />
      )}
    </div>
  )
}
