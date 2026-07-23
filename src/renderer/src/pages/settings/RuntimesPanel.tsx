import { CheckCircle2, FolderInput, RefreshCw } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import {
  isEnvEnabled,
  type DiscoveredInterpreter,
  type RuntimeEnablement,
  type RuntimeUsage
} from '../../../../shared/notebook-runtime'
import type { NotebookLanguage } from '../../../../shared/notebook'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'
import { PythonIcon, RIcon } from './language-icons'

// v4 Runtime Registry write surface: one CARD per discovered interpreter per language. Each card can
// be enabled/disabled (the agent only ever sees enabled envs); external envs additionally expose a
// separate, high-risk "allow package install" opt-in. A separate section drives the app-managed
// acquisition/download flow, and "Add interpreter…" registers the user's own interpreter into the
// discovery catalog. Effective enable/auth state loads from the PERSISTED per-language enablement
// (runtime.getEnablement), then refreshes from each setter's returned enablement.

const LANGUAGES: ReadonlyArray<{ id: NotebookLanguage; label: string; icon: React.JSX.Element }> = [
  { id: 'python', label: 'Python', icon: <PythonIcon /> },
  { id: 'r', label: 'R', icon: <RIcon /> }
]

type EnvLists = { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }
type Enablements = Partial<Record<NotebookLanguage, RuntimeEnablement>>

type RuntimesPanelProps = {
  title: string
  description: React.ReactNode
}

// Human provider/type for the card badge (provenance + conda env name), e.g. "App-managed",
// "Conda: bio", "System".
const providerType = (env: DiscoveredInterpreter): string => {
  if (env.provenance === 'app-managed') return 'App-managed'
  if (env.provenance === 'agent-created') return 'Agent-created'
  if (env.condaEnv) return `Conda: ${env.condaEnv}`
  return 'System'
}

// One-line readiness for a discovered env: version plus runnable/gap detail.
const envReadyLine = (env: DiscoveredInterpreter): string => {
  const version = env.version ? ` · ${env.version}` : ''
  return env.runnable ? `Ready${version}` : `${env.detail ?? 'Not runnable'}${version}`
}

const managedLine = (runnable: boolean, preparing: boolean, message?: string): string => {
  if (preparing) return message ?? 'Downloading managed runtime…'
  return runnable ? 'Installed and ready' : 'Managed runtime is not set up yet'
}

