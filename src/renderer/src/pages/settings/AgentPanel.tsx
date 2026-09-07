import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { selectAnyInstalling, useSettingsStore } from '@/stores/settings-store'
import type {
  AgentFrameworkId,
  ClaudeInstallResult,
  ClaudeInstallSource,
  ClaudeInstallSourceInfo
} from '../../../../shared/settings'
import {
  getCodeBuddyInstallSources,
  getClaudeInstallSources,
  getCodexInstallSources,
  getOpencodeInstallSources
} from '../../../../shared/settings'
import {
  isSupportedCodexAcpVersion,
  MINIMUM_CODEX_ACP_VERSION
} from '../../../../shared/codex-runtime'
import { AgentFrameworkCard } from './AgentFrameworkCard'
import { ModelFrameworkCompatibilityAlert } from './ModelFrameworkCompatibilityAlert'
import { AgentFrameworkIcon } from './provider-icons'
import { RepairFrameworkDialog } from './RepairFrameworkDialog'
import { SettingsSection } from './SettingsLayout'
import { SwitchFrameworkDialog } from './SwitchFrameworkDialog'
import { UninstallRuntimeDialog } from './UninstallRuntimeDialog'

// The agent frameworks the settings page manages, keyed by their short name (used for the
// uninstall dialog target and the framework card descriptors).
type FrameworkKey = 'claude' | 'opencode' | 'codex' | 'codebuddy'

type AgentPanelProps = {
  variant?: 'settings' | 'onboarding'
  title: string
  description: React.ReactNode
}

type OnboardingSwitchRequest = {
  target: AgentFrameworkId
  intentVersion: number
}

