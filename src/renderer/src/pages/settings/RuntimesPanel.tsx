/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · macrostructure: Workbench · genre: modern-minimal · tone: technical/austere
 * theme: existing Open Science Settings tokens · enrichment: none · motion: existing controls only
 */
import { CheckCircle2, FolderInput, Package, RefreshCw, Search, X } from 'lucide-react'
import { AlertDialog, Dialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Input } from '@/components/ui/input'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { cn } from '@/lib/utils'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useRuntimeSettingsStore } from '@/stores/runtime-settings-store'
import {
  isEnvEnabled,
  type DiscoveredInterpreter,
  type EnvPackage,
  type RuntimeUsage
} from '../../../../shared/notebook-runtime'
import type { NotebookLanguage } from '../../../../shared/notebook'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'
import {
  getSettingsSearchKeyShortcuts,
  useSettingsSearchShortcut
} from './settings-search-shortcut'
import { PythonIcon, RIcon } from './language-icons'
import { NotebookNetworkProtectionBanner } from './NotebookNetworkProtectionBanner'
import { envReadyLine, managedLine, providerType } from './runtimes-panel-view'

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

const DEFAULT_ENV_BY_LANGUAGE: Record<NotebookLanguage, string> = {
  python: 'default-python',
  r: 'default-r'
}

const isDefaultManagedRuntime = (language: NotebookLanguage, env: DiscoveredInterpreter): boolean =>
  env.provenance === 'app-managed' && env.condaEnv === DEFAULT_ENV_BY_LANGUAGE[language]

type ManagedRepairRequest = {
  language: NotebookLanguage
  runtimeIdentity: string
  label: string
  action: 'reinstall' | 'reset'
}

type ManagedOperationView = {
  preparing: boolean
  finishing: boolean
  progress: number
  message?: string
  error?: string
}

type RuntimesPanelProps = {
  title: string
  description: React.ReactNode
  onOpenNetworkProtection?: () => void
}

