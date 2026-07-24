import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'

// Import the bare Mono/Color components straight from their modules: each icon's entry point
// eagerly attaches its Avatar/Combine companions, which drag in @lobehub/ui (antd-style + an
// emoji-mart JSON import vitest can't parse). The Mono/Color components are self-contained.
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import Codex from '@lobehub/icons/es/Codex/components/Mono'
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono'
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
  getClaudeInstallSources,
  getCodexInstallSources,
  getOpencodeInstallSources
} from '../../../../shared/settings'
import { AgentFrameworkCard } from './AgentFrameworkCard'
import { ModelFrameworkCompatibilityAlert } from './ModelFrameworkCompatibilityAlert'
import { SettingsSection } from './SettingsLayout'
import { SwitchFrameworkDialog } from './SwitchFrameworkDialog'
import { UninstallRuntimeDialog } from './UninstallRuntimeDialog'

// The agent frameworks the settings page manages, keyed by their short name (used for the
// uninstall dialog target and the framework card descriptors).
type FrameworkKey = 'claude' | 'opencode' | 'codex'

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
  // Per-runtime install slices: each card renders only its own progress/logs/error (issue #278).
  const claudeInstall = useSettingsStore((state) => state.installStates['claude-code'])
  const opencodeInstall = useSettingsStore((state) => state.installStates.opencode)
  const codexInstall = useSettingsStore((state) => state.installStates.codex)
  // Any install running locks the framework selector and every card's uninstall button.
  const anyInstalling = useSettingsStore(selectAnyInstalling)
  const npmAvailable = useSettingsStore((state) => state.npmAvailable)
  const claudeManaged = useSettingsStore((state) => state.claudeManaged)
  const opencodeManaged = useSettingsStore((state) => state.opencodeManaged)
  const codexManaged = useSettingsStore((state) => state.codexManaged)
  const uninstallClaude = useSettingsStore((state) => state.uninstallClaude)
  const uninstallOpencode = useSettingsStore((state) => state.uninstallOpencode)
  const uninstallCodex = useSettingsStore((state) => state.uninstallCodex)
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
      else await uninstallCodex()

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
          await setAgentFramework(request.target)
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
    } finally {
      settingsSwitchInFlight.current = false
      setIsSwitching(false)
    }
  }

  const activeFramework = agentFrameworks.find((framework) => framework.id === agentFrameworkId)
  const pendingSwitchName = agentFrameworks.find(
    (framework) => framework.id === pendingSwitch
  )?.displayName

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
      codex: preflight.codexReady
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
    preflight.codexReady,
    preflight.opencodeReady,
    queueOnboardingSwitch
  ])

  // The section-level Re-detect re-scans all three frameworks at once; the per-card detect buttons
  // were removed in favor of this single action.
  const isDetectingAnyFramework = isDetectingClaude || isDetectingOpencode || isDetectingCodex
  const handleDetectAllFrameworks = async (): Promise<void> => {
    setFrameworkDetectionError(undefined)
    setInstallActionError(undefined)
    // A non-selected runtime may be broken independently of the framework the user is configuring.
    // Wait for every detector, then refresh the selected environment even when one detector rejected.
    const results = await Promise.allSettled([detectClaude(), detectOpencode(), detectCodex()])
    await checkEnvironment({ force: true })

    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) {
      setFrameworkDetectionError(
        failure.reason instanceof Error
          ? failure.reason.message
          : 'One or more agent runtimes could not be detected.'
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
      icon: <ClaudeColor size={24} />,
      description: "Anthropic's agentic coding tool for the terminal.",
      ready: preflight.claudeReady,
      version: claude.version,
      path: claude.resolvedPath,
      sourceLabel: 'anthropics/claude-code',
      sourceUrl: 'https://github.com/anthropics/claude-code',
      notReadyHint: 'Install Claude Agent below, or install it manually and re-detect.',
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
      icon: <OpenCode size={24} className="text-foreground" />,
      description: 'Open-source coding agent for the terminal.',
      ready: preflight.opencodeReady,
      version: opencode.version,
      path: opencode.resolvedPath,
      sourceLabel: 'anomalyco/opencode',
      sourceUrl: 'https://github.com/anomalyco/opencode',
      notReadyHint: (
        <>
          OpenCode is required for this framework. Install it below, or install it manually (see{' '}
          <ExternalTextLink href="https://opencode.ai/docs">opencode.ai/docs</ExternalTextLink>) and
          re-detect.
        </>
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
      icon: <Codex size={24} className="text-foreground" />,
      description: "OpenAI's coding agent, connected through the Codex ACP adapter.",
      ready: preflight.codexReady,
      version: codex.version,
      path: codex.resolvedPath,
      sourceLabel: 'agentclientprotocol/codex-acp',
      sourceUrl: 'https://github.com/agentclientprotocol/codex-acp',
      notReadyHint: codex.resolvedPath
        ? 'The adapter or its paired native Codex runtime did not pass detection. Reinstall the managed pair below, or repair your manual installation and re-detect.'
        : 'Codex ACP is required for this framework. Install it below, or install it manually and re-detect.',
      uninstallCommand: 'npm uninstall -g @agentclientprotocol/codex-acp',
      managed: codexManaged,
      installSources: getCodexInstallSources(),
      install: codexInstall,
      // Codex has no official-script source; the guard keeps the shared install-source type happy.
      onInstall: (source) => {
        if (source !== 'official-script') return installCodex(source)
        return Promise.resolve(undefined)
      }
    }
  ]

  const installedFrameworks = frameworkCards.filter((card) => card.ready)
  const availableFrameworks = frameworkCards.filter((card) => !card.ready)

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
    blockedInstallSources.managed = 'System requirements not met'
  }
  if (failedCheckIds.has('install-network')) {
    blockedInstallSources.managed ??= 'Installation network unavailable'
    blockedInstallSources.npm = 'Installation network unavailable'
  }

  // First-run installation selects the newly-ready runtime and refreshes the environment gate.
  // Settings keeps its existing behavior: install only, then let the user choose explicitly.
  const installFramework = async (
    card: FrameworkCardModel,
    source: ClaudeInstallSource
  ): Promise<void> => {
    setInstallActionError(undefined)
    setFrameworkDetectionError(undefined)
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
        error instanceof Error ? error.message : 'The installer could not be started.'
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

    // A newer card click wins even if it lands between install completion and this switch.
    if (intentVersion !== onboardingUserIntentVersion.current) return
    queueOnboardingSwitch(card.frameworkId, intentVersion)
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
      needsRepair={
        selectedEnvironmentCheck?.agentFrameworkId === card.frameworkId &&
        selectedEnvironmentCheck.checks.some(
          (check) => check.id === 'agent' && check.status === 'failed'
        )
      }
      version={card.version}
      path={card.path}
      sourceLabel={card.sourceLabel}
      sourceUrl={card.sourceUrl}
      notReadyHint={card.notReadyHint}
      active={agentFrameworkId === card.frameworkId}
      onSelect={() => requestSwitch(card.frameworkId)}
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
      onUninstall={() => setPendingUninstall(card.key)}
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
        aria-label={title}
        description={description}
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
            {isDetectingAnyFramework ? 'Detecting…' : 'Re-detect'}
          </Button>
        }
      >
        <div className="space-y-5">
          {frameworkDetectionError || installActionError || environmentCheckError ? (
            <p className="text-sm text-destructive" role="alert">
              {installActionError || environmentCheckError || frameworkDetectionError}
            </p>
          ) : null}
          {agentCheckFailures.length > 0 ? (
            <div
              aria-label="Agent runtime repair issues"
              className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
            >
              {agentCheckFailures.map((failure, index) => (
                <div key={`${failure.label}-${index}`} className="flex items-start gap-2">
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{failure.summary}</p>
                    {failure.detail ? (
                      <p className="text-xs leading-5 text-muted-foreground">{failure.detail}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {installBlockers.length > 0 ? (
            <div
              aria-label="Agent installation blockers"
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
                Installed · {installedFrameworks.length}
              </p>
              <div className="space-y-3">{installedFrameworks.map(renderFrameworkCard)}</div>
            </div>
          ) : null}
          {availableFrameworks.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Available · {availableFrameworks.length}
              </p>
              <div className="space-y-3">{availableFrameworks.map(renderFrameworkCard)}</div>
            </div>
          ) : null}
          {activeFramework && !activeFramework.supportsSkills ? (
            <p className="text-xs text-muted-foreground">
              Skills aren&apos;t available with {activeFramework.displayName}; use Claude Code for
              skill-based workflows.
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
    </div>
  )
}

export { AgentPanel }
