import { CheckCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import { deriveProvisionUi } from '../workspace/provisioning-view'
import {
  isEnvEnabled,
  type DiscoveredInterpreter,
  type RuntimeEnablement
} from '../../../../shared/notebook-runtime'

// Compact, optional runtime chooser for onboarding, on the v4 registry model (the same surface as
// Settings → Runtimes): the managed default provisions from the CDN, and instead of a raw file picker
// the user picks from interpreters the app DETECTED on this machine (PATH, Homebrew, pyenv, conda/mamba
// envs) — with a "Browse…" fallback for anything not auto-found. Enabling an interpreter here just makes
// it available to the agent; it never blocks the wizard's Continue. R is managed-only in v1.

// Sentinel value for the "Browse for an interpreter…" item in the detected-interpreter dropdown.
const BROWSE_VALUE = '__browse__'

// One-line label for a detected interpreter in the dropdown: name + version + short path tail.
const interpreterOptionLabel = (env: DiscoveredInterpreter): string => {
  const version = env.version ? ` ${env.version}` : ''
  return `${env.label}${version}`
}

const RuntimeChoiceCard = (): React.JSX.Element | null => {
  const [pythons, setPythons] = useState<DiscoveredInterpreter[] | null>(null)
  const [enablement, setEnablement] = useState<RuntimeEnablement | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Set the instant the user clicks Download, so the button flips to an enabled Cancel without waiting
  // for the first progress event (the store's preparing state covers a remount mid-download).
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provisionEnv = useNotebookEnvStore((state) => state.provision)
  const cancelEnv = useNotebookEnvStore((state) => state.cancel)
  const provisionError = useNotebookEnvStore((state) => state.error)
  // Derive the provisioning UI locally from the mirrored status/scope/progress (same as the wizard),
  // rather than reading the store's cached `ui`, so the in-card progress is consistent everywhere.
  const provStatus = useNotebookEnvStore((state) => state.status)
  const provScope = useNotebookEnvStore((state) => state.scope)
  const provProgress = useNotebookEnvStore((state) => state.progress)
  const provisionUi = deriveProvisionUi(provStatus, provScope, provProgress, provisionError)

  // Fetch (no setState) is kept separate from apply (setState) so the effect can defer the state
  // update into a .then callback rather than setting state synchronously within it (react-compiler
  // cascading-render rule — same shape as RuntimesPanel). On failure fall back to an empty list so
  // this optional card hides itself rather than hanging on "Detecting…" or breaking the wizard.
  const fetchData = (): Promise<{
    python: DiscoveredInterpreter[]
    enablement?: RuntimeEnablement
  }> =>
    Promise.all([
      window.api.runtime.listEnvironments().catch(() => ({ python: [], r: [] })),
      window.api.runtime.getEnablement('python').catch(() => undefined)
    ]).then(([envs, enablement]) => ({ python: envs.python, enablement }))

  const applyData = (data: {
    python: DiscoveredInterpreter[]
    enablement?: RuntimeEnablement
  }): void => {
    setPythons(data.python)
    setEnablement(data.enablement)
  }

  const load = (): Promise<void> => fetchData().then(applyData)

  useEffect(() => {
    void fetchData().then(applyData)
  }, [])

  // Render immediately (with a "Detecting…" hint) rather than hiding until discovery's subprocess
  // probes resolve — the card appearing late felt like a hang. `pythons === null` = still detecting.
  const detecting = pythons === null
  const list = pythons ?? []

  // The managed default is present+runnable once set up; before that it is offered via "Download and
  // set up" regardless of whether it is on disk yet (it won't appear in discovery until provisioned).
  const managedRunnable = list.some((env) => env.provenance === 'app-managed' && env.runnable)
  // Interpreters the user already had (not app-managed) — the dropdown choices.
  const ownInterpreters = list.filter((env) => env.provenance === 'user-own')
  const enabledOwn = ownInterpreters.filter((env) => isEnvEnabled(env, enablement))

  const enableEnv = async (envId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.runtime.setEnvironmentEnabled('python', envId, true)
      setEnablement(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that interpreter.')
    } finally {
      setBusy(false)
    }
  }

  // Browse fallback: register a manually-picked interpreter into discovery, then enable it once it
  // surfaces as a card. Used only for interpreters not auto-detected on PATH / in a conda root.
  const browseForInterpreter = async (): Promise<void> => {
    const path = await window.api.runtime.pickInterpreter()
    if (!path) return
    setBusy(true)
    setError(null)
    try {
      await window.api.runtime.registerInterpreter('python', path)
      // Re-discover, then enable by the DISCOVERED envId (a symlinked pick resolves to its realpath,
      // which is the enablement key — enabling by the raw path would leave it disabled).
      const data = await fetchData()
      applyData(data)
      const match = data.python.find((env) => env.interpreterPath === path || env.envId === path)
      await window.api.runtime
        .setEnvironmentEnabled('python', match?.envId ?? path, true)
        .then(setEnablement)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that interpreter.')
    } finally {
      setBusy(false)
    }
  }

  const onSelect = (value: string): void => {
    if (value === BROWSE_VALUE) {
      void browseForInterpreter()
      return
    }
    void enableEnv(value)
  }

  // Don't hold `busy` for the whole download — that would keep Cancel disabled for the entire setup.
  // `starting` (immediate) + the store's preparing state drive the buttons instead, leaving Cancel
  // clickable throughout.
  const setupManaged = async (): Promise<void> => {
    setError(null)
    setStarting(true)
    try {
      await provisionEnv('python')
      await load()
    } finally {
      setStarting(false)
    }
  }

  const cancelSetup = async (): Promise<void> => {
    setError(null)
    try {
      await cancelEnv('python')
      await load()
    } finally {
      setStarting(false)
    }
  }

  const managedPreparing =
    starting || (provisionUi.kind === 'preparing' && provisionUi.scope === 'python')

  return (
    <section
      aria-label="Notebook runtime"
      className="rounded-lg bg-bg-10 px-4 py-3 ring-1 ring-border-200"
    >
      <p className="text-sm font-medium text-text-000">Notebook runtime</p>
      <p className="mt-0.5 text-xs leading-relaxed text-text-100">
        Notebooks run in an app-managed Python environment by default. Optional: use a Python
        interpreter already installed on this machine instead.
      </p>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1 text-xs text-text-100">
            {/* A not-yet-built managed default is EXPECTED (it provisions automatically on first use),
                so it shows a neutral setup note rather than an alarm that makes the recommended default
                look broken. */}
            <CheckCircle2
              className={managedRunnable ? 'size-3.5 text-primary' : 'size-3.5 text-text-300'}
              aria-hidden="true"
            />
            App-managed environment ·{' '}
            {managedRunnable
              ? 'Ready'
              : provisionUi.kind === 'preparing'
                ? provisionUi.message
                : managedPreparing
                  ? 'Setting up…'
                  : 'not set up yet'}
          </p>
          {managedPreparing && provisionUi.kind === 'preparing' ? (
            <>
              {/* §3.1: overall provision bar + the download sub-line coexist (the download is one
                  phase of provisioning), matching the notebook-gate surface. */}
              <div
                className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-300"
                role="progressbar"
                aria-label="Setting up the app-managed Python environment"
                aria-valuenow={Math.round(provisionUi.progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{
                    width: `${Math.max(2, Math.min(100, Math.round(provisionUi.progress * 100)))}%`
                  }}
                />
              </div>
              {provisionUi.download ? (
                <div className="mt-2 w-full max-w-xs">
                  <DownloadProgressLine progress={provisionUi.download} />
                </div>
              ) : null}
            </>
          ) : null}
          {enabledOwn.length > 0 ? (
            <p className="mt-1 truncate text-[11px] text-text-100">
              Using your own:{' '}
              <span className="font-mono">
                {enabledOwn.map((env) => interpreterOptionLabel(env)).join(', ')}
              </span>
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {managedPreparing ? (
            // A setup in progress is cancelable — the wizard blocks Continue until it finishes or is
            // cancelled, so this is the way to back out.
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void cancelSetup()}
            >
              Cancel
            </Button>
          ) : !managedRunnable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void setupManaged()}
            >
              {provisionError ? 'Retry setup' : 'Download and set up'}
            </Button>
          ) : null}
          {/* Detected interpreters as a dropdown — no raw file dialog for the common case. Acts as a
              menu (no persistent value): each pick enables that interpreter, then resets. Disabled
              while detection is still running so it never looks empty-then-populated mid-click. */}
          <Select value="" onValueChange={onSelect} disabled={busy || detecting}>
            <SelectTrigger className="w-64" aria-label="Use my own Python interpreter">
              <span className="truncate text-text-100">
                {detecting ? 'Detecting interpreters…' : 'Use my own interpreter…'}
              </span>
            </SelectTrigger>
            <SelectContent>
              {ownInterpreters.map((env) => (
                // Two lines so near-identical labels are distinguishable: name + version, then path.
                <SelectItem key={env.envId} value={env.envId}>
                  <span className="flex flex-col">
                    <span className="text-[13px] text-text-000">{interpreterOptionLabel(env)}</span>
                    <span className="font-mono text-[11px] text-text-300">
                      {env.interpreterPath}
                    </span>
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={BROWSE_VALUE}>Browse for an interpreter…</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-danger-000">
          {error}
        </p>
      )}
      {error === null && provisionError !== undefined ? (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-danger-000">
          {provisionError}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-text-300">
        R runs in the app-managed environment. You can change any of this later in Settings →
        Runtimes.
      </p>
    </section>
  )
}

export { RuntimeChoiceCard }