const RuntimesPanel = ({
  title,
  description,
  onOpenNetworkProtection
}: RuntimesPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const envs = useRuntimeSettingsStore((state) => state.envs)
  const enablement = useRuntimeSettingsStore((state) => state.enablement)
  const agentEnvironmentCreationEnabled = useRuntimeSettingsStore(
    (state) => state.agentEnvironmentCreationEnabled
  )
  const loaded = useRuntimeSettingsStore((state) => state.loaded)
  const checkedAt = useRuntimeSettingsStore((state) => state.checkedAt)
  const busy = useRuntimeSettingsStore((state) => state.busy)
  const error = useRuntimeSettingsStore((state) => state.error)
  const packageCounts = useRuntimeSettingsStore((state) => state.packageCounts)
  const loadRuntimeSettings = useRuntimeSettingsStore((state) => state.load)
  const recheckRuntimeSettings = useRuntimeSettingsStore((state) => state.recheck)
  const setBusy = useRuntimeSettingsStore((state) => state.setBusy)
  const setError = useRuntimeSettingsStore((state) => state.setError)
  const setEnablement = useRuntimeSettingsStore((state) => state.setEnablement)
  const setAgentEnvironmentCreationEnabled = useRuntimeSettingsStore(
    (state) => state.setAgentEnvironmentCreationEnabled
  )
  const updatePackageCount = useRuntimeSettingsStore((state) => state.updatePackageCount)
  const [managedOperations, setManagedOperations] = useState<
    Partial<Record<NotebookLanguage, boolean>>
  >({})
  // Set while confirming a disable that would affect live sessions (WS11): the runtime being disabled
  // plus its current usage, so the dialog can warn before revoking.
  const [disableImpact, setDisableImpact] = useState<{
    language: NotebookLanguage
    env: DiscoveredInterpreter
    usage: RuntimeUsage
  } | null>(null)
  const dialogDisableImpact = useRetainedDialogValue(disableImpact)
  const [managedRepair, setManagedRepair] = useState<ManagedRepairRequest | null>(null)
  const dialogManagedRepair = useRetainedDialogValue(managedRepair)
  // The env whose installed-packages dialog is open (null = closed).
  const [packagesEnv, setPackagesEnv] = useState<DiscoveredInterpreter | null>(null)
  const dialogPackagesEnv = useRetainedDialogValue(packagesEnv)
  // Dialog content: the fetched list, or a load error with a Retry affordance. retryNonce re-runs
  // the fetch effect without closing/reopening the dialog.
  const [packages, setPackages] = useState<EnvPackage[] | null>(null)
  const [packagesError, setPackagesError] = useState<string | null>(null)
  const [packagesRetryNonce, setPackagesRetryNonce] = useState(0)
  const [packagesFilter, setPackagesFilter] = useState('')
  const packagesFilterRef = useRef<HTMLInputElement>(null)
  useSettingsSearchShortcut(packagesFilterRef, packagesEnv !== null)
  const initEnv = useNotebookEnvStore((state) => state.init)
  const provisionEnv = useNotebookEnvStore((state) => state.provision)
  const cancelEnv = useNotebookEnvStore((state) => state.cancel)
  const resetEnv = useNotebookEnvStore((state) => state.reset)
  const statusError = useNotebookEnvStore((state) => state.statusError)
  // Per-language provisioning state: python and R each track their own progress/preparing/error, so
  // requesting one never makes the other's card look cancelled (the provisioner serializes the runs).
  const byLang = useNotebookEnvStore((state) => state.byLang)

  const languageOperationActive = (language: NotebookLanguage): boolean =>
    managedOperations[language] === true || byLang[language]?.preparing === true

  useEffect(() => {
    void initEnv()
  }, [initEnv])

  useEffect(() => {
    void loadRuntimeSettings().catch(() => undefined)
  }, [loadRuntimeSettings])

  // Fetches the open dialog's package list; re-runs on Retry via packagesRetryNonce. A successful
  // fetch also refreshes the card's count badge (the dialog shows the same truth). The loading/error
  // reset happens in the open/retry click handlers, not synchronously here (react-hooks lint).
  useEffect(() => {
    if (packagesEnv === null) return
    const env = packagesEnv
    let cancelled = false
    window.api.runtime
      .listPackages(env.language, env.envId)
      .then((list) => {
        if (cancelled) return
        setPackages(list)
        updatePackageCount(env.envId, list.length)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setPackagesError(e instanceof Error ? e.message : t('Could not list packages.'))
      })
    return () => {
      cancelled = true
    }
  }, [packagesEnv, packagesRetryNonce, t, updatePackageCount])

  // Recheck refreshes both halves of the runtime registry together for the same reason as initial
  // loading: cards and their permissions must describe one coherent backend snapshot. Counts are
  // cleared after a successful refresh so every badge refetches against the new env list; a failed
  // refresh retains both the last complete registry snapshot and its matching counts.
  const recheck = async (): Promise<void> => {
    if (LANGUAGES.some(({ id }) => languageOperationActive(id))) return
    setError(null)
    try {
      await recheckRuntimeSettings()
    } catch {
      setError('Could not re-check runtimes.')
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
    if (languageOperationActive(language)) return
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
      setEnablement(language, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not change that runtime.'))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (
    language: NotebookLanguage,
    env: DiscoveredInterpreter
  ): Promise<void> => {
    if (languageOperationActive(language)) return
    // Enabling never affects live sessions — apply immediately.
    if (!isEnabled(language, env)) {
      await applyEnabled(language, env, true)
      return
    }
    // Disabling: warn first if live sessions are using it. Dormant-only (bound but no live kernel) or
    // no usage disables straight away; running/idle sessions get a confirm dialog (WS11).
    setBusy(true)
    setError(null)
    try {
      const usage = await window.api.runtime.describeUsage(language, env.envId)
      if (usage.running + usage.idle > 0) {
        setDisableImpact({ language, env, usage })
        return
      }
    } catch {
      setError(t('Could not check whether that runtime is in use, so it was not disabled.'))
      return
    } finally {
      setBusy(false)
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
    if (languageOperationActive(language)) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.runtime.setInstallAuthorized(
        language,
        env.envId,
        !isInstallAuthorized(language, env)
      )
      setEnablement(language, next)
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t('Could not change package-install authorization.')
      )
    } finally {
      setBusy(false)
    }
  }

  const toggleAgentEnvironmentCreation = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const enabled = await window.api.runtime.setAgentEnvironmentCreationEnabled({
        enabled: !agentEnvironmentCreationEnabled
      })
      setAgentEnvironmentCreationEnabled(enabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not change Agent environment creation.'))
    } finally {
      setBusy(false)
    }
  }

  const addInterpreter = async (language: NotebookLanguage): Promise<void> => {
    if (languageOperationActive(language)) return
    setBusy(true)
    setError(null)
    try {
      const path = await window.api.runtime.pickInterpreter()
      if (!path) return
      // Add the picked path to the discovery catalog; it then surfaces as a (user-own) card once
      // discovery probes it. It starts DISABLED (user-own default) — the user enables it explicitly.
      await window.api.runtime.registerInterpreter(language, path)
      const nextSnapshot = await recheckRuntimeSettings()
      // Best-effort: enable the just-added env so it is usable immediately.
      const added = nextSnapshot.envs[language].find((env) => env.interpreterPath === path)
      if (added && !isEnvEnabled(added, nextSnapshot.enablement[language])) {
        const next = await window.api.runtime.setEnvironmentEnabled(language, added.envId, true)
        setEnablement(language, next)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not add that interpreter.'))
    } finally {
      setBusy(false)
    }
  }

  const provisionManaged = async (language: NotebookLanguage): Promise<void> => {
    if (statusError || languageOperationActive(language)) return
    // Provisioning deliberately avoids the panel-wide busy flag. Per-language store state marks only
    // the active runtime as preparing and leaves its Cancel action available throughout the download.
    setManagedOperations((current) => ({ ...current, [language]: true }))
    setError(null)
    try {
      await provisionEnv(language)
      // The provisioner updates files and registry metadata in the main process; reload both the
      // discovered environments and persisted enablement before rendering the completed card.
      await recheckRuntimeSettings()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not refresh runtime readiness.'))
    } finally {
      setManagedOperations((current) => ({ ...current, [language]: false }))
    }
  }

  // Explicit recovery for a recovery-BLOCKED runtime (a prior setup's worker couldn't be confirmed
  // stopped, so plain provision keeps refusing). Reset force-clears the quarantine and rebuilds.
  const resetManaged = async (
    language: NotebookLanguage,
    runtimeIdentity: string,
    action: ManagedRepairRequest['action']
  ): Promise<void> => {
    if (statusError || languageOperationActive(language)) return
    setManagedOperations((current) => ({ ...current, [language]: true }))
    setError(null)
    const fallbackError =
      action === 'reinstall'
        ? t('Could not reinstall the runtime.')
        : t('Could not reset the runtime.')
    try {
      await resetEnv(language, runtimeIdentity, fallbackError)
      await recheckRuntimeSettings()
    } catch {
      setError(fallbackError)
    } finally {
      setManagedOperations((current) => ({ ...current, [language]: false }))
    }
  }

  const requestManagedRepair = (
    language: NotebookLanguage,
    runtimeIdentity: string,
    label: string,
    action: ManagedRepairRequest['action']
  ): void => {
    if (busy || statusError || languageOperationActive(language)) return
    setManagedRepair({ language, runtimeIdentity, label, action })
  }

  const confirmManagedRepair = (): void => {
    if (!dialogManagedRepair) return
    const { language, runtimeIdentity, action } = dialogManagedRepair
    if (busy || statusError || languageOperationActive(language)) return
    setManagedRepair(null)
    setPackagesEnv(null)
    setPackages(null)
    void resetManaged(language, runtimeIdentity, action)
  }

  // Cancels an in-flight app-managed download/setup so it is never a locked, un-abortable state.
  const cancelProvision = async (language: NotebookLanguage): Promise<void> => {
    setError(null)
    try {
      await cancelEnv(language)
      await recheckRuntimeSettings()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not cancel the setup.'))
    }
  }

  // Managed readiness is derived from discovery: the app-managed env for a language is present and
  // runnable once it is set up (replaces the old survey().managed readiness).
  const managedRunnableFor = (language: NotebookLanguage): boolean =>
    (envs?.[language] ?? []).some((env) => isDefaultManagedRuntime(language, env) && env.runnable)

  // One environment card (detected app-managed or user-own): identity + readiness + enable toggle,
  // plus the install-authorization row for an enabled external env. Shared by the managed-first card
  // and each own interpreter so they render identically.
  const renderEnvCard = (
    language: NotebookLanguage,
    env: DiscoveredInterpreter,
    operation?: ManagedOperationView
  ): React.JSX.Element => {
    const enabled = isEnabled(language, env)
    const external = env.provenance === 'user-own'
    const operationActive = operation?.preparing === true || operation?.finishing === true
    const statusText = operationActive
      ? (operation?.message ?? (operation?.finishing ? t('Finishing setup…') : t('Reinstalling…')))
      : operation?.error
        ? t('Not runnable')
        : envReadyLine(env, t)
    const showReady = env.runnable && !operationActive && operation?.error === undefined
    const defaultManaged = isDefaultManagedRuntime(language, env)
    const recoveryBlocked = operation?.error?.includes('RUNTIME_RECOVERY_BLOCKED') === true
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
              <Badge variant="secondary">{providerType(env, t)}</Badge>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[13px] text-muted-foreground">
              {showReady ? (
                <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" />
              ) : null}
              <span>{statusText}</span>
            </div>
            {operationActive ? (
              <div
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t('Setting up {{language}} runtime', { language: env.label })}
                aria-valuenow={Math.round((operation?.progress ?? 0) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{
                    width: `${Math.max(2, Math.min(100, Math.round((operation?.progress ?? 0) * 100)))}%`
                  }}
                />
              </div>
            ) : null}
            {!operationActive && operation?.error ? (
              <p
                role="alert"
                className="mt-1 text-[13px] text-destructive"
                data-testid={`runtime-operation-error-${language}`}
              >
                {operation.error}
              </p>
            ) : null}
            <code className="mt-1 block truncate text-xs text-muted-foreground">
              {env.interpreterPath}
            </code>
          </div>
          <SettingsToggle
            enabled={enabled}
            onToggle={() => void toggleEnabled(language, env)}
            disabled={busy || languageOperationActive(language)}
            aria-label={t('Enable {{label}}', { label: env.label })}
          />
        </div>

        {env.runnable || defaultManaged ? (
          <div
            className="mt-2 flex flex-wrap items-center gap-2"
            data-testid="runtime-card-actions"
          >
            {env.runnable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="runtime-packages-button"
                disabled={busy || languageOperationActive(language)}
                onClick={() => {
                  setPackages(null)
                  setPackagesError(null)
                  setPackagesFilter('')
                  setPackagesEnv(env)
                }}
              >
                <Package aria-hidden="true" />
                {t('Packages')}
                {typeof packageCounts[env.envId] === 'number' ? (
                  <Badge variant="secondary" data-testid="runtime-packages-count">
                    {packageCounts[env.envId]}
                  </Badge>
                ) : null}
              </Button>
            ) : null}
            {defaultManaged ? (
              operationActive ? (
                <Button type="button" variant="outline" size="sm" disabled>
                  {t('Reinstalling…')}
                </Button>
              ) : recoveryBlocked ? (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  data-testid={`runtime-reset-${language}`}
                  disabled={busy || Boolean(statusError)}
                  onClick={() => requestManagedRepair(language, env.envId, env.label, 'reset')}
                >
                  {t('Reset runtime')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid={`runtime-reinstall-${language}`}
                  disabled={busy || Boolean(statusError)}
                  onClick={() => requestManagedRepair(language, env.envId, env.label, 'reinstall')}
                >
                  {t('Reinstall')}
                </Button>
              )
            ) : null}
          </div>
        ) : null}

        {external && enabled ? (
          <div className="mt-3 border-t border-border pt-3">
            <SettingsRow
              className="min-h-0 py-0"
              label={t('Allow package install')}
              description={
                language === 'r'
                  ? t(
                      'Open Science cannot install packages into user-owned R environments yet. You can still manage packages in the environment yourself.'
                    )
                  : t(
                      'Lets Open Science install packages into this environment. Installs go to your own environment, not the app-managed storage.'
                    )
              }
            >
              <div className="flex justify-end">
                <SettingsToggle
                  enabled={language !== 'r' && isInstallAuthorized(language, env)}
                  onToggle={() => void toggleInstallAuthorized(language, env)}
                  disabled={busy || language === 'r' || languageOperationActive(language)}
                  aria-label={t('Allow package install for {{label}}', { label: env.label })}
                />
              </div>
            </SettingsRow>
          </div>
        ) : null}
      </div>
    )
  }

  const loading = !loaded

  // Dialog table derivations. Build/Channel columns appear only for conda-style listings (any
  // package carrying build/channel); pip/CRAN listings get just Name/Version.
  const visiblePackages = (packages ?? []).filter((pkg) =>
    pkg.name.toLowerCase().includes(packagesFilter.trim().toLowerCase())
  )
  const hasCondaFields = (packages ?? []).some(
    (pkg) => pkg.build !== undefined || pkg.channel !== undefined
  )
  const condaPackageCount = (packages ?? []).filter(
    (pkg) => pkg.build !== undefined || pkg.channel !== undefined
  ).length

  return (
    <div className="p-5" data-testid="runtimes-panel">
      <SettingsSection
        title={title}
        description={description}
        aria-label={title}
        contentClassName="space-y-5"
        actionClassName="ml-auto"
        action={
          <div className="flex flex-col items-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="runtimes-recheck"
              onClick={() => void recheck()}
              disabled={busy || loading || LANGUAGES.some(({ id }) => languageOperationActive(id))}
            >
              <RefreshCw className={cn(busy && 'animate-spin')} aria-hidden="true" />
              {t('Recheck')}
            </Button>
            {checkedAt !== null ? (
              <span
                className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                data-testid="runtimes-checked-at"
              >
                {t('Last checked {{time}}', {
                  time: formatDate(checkedAt, 'dateTime')
                })}
              </span>
            ) : null}
          </div>
        }
      >
        {onOpenNetworkProtection ? (
          <NotebookNetworkProtectionBanner onOpen={onOpenNetworkProtection} />
        ) : null}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="runtimes-error">
            {error === 'Could not load runtimes.'
              ? t('Could not load runtimes.')
              : error === 'Could not re-check runtimes.'
                ? t('Could not re-check runtimes.')
                : error}
          </p>
        )}
        {!loading && envs !== null ? (
          <SettingsRow
            label={t('Let the Agent create environments')}
            description={t('Creates environments and sets up missing runtimes.')}
          >
            <div className="flex justify-end">
              <SettingsToggle
                enabled={agentEnvironmentCreationEnabled}
                onToggle={() => void toggleAgentEnvironmentCreation()}
                disabled={busy}
                aria-label={t('Let the Agent create environments')}
              />
            </div>
          </SettingsRow>
        ) : null}
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('Detecting runtimes…')}</p>
        ) : envs === null ? null : (
          LANGUAGES.map(({ id, label, icon }) => {
            const list = envs[id]
            // Per-language provisioning state — set immediately on click and cleared when THIS language's
            // run settles, independent of the other language (fixes the concurrent python/R phantom-cancel).
            const langState = byLang[id]
            const preparing = langState?.preparing ?? false
            const finishing = managedOperations[id] === true && !preparing
            const settingUp = preparing || finishing
            const langProgress = langState?.progress
            const progress = finishing ? 1 : (langProgress?.progress ?? 0)
            const langError = langState?.error
            const managedRunnable = managedRunnableFor(id)
            const managedEnv = list.find((env) => isDefaultManagedRuntime(id, env))
            const managedOperation: ManagedOperationView | undefined = managedEnv
              ? {
                  preparing,
                  finishing,
                  progress,
                  message: finishing ? undefined : langProgress?.message,
                  error: langError
                }
              : undefined

            // App-managed goes FIRST; the user's own detected interpreters follow. A provisioned
            // app-managed env appears in `list` (provenance app-managed) and renders as a normal card;
            // when it isn't set up yet there is no such entry, so a setup card is shown in its place.
            const ownEnvs = list.filter((env) => env !== managedEnv)

            return (
              <SettingsSection
                key={id}
                title={label}
                icon={icon}
                aria-label={t('{{label}} runtime', { label })}
                action={
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || languageOperationActive(id)}
                          onClick={() => void addInterpreter(id)}
                        >
                          <FolderInput aria-hidden="true" />
                          {t('Add interpreter…')}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {id === 'r'
                          ? t(
                              'Pick your Rscript executable — e.g. Rscript.exe (Windows) or bin/Rscript (macOS/Linux). Choose the file, not a folder.'
                            )
                          : t(
                              'Pick your Python interpreter executable — e.g. python.exe (Windows) or bin/python (macOS/Linux). Choose the file, not a folder.'
                            )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                }
              >
                <div className="space-y-2" data-testid={`runtimes-cards-${id}`}>
                  {/* App-managed FIRST: a real card once provisioned, else a setup card in the same frame. */}
                  {managedEnv ? (
                    renderEnvCard(id, managedEnv, managedOperation)
                  ) : (
                    <div
                      data-testid="runtime-card"
                      className="rounded-lg border border-border bg-card p-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {t('App-managed environment')}
                            </span>
                            <Badge variant="secondary">{t('App-managed')}</Badge>
                          </div>
                          <div className="mt-0.5 text-[13px] text-muted-foreground">
                            {managedLine(
                              managedRunnable,
                              settingUp,
                              t,
                              finishing ? t('Finishing setup…') : langProgress?.message
                            )}
                          </div>
                          {settingUp ? (
                            <div
                              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                              role="progressbar"
                              aria-label={t('Setting up {{language}} runtime', { language: label })}
                              aria-valuenow={Math.round(progress * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300"
                                style={{
                                  width: `${Math.max(2, Math.min(100, Math.round(progress * 100)))}%`
                                }}
                              />
                            </div>
                          ) : null}
                          {!settingUp && langError ? (
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
                            {t('Cancel')}
                          </Button>
                        ) : finishing ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled
                          >
                            {t('Finishing setup…')}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            className="shrink-0"
                            disabled={busy || Boolean(statusError)}
                            onClick={() =>
                              langError?.includes('RUNTIME_RECOVERY_BLOCKED')
                                ? requestManagedRepair(
                                    id,
                                    DEFAULT_ENV_BY_LANGUAGE[id],
                                    label,
                                    'reset'
                                  )
                                : void provisionManaged(id)
                            }
                          >
                            {langError?.includes('RUNTIME_RECOVERY_BLOCKED')
                              ? t('Reset runtime')
                              : langError
                                ? t('Retry setup')
                                : t('Download and set up')}
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
        open={managedRepair !== null}
        onOpenChange={(open) => {
          if (!open) setManagedRepair(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            data-testid="runtime-reinstall-dialog"
            className={dialogPanelClassName('w-[min(480px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  {dialogManagedRepair?.action === 'reset'
                    ? t('Reset {{label}}?', { label: dialogManagedRepair.label })
                    : t('Reinstall {{label}}?', { label: dialogManagedRepair?.label ?? '' })}
                </AlertDialog.Title>
              </div>
              <TooltipProvider>
                <Tooltip>
                  <AlertDialog.Cancel asChild>
                    <TooltipTrigger
                      asChild
                      onFocus={(event) => {
                        if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                      }}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('Close')}
                        className={dialogCloseButtonClassName}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                  </AlertDialog.Cancel>
                  <TooltipContent>{t('Close')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                <span>
                  {t(
                    'This deletes and recreates the app-managed {{label}} environment prefix. Active Notebook kernels will be stopped and idle kernels will be closed. Notebook files, artifacts, and other data are not deleted.',
                    { label: dialogManagedRepair?.label ?? '' }
                  )}
                </span>
                <span className="mt-2 block">
                  {t('Packages installed after the original setup may need to be installed again.')}
                </span>
              </AlertDialog.Description>
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                disabled={
                  busy ||
                  Boolean(statusError) ||
                  (dialogManagedRepair
                    ? languageOperationActive(dialogManagedRepair.language)
                    : false)
                }
                onClick={confirmManagedRepair}
              >
                {dialogManagedRepair?.action === 'reset'
                  ? t('Reset runtime')
                  : t('Reinstall runtime')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={disableImpact !== null}
        onOpenChange={(open) => {
          if (!open) setDisableImpact(null)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            data-testid="disable-impact-dialog"
            className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Disable {{label}}?', { label: dialogDisableImpact?.env.label ?? '' })}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {t(
                  'It is in use by {{total}} active session(s) — {{running}} running, {{idle}} idle. Disabling lets any running cell finish, then closes its kernel; those sessions must switch to another runtime to keep working.',
                  {
                    total:
                      (dialogDisableImpact?.usage.running ?? 0) +
                      (dialogDisableImpact?.usage.idle ?? 0),
                    running: dialogDisableImpact?.usage.running ?? 0,
                    idle: dialogDisableImpact?.usage.idle ?? 0
                  }
                )}
              </AlertDialog.Description>
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              {(dialogDisableImpact?.usage.running ?? 0) > 0 ? (
                <AlertDialog.Action asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void confirmForceStop()}
                  >
                    {t('Stop running work')}
                  </Button>
                </AlertDialog.Action>
              ) : null}
              <AlertDialog.Action asChild>
                <Button type="button" onClick={() => void confirmDisable()}>
                  {t('Disable after current work')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root
        open={packagesEnv !== null}
        onOpenChange={(open) => {
          if (!open) setPackagesEnv(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            data-testid="runtime-packages-dialog"
            className={dialogPanelClassName(
              'flex max-h-[85vh] w-[min(760px,calc(100vw-2rem))] flex-col p-0'
            )}
          >
            {dialogPackagesEnv ? (
              <>
                <div className={dialogHeaderClassName}>
                  <div className="min-w-0">
                    <Dialog.Title className={dialogTitleClassName}>
                      {t('Packages in {{label}}', { label: dialogPackagesEnv.label })}
                      {dialogPackagesEnv.version ? ` · ${dialogPackagesEnv.version}` : ''}
                    </Dialog.Title>
                    <Dialog.Description className="sr-only">
                      {t('Installed packages in this environment.')}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Close')}
                      className={dialogCloseButtonClassName}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </Dialog.Close>
                </div>

                <div className={`${dialogBodyClassName} min-h-0 flex-1 overflow-hidden`}>
                  <p className={dialogDescriptionClassName}>
                    {t('Installed packages in this environment.')}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                    <Badge variant="secondary">{providerType(dialogPackagesEnv, t)}</Badge>
                    {/* Conda env name badge — but only when the provenance badge doesn't already carry
                      it: providerType() returns the "Conda: <name>" label for user-own conda envs, so
                      the name badge is added just for app-owned (app-managed/agent-created) conda
                      envs. Comparing against the same catalog string keeps that true in any locale. */}
                    {dialogPackagesEnv.condaEnv &&
                    providerType(dialogPackagesEnv, t) !==
                      t('Conda: {{name}}', { name: dialogPackagesEnv.condaEnv }) ? (
                      <Badge variant="secondary">
                        {t('Conda: {{name}}', { name: dialogPackagesEnv.condaEnv })}
                      </Badge>
                    ) : null}
                    <Badge variant={dialogPackagesEnv.runnable ? 'secondary' : 'destructive'}>
                      {dialogPackagesEnv.runnable ? t('Ready') : t('Not runnable')}
                    </Badge>
                    <code className="truncate text-xs">{dialogPackagesEnv.interpreterPath}</code>
                  </div>

                  <div className="mt-3 flex items-center gap-3">
                    <div className="relative max-w-sm flex-1">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                      />
                      <Input
                        ref={packagesFilterRef}
                        value={packagesFilter}
                        onChange={(event) => setPackagesFilter(event.target.value)}
                        placeholder={t('Filter packages…')}
                        aria-label={t('Filter packages')}
                        aria-keyshortcuts={getSettingsSearchKeyShortcuts()}
                        data-testid="runtime-packages-filter"
                        className="pl-8"
                      />
                    </div>
                    {packages !== null ? (
                      <span className="text-xs text-muted-foreground">
                        {t('{{visible}} of {{total}}', {
                          visible: visiblePackages.length,
                          total: packages.length
                        })}
                        {hasCondaFields
                          ? ` · ${t('{{conda}} conda, {{pypi}} pypi', {
                              conda: condaPackageCount,
                              pypi: packages.length - condaPackageCount
                            })}`
                          : ''}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-2 max-h-[48vh] min-h-0 overflow-y-auto rounded-md border border-border">
                    {packagesError !== null ? (
                      <div className="flex flex-col items-center gap-2 px-3 py-6">
                        <p role="alert" className="text-sm text-destructive">
                          {packagesError}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setPackages(null)
                            setPackagesError(null)
                            setPackagesRetryNonce((nonce) => nonce + 1)
                          }}
                        >
                          {t('Retry')}
                        </Button>
                      </div>
                    ) : packages === null ? (
                      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {t('Listing packages…')}
                      </p>
                    ) : (
                      <table className="w-full border-collapse text-[13px]">
                        <thead className="sticky top-0 bg-card">
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="py-2 pl-3 pr-3 font-medium">{t('Name')}</th>
                            <th className="py-2 pr-3 font-medium">{t('Version')}</th>
                            {hasCondaFields ? (
                              <>
                                <th className="py-2 pr-3 font-medium">{t('Build')}</th>
                                <th className="py-2 pr-3 font-medium">{t('Channel')}</th>
                              </>
                            ) : null}
                          </tr>
                        </thead>
                        <tbody>
                          {visiblePackages.map((pkg) => (
                            <tr
                              key={pkg.name}
                              data-testid="runtime-package-row"
                              className="border-b border-border last:border-b-0"
                            >
                              <td className="py-1.5 pl-3 pr-3 text-foreground">{pkg.name}</td>
                              <td className="py-1.5 pr-3">
                                <code className="text-xs text-muted-foreground">{pkg.version}</code>
                              </td>
                              {hasCondaFields ? (
                                <>
                                  <td className="py-1.5 pr-3">
                                    <code className="text-xs text-muted-foreground">
                                      {pkg.build ?? '—'}
                                    </code>
                                  </td>
                                  <td className="py-1.5 pr-3 text-xs text-muted-foreground">
                                    {pkg.channel ?? '—'}
                                  </td>
                                </>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {packages !== null &&
                    packagesError === null &&
                    packages.length > 0 &&
                    visiblePackages.length === 0 ? (
                      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {t('No packages match “{{filter}}”.', { filter: packagesFilter })}
                      </p>
                    ) : null}
                    {packages !== null && packagesError === null && packages.length === 0 ? (
                      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {t('No packages installed.')}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className={dialogFooterClassName}>
                  <Dialog.Close asChild>
                    <Button type="button" variant="outline">
                      {t('Close')}
                    </Button>
                  </Dialog.Close>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

export { RuntimesPanel }