// The Agent settings panel: agent-framework management end to end — detection, install, uninstall,
// and the active-framework switch. Callers supply the heading copy while runtime behavior stays
// store-driven; uninstall and switch confirmations live here because only these cards trigger them.
const AgentPanel = ({
  variant = 'settings',
  title,
  description
}: AgentPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const isOnboarding = variant === 'onboarding'
  const claude = useSettingsStore((state) => state.claude)
  const preflight = useSettingsStore((state) => state.preflight)
  const isDetectingClaude = useSettingsStore((state) => state.isDetectingClaude)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const setAgentFramework = useSettingsStore((state) => state.setAgentFramework)
  const opencode = useSettingsStore((state) => state.opencode)
  const isDetectingOpencode = useSettingsStore((state) => state.isDetectingOpencode)
  const detectOpencode = useSettingsStore((state) => state.detectOpencode)
  const installOpencode = useSettingsStore((state) => state.installOpencode)
  const codex = useSettingsStore((state) => state.codex)
  const isDetectingCodex = useSettingsStore((state) => state.isDetectingCodex)
  const detectCodex = useSettingsStore((state) => state.detectCodex)
  const installCodex = useSettingsStore((state) => state.installCodex)
  const codebuddy = useSettingsStore((state) => state.codebuddy)
  const isDetectingCodeBuddy = useSettingsStore((state) => state.isDetectingCodeBuddy)
  const detectCodeBuddy = useSettingsStore((state) => state.detectCodeBuddy)
  const installCodeBuddy = useSettingsStore((state) => state.installCodeBuddy)
  // Per-runtime install slices: each card renders only its own progress/logs/error (issue #278).
  const claudeInstall = useSettingsStore((state) => state.installStates['claude-code'])
  const opencodeInstall = useSettingsStore((state) => state.installStates.opencode)
  const codexInstall = useSettingsStore((state) => state.installStates.codex)
  const codebuddyInstall = useSettingsStore((state) => state.installStates.codebuddy)
  // Any install running locks the framework selector and every card's uninstall button.
  const anyInstalling = useSettingsStore(selectAnyInstalling)
  const npmAvailable = useSettingsStore((state) => state.npmAvailable)
  const claudeManaged = useSettingsStore((state) => state.claudeManaged)
  const opencodeManaged = useSettingsStore((state) => state.opencodeManaged)
  const codexManaged = useSettingsStore((state) => state.codexManaged)
  const codebuddyManaged = useSettingsStore((state) => state.codebuddyManaged)
  const uninstallClaude = useSettingsStore((state) => state.uninstallClaude)
  const uninstallOpencode = useSettingsStore((state) => state.uninstallOpencode)
  const uninstallCodex = useSettingsStore((state) => state.uninstallCodex)
  const uninstallCodeBuddy = useSettingsStore((state) => state.uninstallCodeBuddy)
  const detectClaude = useSettingsStore((state) => state.detectClaude)
  const installClaude = useSettingsStore((state) => state.installClaude)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const selectedEnvironmentCheck =
    environmentCheck?.agentFrameworkId === agentFrameworkId ? environmentCheck : undefined

  // Track whether an ACP prompt is currently running so the uninstall (a destructive teardown) can be
  // blocked while a task uses the runtime. Settings fails closed until the first snapshot arrives;
  // onboarding hides uninstall entirely, so it does not need this unrelated ACP subscription.
  const [promptInFlight, setPromptInFlight] = useState(!isOnboarding)
  useEffect(() => {
    if (isOnboarding) return

    let mounted = true
    // A live onState broadcast is always fresher than the initial getState() read. Subscribing first
    // is NOT enough — getState() is async, so a live event can arrive before the snapshot resolves and
    // then be clobbered by the stale snapshot when it lands. Latch the first live event and drop any
    // getState() result that arrives after it, so live state always wins the race.
    let liveEventSeen = false
    const removeListener = window.api.acp.onState((s) => {
      if (!mounted) return
      liveEventSeen = true
      setPromptInFlight(s.promptInFlight)
    })
    void window.api.acp.getState().then((s) => {
      if (mounted && !liveEventSeen) setPromptInFlight(s.promptInFlight)
    })
    return () => {
      mounted = false
      removeListener()
    }
  }, [isOnboarding])

  // The app-managed runtime pending an uninstall confirmation (null = dialog closed), plus the
  // in-flight flag so the dialog and status cards can show progress and stay locked during removal.
  const [pendingUninstall, setPendingUninstall] = useState<FrameworkKey | null>(null)
  const [pendingRepair, setPendingRepair] = useState<FrameworkKey | null>(null)
  const [isUninstalling, setIsUninstalling] = useState(false)
  // The framework the user picked (via a card) but hasn't confirmed switching to yet.
  const [pendingSwitch, setPendingSwitch] = useState<AgentFrameworkId | null>(null)
  const [isSwitching, setIsSwitching] = useState(false)
  const [frameworkDetectionError, setFrameworkDetectionError] = useState<string | undefined>()
  const [installActionError, setInstallActionError] = useState<string | undefined>()
  const onboardingAutoSelectAttempted = useRef(false)
  const onboardingSwitchInFlight = useRef(false)
  const onboardingUserIntentVersion = useRef(0)
  const onboardingPendingSwitch = useRef<OnboardingSwitchRequest | null>(null)
  const settingsSwitchInFlight = useRef(false)

  // Removes the app-managed runtime for the framework awaiting confirmation, then closes the dialog.
  // The store applies the refreshed snapshot (which may auto-switch the active framework) and main
  // reconnects the agent, so the cards and readiness gate update without a manual re-detect.
  const handleConfirmUninstall = async (): Promise<void> => {
    if (!pendingUninstall) return
    // Revalidate at confirm time: a prompt may have started after the dialog opened (the card control
    // disables live, but an already-open dialog wouldn't). Uninstalling the runtime out from under a
    // running task is exactly what the guard prevents, so close the dialog instead of proceeding.
    if (promptInFlight) {
      setPendingUninstall(null)
      return
    }

    setIsUninstalling(true)

    try {
      if (pendingUninstall === 'claude') await uninstallClaude()
      else if (pendingUninstall === 'opencode') await uninstallOpencode()
      else if (pendingUninstall === 'codex') await uninstallCodex()
      else await uninstallCodeBuddy()

      setPendingUninstall(null)
    } finally {
      setIsUninstalling(false)
    }
  }

  // Every onboarding switch runs through one queue. A later explicit choice replaces the pending
  // target and runs after the current IPC, so an older response cannot overwrite the user's intent.
  const drainOnboardingSwitches = useCallback(async (): Promise<void> => {
    if (onboardingSwitchInFlight.current) return

    onboardingSwitchInFlight.current = true
    setIsSwitching(true)
    try {
      while (onboardingPendingSwitch.current) {
        const request = onboardingPendingSwitch.current
        onboardingPendingSwitch.current = null

        if (request.intentVersion !== onboardingUserIntentVersion.current) continue

        if (useSettingsStore.getState().agentFrameworkId !== request.target) {
          try {
            await setAgentFramework(request.target)
          } catch {
            // The store already records safe feedback. Do not inspect the still-selected old
            // framework; continue only if a newer user intent was queued during the failed IPC.
            continue
          }
        }

        // If the user changed their mind during the IPC, immediately apply the newer queued target.
        if (request.intentVersion !== onboardingUserIntentVersion.current) continue
        await checkEnvironment({ force: true })
      }
    } finally {
      onboardingSwitchInFlight.current = false
      setIsSwitching(false)
    }
  }, [checkEnvironment, setAgentFramework])

  const queueOnboardingSwitch = useCallback(
    (target: AgentFrameworkId, intentVersion = onboardingUserIntentVersion.current): void => {
      // Invalidate readiness immediately: until this switch is saved and checked, the previous
      // framework's successful result must not leave onboarding's Continue gate enabled.
      useSettingsStore.setState({ environmentCheck: undefined, environmentCheckError: undefined })
      onboardingPendingSwitch.current = { target, intentVersion }
      void drainOnboardingSwitches()
    },
    [drainOnboardingSwitches]
  )

  // Settings keeps its confirmation dialog. Onboarding records every card click as a newer intent,
  // including a click back to the framework that was active before an automatic switch.
  const requestSwitch = (target: AgentFrameworkId): void => {
    if (isOnboarding) {
      onboardingUserIntentVersion.current += 1
      queueOnboardingSwitch(target, onboardingUserIntentVersion.current)
      return
    }

    if (target !== agentFrameworkId) {
      setFrameworkDetectionError(undefined)
      setInstallActionError(undefined)
      setPendingSwitch(target)
    }
  }

  const confirmSwitch = async (): Promise<void> => {
    const target = pendingSwitch
    setPendingSwitch(null)
    if (!target || settingsSwitchInFlight.current) return

    settingsSwitchInFlight.current = true
    setIsSwitching(true)
    try {
      await setAgentFramework(target)
      // Framework detection updates the cards; the full pass owns the Home repair alert.
      await checkEnvironment({ force: true })
    } catch {
      // The Settings-level alert owns the failure copy. Stopping here prevents a stale environment
      // check and consumes the event-handler rejection after the store has recorded diagnostics.
      return
    } finally {
      settingsSwitchInFlight.current = false
      setIsSwitching(false)
    }
  }

  const activeFramework = agentFrameworks.find((framework) => framework.id === agentFrameworkId)
  const pendingSwitchName = agentFrameworks.find(
    (framework) => framework.id === pendingSwitch
  )?.displayName
  const codexReady =
    preflight.codexReady && (!codex.version || isSupportedCodexAcpVersion(codex.version))

  // First-run users should land on a runtime they can actually use. Registry order is the stable
  // tie-breaker, and this onboarding-only preference never changes Settings selection behavior.
  useEffect(() => {
    if (
      !isOnboarding ||
      onboardingAutoSelectAttempted.current ||
      onboardingUserIntentVersion.current > 0
    ) {
      return
    }

    const readyByFramework: Record<AgentFrameworkId, boolean> = {
      'claude-code': preflight.claudeReady,
      opencode: preflight.opencodeReady,
      codex: codexReady,
      codebuddy: preflight.codebuddyReady
    }
    if (readyByFramework[agentFrameworkId]) return

    const installedFramework = agentFrameworks.find((framework) => readyByFramework[framework.id])
    if (!installedFramework) return

    onboardingAutoSelectAttempted.current = true
    queueOnboardingSwitch(installedFramework.id)
  }, [
    agentFrameworkId,
    agentFrameworks,
    isOnboarding,
    preflight.claudeReady,
    codexReady,
    preflight.codebuddyReady,
    preflight.opencodeReady,
    queueOnboardingSwitch
  ])

  // The section-level Re-detect re-scans all frameworks at once; the per-card detect buttons
  // were removed in favor of this single action.
  const isDetectingAnyFramework =
    isDetectingClaude || isDetectingOpencode || isDetectingCodex || isDetectingCodeBuddy
  const handleDetectAllFrameworks = async (): Promise<void> => {
    setFrameworkDetectionError(undefined)
    setInstallActionError(undefined)
    // A non-selected runtime may be broken independently of the framework the user is configuring.
    // Wait for every detector, then refresh the selected environment even when one detector rejected.
    const results = await Promise.allSettled([
      detectClaude(),
      detectOpencode(),
      detectCodex(),
      detectCodeBuddy()
    ])
    await checkEnvironment({ force: true })

    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) {
      setFrameworkDetectionError(
        failure.reason instanceof Error
          ? failure.reason.message
          : t('One or more agent runtimes could not be detected.')
      )
    }
  }

  // One descriptor per agent framework, in canonical display order. Cards are grouped by install
  // state (Installed / Available) below, preserving this order within each group. The source link
  // points at each agent's own repository — for Codex that is the ACP adapter repo, since the app
  // talks to Codex through the agentclientprotocol/codex-acp bridge.
  type FrameworkCardModel = {
    key: FrameworkKey
    frameworkId: AgentFrameworkId
    name: string
    icon: React.ReactNode
    description: string
    ready: boolean
    installed: boolean
    updateRequired?: boolean
    minimumVersion?: string
    version?: string
    path?: string
    sourceLabel: string
    sourceUrl: string
    notReadyHint: React.ReactNode
    uninstallCommand: string
    managed: boolean
    installSources: ClaudeInstallSourceInfo[]
    // This runtime's own install slice from the store (per-runtime install state, issue #278) —
    // each card renders only its own progress/logs/error.
    install: typeof claudeInstall
    onInstall: (source: ClaudeInstallSource) => Promise<ClaudeInstallResult | undefined>
  }

  const frameworkCards: FrameworkCardModel[] = [
    {
      key: 'claude',
      frameworkId: 'claude-code',
      name: 'Claude Agent',
      icon: <AgentFrameworkIcon frameworkId="claude-code" size={24} />,
      description: t("Anthropic's agentic coding tool for the terminal."),
      ready: preflight.claudeReady,
      installed: Boolean(claude.resolvedPath),
      version: claude.version,
      path: claude.resolvedPath,
      sourceLabel: 'anthropics/claude-code',
      sourceUrl: 'https://github.com/anthropics/claude-code',
      notReadyHint: t('Install Claude Agent below, or install it manually and re-detect.'),
      uninstallCommand: 'npm uninstall -g @anthropic-ai/claude-code',
      managed: claudeManaged,
      installSources: getClaudeInstallSources(window.api?.platform),
      install: claudeInstall,
      onInstall: (source) =>
        installClaude(
          source,
          isOnboarding && source === 'managed'
            ? selectedEnvironmentCheck?.recommendedRegistry
            : undefined
        )
    },
    {
      key: 'opencode',
      frameworkId: 'opencode',
      name: 'OpenCode',
      icon: <AgentFrameworkIcon frameworkId="opencode" size={24} />,
      description: t('Open-source coding agent for the terminal.'),
      ready: preflight.opencodeReady,
      installed: Boolean(opencode.resolvedPath),
      version: opencode.version,
      path: opencode.resolvedPath,
      sourceLabel: 'anomalyco/opencode',
      sourceUrl: 'https://github.com/anomalyco/opencode',
      notReadyHint: (
        <Trans
          i18nKey="OpenCode is required for this framework. Install it below, or install it manually (see <docs>opencode.ai/docs</docs>) and re-detect."
          components={{
            // Trans clones this element and supplies the link text from the catalog, so the
            // placeholder children are discarded. ExternalTextLink requires them at the type level.
            docs: <ExternalTextLink href="https://opencode.ai/docs">{null}</ExternalTextLink>
          }}
        />
      ),
      uninstallCommand: 'npm uninstall -g opencode-ai',
      managed: opencodeManaged,
      installSources: getOpencodeInstallSources(window.api?.platform),
      install: opencodeInstall,
      onInstall: (source) => installOpencode(source)
    },
    {
      key: 'codex',
      frameworkId: 'codex',
      name: 'Codex',
      icon: <AgentFrameworkIcon frameworkId="codex" size={24} />,
      description: t("OpenAI's coding agent, connected through the Codex ACP adapter."),
      ready: codexReady,
      installed: Boolean(codex.resolvedPath),
      updateRequired: Boolean(
        codex.resolvedPath && codex.version && !isSupportedCodexAcpVersion(codex.version)
      ),
      minimumVersion: MINIMUM_CODEX_ACP_VERSION,
      version: codex.version,
      path: codex.resolvedPath,
      sourceLabel: 'agentclientprotocol/codex-acp',
      sourceUrl: 'https://github.com/agentclientprotocol/codex-acp',
      notReadyHint:
        codex.resolvedPath && codex.version && !isSupportedCodexAcpVersion(codex.version)
          ? t(
              'Codex ACP v{{installedVersion}} is no longer supported. Update to v{{minimumVersion}} or later to use Codex.',
              {
                installedVersion: codex.version,
                minimumVersion: MINIMUM_CODEX_ACP_VERSION
              }
            )
          : codex.resolvedPath
            ? t(
                'The adapter or its paired native Codex runtime did not pass detection. Reinstall the managed pair below, or repair your manual installation and re-detect.'
              )
            : t(
                'Codex ACP is required for this framework. Install it below, or install it manually and re-detect.'
              ),
      uninstallCommand: 'npm uninstall -g @agentclientprotocol/codex-acp',
      managed: codexManaged,
      installSources: getCodexInstallSources(),
      install: codexInstall,
      // Codex has no official-script source; the guard keeps the shared install-source type happy.
      onInstall: (source) => {
        if (source !== 'official-script') return installCodex(source)
        return Promise.resolve(undefined)
      }
    },
    {
      key: 'codebuddy',
      frameworkId: 'codebuddy',
      name: 'CodeBuddy',
      icon: <AgentFrameworkIcon frameworkId="codebuddy" size={24} />,
      description: t("Tencent's coding agent for the terminal."),
      ready: preflight.codebuddyReady,
      installed: Boolean(codebuddy.resolvedPath),
      version: codebuddy.version,
      path: codebuddy.resolvedPath,
      sourceLabel: '@tencent-ai/codebuddy-code',
      sourceUrl: 'https://codebuddy.ai/docs/cli/acp',
      notReadyHint: t(
        'CodeBuddy is required for this framework. Install it below, or install it manually and re-detect.'
      ),
      uninstallCommand: 'npm uninstall -g @tencent-ai/codebuddy-code',
      managed: codebuddyManaged,
      installSources: getCodeBuddyInstallSources(),
      install: codebuddyInstall,
      onInstall: (source) => {
        if (source === 'managed') return installCodeBuddy(source)
        return Promise.resolve(undefined)
      }
    }
  ]

  const installedFrameworks = frameworkCards.filter(
    (card) => card.ready || card.installed || card.updateRequired
  )
  const availableFrameworks = frameworkCards.filter(
    (card) => !card.ready && !card.installed && !card.updateRequired
  )

  // Environment blockers disable only the sources they invalidate. Official scripts remain a
  // usable fallback when managed registry access or the local managed installer is unavailable.
  const blockedInstallSources: Partial<Record<ClaudeInstallSource, string>> = {}
  const installBlockers =
    selectedEnvironmentCheck?.checks.filter(
      (check) =>
        check.status === 'failed' && (check.id === 'system' || check.id === 'install-network')
    ) ?? []
  const agentCheckFailures =
    selectedEnvironmentCheck?.checks.filter(
      (check) => check.id === 'agent' && check.status === 'failed'
    ) ?? []
  const failedCheckIds = new Set(
    selectedEnvironmentCheck?.checks
      .filter((check) => check.status === 'failed')
      .map((check) => check.id) ?? []
  )
  if (failedCheckIds.has('system')) {
    blockedInstallSources.managed = t('System requirements not met')
  }
  if (failedCheckIds.has('install-network')) {
    blockedInstallSources.managed ??= t('Installation network unavailable')
    blockedInstallSources.npm = t('Installation network unavailable')
  }

  // First-run installation selects the newly-ready runtime only when no usable runtime existed at
  // the start. Otherwise installation/repair preserves the active framework and only refreshes the
  // environment gate; Settings always follows that non-stealing behavior.
  const installFramework = async (
    card: FrameworkCardModel,
    source: ClaudeInstallSource
  ): Promise<void> => {
    setInstallActionError(undefined)
    setFrameworkDetectionError(undefined)
    const shouldActivateAfterInstall = isOnboarding && !frameworkCards.some((card) => card.ready)
    const intentVersion = isOnboarding
      ? (onboardingUserIntentVersion.current += 1)
      : onboardingUserIntentVersion.current
    let result: ClaudeInstallResult | undefined
    try {
      result = await card.onInstall(source)
    } catch (error) {
      // The store already preserves runtime logs/error for real IPC failures. This panel-level
      // message also covers unexpected caller failures without leaking an unhandled event promise.
      setInstallActionError(
        error instanceof Error ? error.message : t('The installer could not be started.')
      )
      return
    }
    if (!result?.ok) return

    // Settings repairs the currently-selected runtime in place. Re-run every environment check so
    // Home and the repair badges reflect the authoritative post-install state immediately.
    if (!isOnboarding) {
      await checkEnvironment({ force: true })
      return
    }

    if (!shouldActivateAfterInstall) {
      await checkEnvironment({ force: true })
      return
    }

    // A newer card click wins even if it lands between install completion and this first-runtime
    // activation. The queued switch owns the environment recheck after activation.
    if (intentVersion !== onboardingUserIntentVersion.current) return
    queueOnboardingSwitch(card.frameworkId, intentVersion)
  }

  const cardNeedsRepair = (card: FrameworkCardModel): boolean =>
    Boolean(card.path) ||
    (!isOnboarding &&
      selectedEnvironmentCheck?.agentFrameworkId === card.frameworkId &&
      selectedEnvironmentCheck.checks.some(
        (check) => check.id === 'agent' && check.status === 'failed'
      ))

  const pendingRepairCard = frameworkCards.find((card) => card.key === pendingRepair)
  const installedRadioId =
    installedFrameworks.find((card) => card.ready && card.frameworkId === agentFrameworkId)
      ?.frameworkId ?? installedFrameworks.find((card) => card.ready)?.frameworkId

  const handleFrameworkRadioKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'radio') {
      return
    }
    const radios = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="radio"]:not([aria-disabled="true"])'
      )
    )
    if (radios.length === 0) return
    const currentIndex = radios.indexOf(event.target)
    if (currentIndex < 0) return

    let nextIndex: number | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % radios.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + radios.length) % radios.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = radios.length - 1
    }
    if (nextIndex === undefined) return

    event.preventDefault()
    const nextRadio = radios[nextIndex]
    nextRadio.focus()
    if (nextRadio !== event.target) nextRadio.click()
  }

  // Maps one framework descriptor to its card, wiring in the panel-level concerns: radio selection
  // (via the switch confirmation), the uninstall dialog, and the per-runtime install slice that
  // drives the card's own progress UI (anyInstalling still locks selection and uninstall globally).
  const renderFrameworkCard = (card: FrameworkCardModel): React.JSX.Element => (
    <AgentFrameworkCard
      key={card.key}
      icon={card.icon}
      name={card.name}
      description={card.description}
      ready={card.ready}
      installed={card.installed}
      updateRequired={card.updateRequired}
      minimumVersion={card.minimumVersion}
      needsRepair={cardNeedsRepair(card)}
      version={card.version}
      path={card.path}
      sourceLabel={card.sourceLabel}
      sourceUrl={card.sourceUrl}
      notReadyHint={card.notReadyHint}
      active={agentFrameworkId === card.frameworkId}
      onSelect={() => requestSwitch(card.frameworkId)}
      radioTabIndex={card.ready ? (card.frameworkId === installedRadioId ? 0 : -1) : undefined}
      onRepairRequired={
        cardNeedsRepair(card) && !card.updateRequired ? () => setPendingRepair(card.key) : undefined
      }
      selectDisabled={
        anyInstalling ||
        isUninstalling ||
        (!isOnboarding && isSwitching) ||
        (isOnboarding && isDetectingAnyFramework)
      }
      uninstallCommand={card.uninstallCommand}
      managed={card.managed}
      isUninstalling={isUninstalling && pendingUninstall === card.key}
      isDetecting={isDetectingAnyFramework}
      promptInFlight={promptInFlight}
      onUninstall={() => {
        setPendingUninstall(card.key)
      }}
      showUninstall={!isOnboarding}
      installSources={card.installSources}
      install={card.install}
      installRunning={anyInstalling || (!isOnboarding && isSwitching)}
      npmAvailable={npmAvailable}
      blockedInstallSources={card.frameworkId === agentFrameworkId ? blockedInstallSources : {}}
      onInstall={(source) => void installFramework(card, source)}
    />
  )

  return (
    <div className="space-y-5 p-5">
      {/* The runtime cards double as the framework selector: pick a card to make it the active
          backend (confirmed, since it starts a fresh session). Cards are grouped by install state
          so management (Installed) and acquisition (Available) don't compete for attention — but
          the active runtime can't be uninstalled (switch to the other one first). */}
      <SettingsSection
        title={title}
        headingAs={isOnboarding ? 'h2' : 'h3'}
        aria-label={title}
        description={description}
        actionClassName="ml-auto"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleDetectAllFrameworks()}
            disabled={isDetectingAnyFramework || anyInstalling || isUninstalling || isSwitching}
          >
            <RefreshCw
              className={isDetectingAnyFramework ? 'animate-spin' : ''}
              aria-hidden="true"
            />
            {isDetectingAnyFramework ? t('Detecting…') : t('Re-detect')}
          </Button>
        }
      >
        <div className="space-y-5">
          {frameworkDetectionError || installActionError || environmentCheckError ? (
            <p className="text-sm text-destructive" role="alert">
              {installActionError || environmentCheckError || frameworkDetectionError}
            </p>
          ) : null}
          {!isOnboarding && agentCheckFailures.length > 0 ? (
            <div
              aria-label={t('Agent runtime repair issues')}
              className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
            >
              <div className="flex items-start gap-2">
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {t('{{agent}} cannot be accessed.', {
                      agent: activeFramework?.displayName ?? t('The selected agent')
                    })}
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('Repair the selected agent before using it.')}
                  </p>
                </div>
              </div>
              {/* Component summaries keep the diagnosis useful without repeating automatic-install
                  guidance from the environment-check detail in this explicit Recovery surface. */}
              <div className="space-y-1 border-l border-amber-500/30 pl-6">
                {agentCheckFailures.map((failure, index) => (
                  <div key={`${failure.label}-${index}`}>
                    <p className="text-xs font-medium text-foreground">{failure.label}</p>
                    <p className="text-xs leading-5 text-muted-foreground">{failure.summary}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {installBlockers.length > 0 ? (
            <div
              aria-label={t('Agent installation blockers')}
              className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
            >
              {installBlockers.map((blocker) => (
                <div key={blocker.id} className="flex items-start gap-2">
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{blocker.label}</p>
                    <p className="text-xs leading-5 text-muted-foreground">{blocker.summary}</p>
                    {blocker.detail ? (
                      <p className="text-xs leading-5 text-muted-foreground">{blocker.detail}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {isOnboarding ? null : <ModelFrameworkCompatibilityAlert />}
          {installedFrameworks.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t('Installed')} · {installedFrameworks.length}
              </p>
              <div
                role="radiogroup"
                aria-label={title}
                className="space-y-3"
                onKeyDown={handleFrameworkRadioKeyDown}
              >
                {installedFrameworks.map(renderFrameworkCard)}
              </div>
            </div>
          ) : null}
          {availableFrameworks.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t('Available')} · {availableFrameworks.length}
              </p>
              <div className="space-y-3">{availableFrameworks.map(renderFrameworkCard)}</div>
            </div>
          ) : null}
          {activeFramework &&
          activeFramework.id !== 'codebuddy' &&
          !activeFramework.supportsSkills ? (
            <p className="text-xs text-muted-foreground">
              {t(
                "Skills aren't available with {{name}}; use Claude Code for skill-based workflows.",
                { name: activeFramework.displayName }
              )}
            </p>
          ) : null}
        </div>
      </SettingsSection>

      {isOnboarding ? null : (
        <>
          <UninstallRuntimeDialog
            framework={pendingUninstall}
            isUninstalling={isUninstalling}
            onCancel={() => setPendingUninstall(null)}
            onConfirm={() => void handleConfirmUninstall()}
          />
          <SwitchFrameworkDialog
            targetName={pendingSwitchName ?? null}
            onCancel={() => setPendingSwitch(null)}
            onConfirm={confirmSwitch}
          />
        </>
      )}
      <RepairFrameworkDialog
        name={pendingRepairCard?.name ?? null}
        sources={pendingRepairCard?.installSources ?? []}
        installing={pendingRepairCard?.install.isInstalling ?? false}
        disabled={anyInstalling || isUninstalling || (!isOnboarding && isSwitching)}
        npmAvailable={npmAvailable}
        blockedInstallSources={
          pendingRepairCard?.frameworkId === agentFrameworkId ? blockedInstallSources : {}
        }
        onCancel={() => setPendingRepair(null)}
        onRepair={(source) => {
          if (!pendingRepairCard) return
          setPendingRepair(null)
          void installFramework(pendingRepairCard, source)
        }}
      />
    </div>
  )
}

export { AgentPanel }
