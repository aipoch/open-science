import {
  CheckCircle2,
  CircleMinus,
  CircleX,
  ClipboardCopy,
  Download,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  SquareTerminal
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Input } from '@/components/ui/input'
import { resolveCustomizeProjectId } from '@/lib/last-opened-project'
import { buildWslSupportPrefillDoc } from '@/lib/wsl-support-handoff'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  RECOMMENDED_WSL_DISTRO,
  type SwitchToPowerShellResult,
  type UseWsl2BashResult,
  type Wsl2BashPreviewStatus,
  type WslPlatformInstallResult,
  type WslReadiness,
  type WslSetupSnapshot
} from '../../../../shared/wsl-setup'
import { SettingsField, SettingsSection } from './SettingsLayout'

const statusCopy = (snapshot: WslSetupSnapshot, t: (key: string) => string): string => {
  switch (snapshot.state) {
    case 'checking':
      return t('Checking WSL2 readiness…')
    case 'not-installed':
      return t('WSL2 is not installed. Install it in Windows, then check again.')
    case 'restart-required':
      return t('Windows must restart before WSL2 setup can continue.')
    case 'distro-required':
      return t('Install or select a WSL2 distribution to continue.')
    case 'first-launch-required':
      return t('Open the distribution once and finish creating its Linux user.')
    case 'dependency-required':
      return t('The selected distribution needs the missing Linux dependencies shown below.')
    case 'ready':
      return t('This profile is ready for sandboxed WSL2 Bash.')
    case 'failed':
      return t('This profile is not ready. Use the code below to identify the next action.')
  }
}

const recoveryCopy = (
  errorCode: string | undefined,
  t: (key: string) => string
): string | undefined => {
  switch (errorCode) {
    case 'wsl1_unsupported':
      return t('Convert the distribution to WSL2 in Windows, then check again.')
    case 'wsl_root_user':
    case 'wsl_user_mismatch':
    case 'wsl_user_not_found':
      return t('Choose an exact non-root Linux user, then save and check again.')
    case 'wsl_home_missing':
      return t('Choose a non-root Linux user with an existing home directory, then check again.')
    case 'wsl_distro_install_failed':
      return t('The distribution installation failed. Check Windows setup, then try again.')
    case 'wsl_distro_install_unconfirmed':
      return t(
        'Windows did not confirm the distribution installation. Check again before retrying.'
      )
    case 'wsl_terminal_open_failed':
      return t('The distribution terminal could not be opened. Check again, then retry.')
    case 'wsl_network_mode_unsupported':
      return t('Set WSL networkingMode to mirrored, shut down WSL, then check again.')
    case 'wsl_workspace_path_unsupported':
    case 'wsl_workspace_unreachable':
    case 'wsl_workspace_not_local':
    case 'wsl_workspace_not_ntfs':
    case 'wsl_workspace_volume_unavailable':
      return t('Move the Open Science data folder to a local NTFS drive, then check again.')
    default:
      return undefined
  }
}