const RuntimesPanel = ({ title, description }: RuntimesPanelProps): React.JSX.Element => {
  const [envs, setEnvs] = useState<EnvLists | null>(null)
  const [enablement, setEnablement] = useState<Enablements>({})
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set while confirming a disable that would affect live sessions (WS11): the runtime being disabled
  // plus its current usage, so the dialog can warn before revoking.
  const [disableImpact, setDisableImpact] = useState<{
    language: NotebookLanguage
    env: DiscoveredInterpreter
    usage: RuntimeUsage
  } | null>(null)
  const initEnv = useNotebookEnvStore((state) => state.init)
  const provisionEnv = useNotebookEnvStore((state) => state.provision)
  const cancelEnv = useNotebookEnvStore((state) => state.cancel)
  const resetEnv = useNotebookEnvStore((state) => state.reset)
  // Per-language provisioning state: python and R each track their own progress/preparing/error, so
  // requesting one never makes the other's card look cancelled (the provisioner serializes the runs).
  const byLang = useNotebookEnvStore((state) => state.byLang)

  useEffect(() => {
    void initEnv()
  }, [initEnv])

  // On failure fall back to empty results (a recoverable "couldn't detect" state with Recheck)
  // rather than hanging on "Detecting…" forever. Loads the discovered envs plus the PERSISTED
  // enablement for both languages so cards show their saved enabled/install-auth state on open.
  const fetchAll = (): Promise<[EnvLists, Enablements]> =>
    Promise.all([
      window.api.runtime.listEnvironments().catch(() => ({ python: [], r: [] }) as EnvLists),
      window.api.runtime.getEnablement('python').catch(() => undefined),
      window.api.runtime.getEnablement('r').catch(() => undefined)
    ]).then(([nextEnvs, python, r]) => [nextEnvs, { python, r }])

  // Commit discovery and persisted permissions as one snapshot. Mixing a fresh interpreter list
  // with stale enablement could briefly expose the wrong toggle or package-install authorization.
  const applyAll = ([nextEnvs, nextEnablement]: [EnvLists, Enablements]): void => {
    setEnvs(nextEnvs)
    setEnablement(nextEnablement)
    setLoaded(true)
  }

  useEffect(() => {
    void fetchAll().then(applyAll)
  }, [])

  // Recheck refreshes both halves of the runtime registry together for the same reason as initial
  // loading: cards and their permissions must describe one coherent backend snapshot.
  const recheck = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not re-check runtimes.')
    } finally {
      setBusy(false)
    }
  }

  const isEnabled = (language: NotebookLanguage, env: DiscoveredInterpreter): boolean =>
    isEnvEnabled(env, enablement[language])

  const isInstallAuthorized = (language: NotebookLanguage, env: DiscoveredInterpreter): boolean =>
    enablement[language]?.installAuthorized[env.envId] ?? false

  const applyEnabled = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter,
    enabled: boolean,
    force?: boolean
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // set-environment-enabled rejects when it would disable the LAST enabled env for a language
      // (the ">= 1 usable" invariant); surface that reason inline instead of silently no-op'ing.
      // force (disable only) aborts a running cell now instead of draining.
      const next = await window.api.runtime.setEnvironmentEnabled(
        language,
        env.envId,
        enabled,
        force
      )
      setEnablement((current) => ({ ...current, [language]: next }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change that runtime.')
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): Promise<void> => {
    // Enabling never affects live sessions — apply immediately.
    if (!isEnabled(language, env)) {
      await applyEnabled(language, env, true)
      return
    }
    // Disabling: warn first if live sessions are using it. Dormant-only (bound but no live kernel) or
    // no usage disables straight away; running/idle sessions get a confirm dialog (WS11).
    const usage = await window.api.runtime
      .describeUsage(language, env.envId)
      .catch(() => ({ running: 0, idle: 0, dormant: 0 }) as RuntimeUsage)
    if (usage.running + usage.idle > 0) {
      setDisableImpact({ language, env, usage })
      return
    }
    await applyEnabled(language, env, false)
  }

  // Disable after current work finishes (drain) — the default, safe option.
  const confirmDisable = async (): Promise<void> => {
    if (!disableImpact) return
    const { language, env } = disableImpact
    setDisableImpact(null)
    await applyEnabled(language, env, false)
  }

  // Stop running work and disable now (force) — aborts a running cell (recorded cancelled).
  const confirmForceStop = async (): Promise<void> => {
    if (!disableImpact) return
    const { language, env } = disableImpact
    setDisableImpact(null)
    await applyEnabled(language, env, false, true)
  }

  const toggleInstallAuthorized = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.runtime.setInstallAuthorized(
        language,
        env.envId,
        !isInstallAuthorized(language, env)
      )
      setEnablement((current) => ({ ...current, [language]: next }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change package-install authorization.')
    } finally {
      setBusy(false)
    }
  }

  const addInterpreter = async (language: NotebookLanguage): Promise<void> => {
    const path = await window.api.runtime.pickInterpreter()
    if (!path) return
    setBusy(true)
    setError(null)
    try {
      // Add the picked path to the discovery catalog; it then surfaces as a (user-own) card once
      // discovery probes it. It starts DISABLED (user-own default) — the user enables it explicitly.
      await window.api.runtime.registerInterpreter(language, path)
      const nextEnvs = await window.api.runtime.listEnvironments()
      setEnvs(nextEnvs)
      // Best-effort: enable the just-added env so it is usable immediately.
      const added = nextEnvs[language].find((env) => env.interpreterPath === path)
      if (added && !isEnvEnabled(added, enablement[language])) {
        const next = await window.api.runtime.setEnvironmentEnabled(language, added.envId, true)
        setEnablement((current) => ({ ...current, [language]: next }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that interpreter.')
    } finally {
      setBusy(false)
    }
  }

  const provisionManaged = async (language: NotebookLanguage): Promise<void> => {
    // Provisioning deliberately avoids the panel-wide busy flag. Per-language store state marks only
    // the active runtime as preparing and leaves its Cancel action available throughout the download.
    setError(null)
    try {
      await provisionEnv(language)
      // The provisioner updates files and registry metadata in the main process; reload both the
      // discovered environments and persisted enablement before rendering the completed card.
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh runtime readiness.')
    }
  }

  // Explicit recovery for a recovery-BLOCKED runtime (a prior setup's worker couldn't be confirmed
  // stopped, so plain provision keeps refusing). Reset force-clears the quarantine and rebuilds.
  const resetManaged = async (language: NotebookLanguage): Promise<void> => {
    setError(null)
    try {
      await resetEnv(language)
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset the runtime.')
    }
  }

  // Cancels an in-flight app-managed download/setup so it is never a locked, un-abortable state.
  const cancelProvision = async (language: NotebookLanguage): Promise<void> => {
    setError(null)
    try {
      await cancelEnv(language)
      applyAll(await fetchAll())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the setup.')
    }
  }

  // Managed readiness is derived from discovery: the app-managed env for a language is present and
  // runnable once it is set up (replaces the old survey().managed readiness).
  const managedRunnableFor = (language: NotebookLanguage): boolean =>
    (envs?.[language] ?? []).some((env) => env.provenance === 'app-managed' && env.runnable)

  // One environment card (detected app-managed or user-own): identity + readiness + enable toggle,
  // plus the install-authorization row for an enabled external env. Shared by the managed-first card
  // and each own interpreter so they render identically.
  const renderEnvCard = (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): React.JSX.Element => {
    const enabled = isEnabled(language, env)
    const external = env.provenance !== 'app-managed'
    return (
      <div
        key={env.envId}
        data-testid="runtime-card"
        className="rounded-lg border border-border bg-card p-3"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{env.label}</span>
              <Badge variant="secondary">{providerType(env)}</Badge>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[13px] text-muted-foreground">
              {env.runnable ? (
                <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
              ) : null}
              <span>{envReadyLine(env)}</span>
            </div>
            <code className="mt-1 block truncate text-xs text-muted-foreground">
              {env.interpreterPath}
            </code>
          </div>
          <SettingsToggle
            enabled={enabled}
            onToggle={() => void toggleEnabled(language, env)}
            disabled={busy}
            aria-label={`Enable ${env.label}`}
          />
        </div>

        {external && enabled ? (
          <div className="mt-3 border-t border-border pt-3">
            <SettingsRow
              className="min-h-0 py-0"
              label="Allow package install"
              description="Lets Open Science install packages into this environment. Installs go to your own environment, not the app-managed storage."
            >
              <div className="flex justify-end">
                <SettingsToggle
                  enabled={isInstallAuthorized(language, env)}
                  onToggle={() => void toggleInstallAuthorized(language, env)}
                  disabled={busy}
                  aria-label={`Allow package install for ${env.label}`}
                />
              </div>
            </SettingsRow>
          </div>
        ) : null}
      </div>
    )
  }

  const loading = !loaded || envs === null

  return (
    <div className="p-5" data-testid="runtimes-panel">
      <SettingsSection
        title={title}
        description={description}
        aria-label={title}
        contentClassName="space-y-5"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void recheck()}
            disabled={busy}
          >
            <RefreshCw className={cn(busy && 'animate-spin')} aria-hidden="true" />
            Recheck
          </Button>
        }
      >
        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="runtimes-error">
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Detecting runtimes…</p>
        ) : (
          LANGUAGES.map(({ id, label, icon }) => {
            const list = envs[id]
            // Per-language provisioning state — set immediately on click and cleared when THIS language's
            // run settles, independent of the other language (fixes the concurrent python/R phantom-cancel).
            const langState = byLang[id]
            const preparing = langState?.preparing ?? false
            const langProgress = langState?.progress
            const langError = langState?.error
            const managedRunnable = managedRunnableFor(id)

            // App-managed goes FIRST; the user's own detected interpreters follow. A provisioned
            // app-managed env appears in `list` (provenance app-managed) and renders as a normal card;
            // when it isn't set up yet there is no such entry, so a setup card is shown in its place.
            const managedEnv = list.find((env) => env.provenance === 'app-managed')
            const ownEnvs = list.filter((env) => env.provenance !== 'app-managed')

            return (
              <SettingsSection
                key={id}
                title={label}
                icon={icon}
                aria-label={`${label} runtime`}
                separated
                action={
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void addInterpreter(id)}
                        >
                          <FolderInput aria-hidden="true" />
                          Add interpreter…
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {id === 'r'
                          ? 'Pick your Rscript executable — e.g. Rscript.exe (Windows) or bin/Rscript (macOS/Linux). Choose the file, not a folder.'
                          : 'Pick your Python interpreter executable — e.g. python.exe (Windows) or bin/python (macOS/Linux). Choose the file, not a folder.'}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                }
              >
                <div className="space-y-2" data-testid={`runtimes-cards-${id}`}>
                  {/* App-managed FIRST: a real card once provisioned, else a setup card in the same frame. */}
                  {managedEnv ? (
                    <>
                      {renderEnvCard(id, managedEnv)}
                      {/* An interrupted upgrade/install usually leaves the interpreter present (so the
                        card above still renders), but recovery may have quarantined its prefix. Surface
                        the block + Reset here too, or the recovery entry would be unreachable whenever a
                        runnable managed env exists. */}
                      {!preparing && langError?.includes('RUNTIME_RECOVERY_BLOCKED') ? (
                        <div
                          data-testid={`runtimes-recovery-blocked-${id}`}
                          className="flex items-start justify-between gap-4 rounded-lg border border-destructive/40 bg-card p-3"
                        >
                          <p
                            role="alert"
                            className="text-[13px] text-destructive"
                            data-testid={`runtimes-provision-error-${id}`}
                          >
                            {langError}
                          </p>
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            className="shrink-0"
                            disabled={busy}
                            onClick={() => void resetManaged(id)}
                          >
                            Reset runtime
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div
                      data-testid="runtime-card"
                      className="rounded-lg border border-border bg-card p-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              App-managed environment
                            </span>
                            <Badge variant="secondary">App-managed</Badge>
                          </div>
                          <div className="mt-0.5 text-[13px] text-muted-foreground">
                            {managedLine(managedRunnable, preparing, langProgress?.message)}
                          </div>
                          {preparing ? (
                            <div
                              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                              role="progressbar"
                              aria-label={`Setting up ${label} runtime`}
                              aria-valuenow={Math.round((langProgress?.progress ?? 0) * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300"
                                style={{
                                  width: `${Math.max(2, Math.min(100, Math.round((langProgress?.progress ?? 0) * 100)))}%`
                                }}
                              />
                            </div>
                          ) : null}
                          {!preparing && langError ? (
                            <p
                              role="alert"
                              className="mt-1 text-[13px] text-destructive"
                              data-testid={`runtimes-provision-error-${id}`}
                            >
                              {langError}
                            </p>
                          ) : null}
                        </div>
                        {preparing ? (
                          // A download/setup in progress is cancelable — never a locked, un-abortable state.
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={busy}
                            onClick={() => void cancelProvision(id)}
                          >
                            Cancel
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            className="shrink-0"
                            disabled={busy}
                            onClick={() =>
                              langError?.includes('RUNTIME_RECOVERY_BLOCKED')
                                ? void resetManaged(id)
                                : void provisionManaged(id)
                            }
                          >
                            {langError?.includes('RUNTIME_RECOVERY_BLOCKED')
                              ? 'Reset runtime'
                              : langError
                                ? 'Retry setup'
                                : 'Download and set up'}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

                  {ownEnvs.map((env) => renderEnvCard(id, env))}
                </div>
              </SettingsSection>
            )
          })
        )}
      </SettingsSection>

      <AlertDialog.Root
        open={disableImpact !== null}
        onOpenChange={(open) => {
          if (!open) setDisableImpact(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
          <AlertDialog.Content
            data-testid="disable-impact-dialog"
            className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-6 text-foreground shadow-lg"
          >
            <AlertDialog.Title className="text-base font-semibold text-foreground">
              Disable {disableImpact?.env.label}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
              It is in use by{' '}
              {(disableImpact?.usage.running ?? 0) + (disableImpact?.usage.idle ?? 0)} active
              session(s) — {disableImpact?.usage.running ?? 0} running,{' '}
              {disableImpact?.usage.idle ?? 0} idle. Disabling lets any running cell finish, then
              closes its kernel; those sessions must switch to another runtime to keep working.
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              {(disableImpact?.usage.running ?? 0) > 0 ? (
                <AlertDialog.Action asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void confirmForceStop()}
                  >
                    Stop running work
                  </Button>
                </AlertDialog.Action>
              ) : null}
              <AlertDialog.Action asChild>
                <Button type="button" onClick={() => void confirmDisable()}>
                  Disable after current work
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { RuntimesPanel }