export const WslLocalShellSection = ({
  previewAvailable = true,
  developmentPreview = false,
  previewUnavailableReason
}: {
  previewAvailable?: boolean
  developmentPreview?: boolean
  previewUnavailableReason?: Wsl2BashPreviewStatus['reason']
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<WslSetupSnapshot>({
    state: 'checking',
    distros: [],
    operationReference: '--------'
  })
  const [distro, setDistro] = useState('')
  const [user, setUser] = useState('')
  const [busy, setBusy] = useState(previewAvailable)
  const [installResult, setInstallResult] = useState<WslPlatformInstallResult>()
  const [copied, setCopied] = useState(false)
  const [shellSwitchResult, setShellSwitchResult] = useState<
    | { runtime: 'powershell'; result: SwitchToPowerShellResult }
    | { runtime: 'wsl2-bash'; result: UseWsl2BashResult }
  >()
  const [shellSwitchFailed, setShellSwitchFailed] = useState<'powershell' | 'wsl2-bash'>()
  const projects = useProjectStore((state) => state.projects)
  const chatProjectId = useMemo(
    () => resolveCustomizeProjectId(projects.filter((project) => project.archivedAt === undefined)),
    [projects]
  )
  const checks: ReadonlyArray<[keyof WslReadiness, string]> = [
    ['wsl2', t('WSL2 distribution')],
    ['home', t('Linux home directory')],
    ['bash', t('Bash')],
    ['bwrap', t('bubblewrap')],
    ['python3', t('Python 3')],
    ['mirroredNetworking', t('Mirrored networking')],
    ['namespaces', t('Linux namespaces')],
    ['localWorkspace', t('Local Windows workspace')]
  ]

  const apply = useCallback((next: WslSetupSnapshot): void => {
    setSnapshot(next)
    setDistro(next.selection?.distro ?? next.distros.find((item) => item.version === 2)?.name ?? '')
    setUser(next.selection?.user ?? '')
  }, [])

  const probe = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      if (isActive()) {
        setBusy(true)
        setSnapshot((current) => ({ ...current, state: 'checking' }))
      }
      try {
        const next = await window.api.settings.probeWslSetup()
        if (isActive()) {
          setInstallResult(undefined)
          apply(next)
        }
      } catch {
        if (isActive()) {
          setSnapshot({
            state: 'failed',
            distros: [],
            errorCode: 'wsl_probe_failed',
            operationReference: '--------'
          })
        }
      } finally {
        if (isActive()) setBusy(false)
      }
    },
    [apply]
  )

  useEffect(() => {
    if (!previewAvailable) return () => undefined
    let active = true
    queueMicrotask(() => void probe(() => active))
    return () => {
      active = false
    }
  }, [previewAvailable, probe])

  const saveAndCheck = async (): Promise<void> => {
    setBusy(true)
    setShellSwitchResult(undefined)
    setShellSwitchFailed(undefined)
    try {
      apply(await window.api.settings.selectWslProfile({ distro, user }))
    } catch {
      setSnapshot((current) => ({ ...current, state: 'failed', errorCode: 'wsl_probe_failed' }))
    } finally {
      setBusy(false)
    }
  }

  const installWslPlatform = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.settings.installWslPlatform()
      setInstallResult(result)
      apply(result.snapshot)
    } catch {
      setInstallResult(undefined)
      setSnapshot((current) => ({
        ...current,
        state: 'not-installed',
        errorCode: 'wsl_install_spawn_failed'
      }))
    } finally {
      setBusy(false)
    }
  }

  const installRecommended = async (): Promise<void> => {
    setBusy(true)
    try {
      apply(await window.api.settings.installRecommendedWslDistro())
    } catch {
      setSnapshot((current) => ({
        ...current,
        state: 'failed',
        errorCode: 'wsl_distro_install_failed'
      }))
    } finally {
      setBusy(false)
    }
  }

  const installFailure =
    installResult?.outcome === 'uac-cancelled' ||
    installResult?.outcome === 'spawn-failed' ||
    installResult?.outcome === 'unknown'
      ? installResult.outcome
      : undefined

  const openTerminal = async (withUser: boolean, requestedDistro?: string): Promise<void> => {
    const selectedDistro = requestedDistro ?? snapshot.selection?.distro ?? distro
    if (!selectedDistro) return
    setBusy(true)
    try {
      apply(
        await window.api.settings.openWslTerminal({
          distro: selectedDistro,
          ...(withUser && snapshot.selection?.user ? { user: snapshot.selection.user } : {})
        })
      )
    } catch {
      setSnapshot((current) => ({
        ...current,
        state: 'failed',
        errorCode: 'wsl_terminal_open_failed'
      }))
    } finally {
      setBusy(false)
    }
  }

  const firstInitializationDistro =
    snapshot.state === 'first-launch-required'
      ? snapshot.selection?.distro
      : snapshot.state === 'distro-required' &&
          snapshot.distros.some(
            (item) => item.name === RECOMMENDED_WSL_DISTRO && item.version === 2
          )
        ? RECOMMENDED_WSL_DISTRO
        : undefined

  const copySuggestedCommand = async (): Promise<void> => {
    if (!snapshot.suggestedCommand) return
    await navigator.clipboard.writeText(snapshot.suggestedCommand)
    setCopied(true)
  }

  const startSupportConversation = async (): Promise<void> => {
    if (!chatProjectId) return
    setBusy(true)
    try {
      const handoff = await window.api.settings.createWslSupportHandoff()
      const doc = buildWslSupportPrefillDoc(handoff, t)
      const opened = useNavigationStore.getState().startWslSupportConversation(chatProjectId, doc)
      if (opened) useSettingsStore.getState().closeSettings()
    } finally {
      setBusy(false)
    }
  }

  const switchToPowerShell = async (): Promise<void> => {
    setBusy(true)
    setShellSwitchFailed(undefined)
    try {
      const result = await window.api.settings.switchLocalShellToPowerShell()
      setShellSwitchResult({
        runtime: 'powershell',
        result
      })
      setSnapshot((current) => ({ ...current, activeRuntime: 'powershell' }))
    } catch {
      setShellSwitchResult(undefined)
      setShellSwitchFailed('powershell')
    } finally {
      setBusy(false)
    }
  }

  const activateWsl2Bash = async (): Promise<void> => {
    setBusy(true)
    setShellSwitchFailed(undefined)
    try {
      const result = await window.api.settings.useWsl2Bash()
      setShellSwitchResult({
        runtime: 'wsl2-bash',
        result
      })
      setSnapshot((current) => ({
        ...current,
        activeRuntime: 'wsl2-bash',
        activatedSelection: result.selection
      }))
    } catch {
      setShellSwitchResult(undefined)
      setShellSwitchFailed('wsl2-bash')
    } finally {
      setBusy(false)
    }
  }

  if (!previewAvailable) {
    return (
      <SettingsSection separated title={t('Local Shell')}>
        <div className="flex justify-center rounded-lg border border-border bg-card p-4">
          {shellSwitchResult?.runtime === 'powershell' ? (
            <div
              className="rounded-md border border-status-success-accent/30 bg-status-success-surface p-3 text-sm text-status-success-foreground dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground"
              role="status"
            >
              {t('Future Shell commands will use PowerShell.')}
            </div>
          ) : (
            <ErrorNotice
              icon={CircleX}
              tone={
                shellSwitchFailed || previewUnavailableReason === 'assets-unavailable'
                  ? 'red'
                  : 'amber'
              }
              title={
                shellSwitchFailed
                  ? t('Open Science could not finish changing the Shell runtime.')
                  : t('WSL2 Bash Preview is unavailable.')
              }
              description={
                shellSwitchFailed
                  ? t(
                      'Restart Open Science before running another Shell command, then try the switch again.'
                    )
                  : t('Switch to PowerShell to continue with Shell commands.')
              }
              primaryButton={{
                label: shellSwitchFailed ? t('Try switching again') : t('Switch to PowerShell'),
                onClick: () => void switchToPowerShell(),
                disabled: busy,
                loading: busy
              }}
            />
          )}
        </div>
      </SettingsSection>
    )
  }

  const supportAvailable = !busy && snapshot.state !== 'checking' && snapshot.state !== 'ready'
  const candidateIsActive =
    snapshot.activeRuntime === 'wsl2-bash' &&
    snapshot.selection !== undefined &&
    snapshot.activatedSelection?.distro === snapshot.selection.distro &&
    snapshot.activatedSelection.user === snapshot.selection.user
  const powerShellSwitchButton = (
    <Button type="button" variant="outline" onClick={() => void switchToPowerShell()}>
      <SquareTerminal aria-hidden="true" />
      {t('Switch to PowerShell')}
    </Button>
  )

  return (
    <SettingsSection
      separated
      title={
        developmentPreview
          ? t('Local Shell · WSL2 Bash Development Preview')
          : t('Local Shell · WSL2 Bash Preview')
      }
      description={t(
        'Choose the exact WSL2 distribution and non-root Linux user Open Science should verify. Selection alone never enables WSL2 Bash.'
      )}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void probe()}
          disabled={busy}
        >
          <RefreshCw className={busy ? 'animate-spin' : ''} aria-hidden="true" />
          {t('Check again')}
        </Button>
      }
    >
      <div className="rounded-lg border border-border bg-card p-4" data-testid="wsl-local-shell">
        {installFailure && !busy ? (
          <div className="flex justify-center">
            <ErrorNotice
              icon={CircleX}
              tone={installFailure === 'spawn-failed' ? 'red' : 'amber'}
              title={
                installFailure === 'uac-cancelled'
                  ? t('WSL2 installation was cancelled in Windows.')
                  : installFailure === 'spawn-failed'
                    ? t('Open Science could not start the WSL2 installer.')
                    : t('Windows did not confirm the WSL2 installation result.')
              }
              description={
                installFailure === 'unknown'
                  ? t(
                      'Check again to read the current Windows state. Installation will not run again automatically.'
                    )
                  : t('No installation command will run again unless you choose to retry it.')
              }
              errorCode={`${snapshot.errorCode ?? 'wsl_install_unknown'} · ${snapshot.operationReference}`}
              secondaryButton={{ label: t('Check again'), onClick: () => void probe() }}
              primaryButton={{
                label: t('Try installation again'),
                onClick: () => void installWslPlatform()
              }}
            />
          </div>
        ) : snapshot.state === 'not-installed' && !busy ? (
          <div className="flex justify-center">
            <ErrorNotice
              icon={CircleX}
              tone="amber"
              title={statusCopy(snapshot, t)}
              description={t(
                'Windows will ask for administrator approval. Open Science installs only the WSL2 platform, without a distribution.'
              )}
              errorCode={
                snapshot.errorCode
                  ? `${snapshot.errorCode} · ${snapshot.operationReference}`
                  : undefined
              }
              secondaryButton={{ label: t('Check again'), onClick: () => void probe() }}
              primaryButton={{ label: t('Install WSL2'), onClick: () => void installWslPlatform() }}
            />
          </div>
        ) : snapshot.state === 'failed' && !busy ? (
          <div className="flex justify-center">
            <ErrorNotice
              icon={CircleX}
              tone="red"
              title={statusCopy(snapshot, t)}
              description={recoveryCopy(snapshot.errorCode, t)}
              errorCode={
                snapshot.errorCode
                  ? `${snapshot.errorCode} · ${snapshot.operationReference}`
                  : undefined
              }
              primaryButton={{ label: t('Check again'), onClick: () => void probe() }}
            />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm font-medium">
            {busy ? (
              <LoaderCircle
                className="size-4 animate-spin text-status-info-foreground"
                aria-hidden="true"
              />
            ) : snapshot.state === 'ready' ? (
              <CheckCircle2 className="size-4 text-status-success-foreground" aria-hidden="true" />
            ) : (
              <CircleX className="size-4 text-status-failure-foreground" aria-hidden="true" />
            )}
            <span role="status">{statusCopy(snapshot, t)}</span>
          </div>
        )}

        {!busy && installResult?.outcome === 'completed' ? (
          <p className="mt-3 text-sm text-status-success-foreground" role="status">
            {t(
              'The WSL2 platform installation completed. Continue with the next setup step below.'
            )}
          </p>
        ) : null}

        {!busy && installResult?.outcome === 'restart-required' ? (
          <p className="mt-3 text-sm text-status-warning-foreground" role="status">
            {t('Restart Windows before continuing. Returning here will start a fresh check.')}
          </p>
        ) : null}

        {!busy && snapshot.state === 'distro-required' && snapshot.distros.length === 0 ? (
          <div className="mt-4">
            <Button type="button" onClick={() => void installRecommended()}>
              <Download aria-hidden="true" />
              {t('Install {{distro}}', { distro: RECOMMENDED_WSL_DISTRO })}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Installation starts only after you choose this action.')}
            </p>
          </div>
        ) : null}

        {!busy && firstInitializationDistro ? (
          <div className="mt-4">
            <Button
              type="button"
              onClick={() => void openTerminal(false, firstInitializationDistro)}
            >
              <SquareTerminal aria-hidden="true" />
              {t('Open distribution terminal')}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                'Finish the distribution’s username and password prompts in the terminal. Open Science never enters credentials for you.'
              )}
            </p>
          </div>
        ) : null}

        {!busy &&
        (snapshot.errorCode === 'wsl_bwrap_missing' ||
          snapshot.errorCode === 'wsl_python3_missing') ? (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <p className="text-sm">
              {snapshot.errorCode === 'wsl_bwrap_missing'
                ? t(
                    'Install bubblewrap in the distribution terminal. Open Science will not run sudo or a package manager.'
                  )
                : t(
                    'Install Python 3 in the distribution terminal. Open Science will not run sudo or a package manager.'
                  )}
            </p>
            {snapshot.suggestedCommand ? (
              <>
                <code className="mt-2 block overflow-x-auto rounded bg-background p-2 text-xs">
                  {snapshot.suggestedCommand}
                </code>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void copySuggestedCommand()}
                  >
                    <ClipboardCopy aria-hidden="true" />
                    {copied ? t('Copied') : t('Copy command')}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void openTerminal(true)}>
                    <SquareTerminal aria-hidden="true" />
                    {t('Open distribution terminal')}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {snapshot.distros.length > 0 ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <SettingsField label={t('WSL2 distribution')}>
              <Select value={distro} onValueChange={setDistro} disabled={busy}>
                <SelectTrigger aria-label={t('WSL2 distribution')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {snapshot.distros.map((item) => (
                    <SelectItem key={item.name} value={item.name} disabled={item.version !== 2}>
                      {item.name} {item.version === 1 ? t('(WSL1 — unsupported)') : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField label={t('Linux user')}>
              <Input
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder={t('Exact non-root user')}
                disabled={busy}
              />
            </SettingsField>
            <div className="sm:col-span-2">
              <Button
                type="button"
                onClick={() => void saveAndCheck()}
                disabled={busy || !distro.trim() || !user.trim()}
              >
                {t('Save and check')}
              </Button>
            </div>
          </div>
        ) : null}

        {snapshot.readiness ? (
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2" aria-label={t('Readiness checks')}>
            {checks.map(([key, label]) => (
              <li key={key} className="flex items-center gap-2">
                {snapshot.readiness?.[key] === true ? (
                  <CheckCircle2
                    className="size-4 text-status-success-foreground"
                    aria-hidden="true"
                  />
                ) : snapshot.readiness?.[key] === false ? (
                  <CircleX className="size-4 text-status-failure-foreground" aria-hidden="true" />
                ) : (
                  <CircleMinus className="size-4 text-status-info-foreground" aria-hidden="true" />
                )}
                {label}
                {snapshot.readiness?.[key] === undefined ? (
                  <span className="text-xs text-muted-foreground">{t('Not checked')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {!busy && snapshot.state !== 'failed' && snapshot.errorCode ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            {snapshot.errorCode} · {snapshot.operationReference}
          </p>
        ) : null}

        {!busy && snapshot.state !== 'ready' && shellSwitchResult?.runtime !== 'powershell' ? (
          <div className="mt-4 flex flex-col items-start gap-2">
            <p className="text-xs text-muted-foreground">
              {t(
                'You can keep using PowerShell while WSL2 is unavailable; these setup choices are preserved.'
              )}
            </p>
            {powerShellSwitchButton}
          </div>
        ) : null}

        {!busy && snapshot.state === 'ready' ? (
          <div className="mt-4 flex flex-col items-start gap-2">
            <p className="text-xs text-muted-foreground" role="status">
              {candidateIsActive
                ? t('This ready profile is active for future Shell commands.')
                : t('This ready profile is only a candidate until you choose Use WSL2 Bash.')}
            </p>
            {candidateIsActive ? (
              powerShellSwitchButton
            ) : (
              <Button type="button" onClick={() => void activateWsl2Bash()}>
                <SquareTerminal aria-hidden="true" />
                {t('Use WSL2 Bash')}
              </Button>
            )}
          </div>
        ) : null}

        {!busy && shellSwitchResult ? (
          <div
            className="mt-4 rounded-md border border-status-success-accent/30 bg-status-success-surface p-3 text-sm text-status-success-foreground dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground"
            role="status"
          >
            <p>
              {shellSwitchResult.runtime === 'powershell'
                ? t('Future Shell commands will use PowerShell.')
                : t('Future Shell commands will use WSL2 Bash.')}
            </p>
            <p className="mt-1 text-xs">
              {t('Running and failed commands were not rerun or moved to another Shell.')}
            </p>
            {shellSwitchResult.runtime === 'powershell' &&
            shellSwitchResult.result.wslProfilePreserved ? (
              <p className="mt-1 text-xs">
                {t('Your saved WSL2 profile is still available when you are ready to switch back.')}
              </p>
            ) : null}
          </div>
        ) : null}

        {!busy && shellSwitchFailed ? (
          <div className="mt-4 flex justify-center">
            <ErrorNotice
              icon={CircleX}
              tone="red"
              title={t('Open Science could not finish changing the Shell runtime.')}
              description={t(
                'Restart Open Science before running another Shell command, then try the switch again.'
              )}
              primaryButton={{
                label: t('Try switching again'),
                onClick: () =>
                  void (shellSwitchFailed === 'wsl2-bash'
                    ? activateWsl2Bash()
                    : switchToPowerShell())
              }}
            />
          </div>
        ) : null}

        {supportAvailable ? (
          <div className="mt-4 flex flex-col items-start gap-1.5">
            <Button
              type="button"
              variant="outline"
              onClick={() => void startSupportConversation()}
              disabled={!chatProjectId}
            >
              <MessagesSquare aria-hidden="true" />
              {t('Solve in conversation')}
            </Button>
            {!chatProjectId ? (
              <p className="text-xs text-muted-foreground">
                {t('Create or open a project to solve this with the agent.')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  )
}
