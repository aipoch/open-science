import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

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

// The Agent settings panel: agent-framework management end to end — detection, install, uninstall,
// and the active-framework switch. Fully store-driven (no props); the uninstall and switch
// confirmations live here because only these cards can trigger them.
const AgentPanel = (): React.JSX.Element => {
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

  // Track whether an ACP prompt is currently running so the uninstall button can be disabled.
  const [promptInFlight, setPromptInFlight] = useState(false)
  useEffect(() => {
    void window.api.acp.getState().then((s) => setPromptInFlight(s.promptInFlight))
    return window.api.acp.onState((s) => setPromptInFlight(s.promptInFlight))
  }, [])

  // The app-managed runtime pending an uninstall confirmation (null = dialog closed), plus the
  // in-flight flag so the dialog and status cards can show progress and stay locked during removal.
  const [pendingUninstall, setPendingUninstall] = useState<FrameworkKey | null>(null)
  const [isUninstalling, setIsUninstalling] = useState(false)
  // The framework the user picked (via a card) but hasn't confirmed switching to yet.
  const [pendingSwitch, setPendingSwitch] = useState<AgentFrameworkId | null>(null)

  // Removes the app-managed runtime for the framework awaiting confirmation, then closes the dialog.
  // The store applies the refreshed snapshot (which may auto-switch the active framework) and main
  // reconnects the agent, so the cards and readiness gate update without a manual re-detect.
  const handleConfirmUninstall = async (): Promise<void> => {
    if (!pendingUninstall) return

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

  // Selecting a card requests a framework switch; a no-op when it's already the active one. The actual
  // switch is deferred to the confirmation, since it starts a fresh agent session.
  const requestSwitch = (target: AgentFrameworkId): void => {
    if (target !== agentFrameworkId) setPendingSwitch(target)
  }

  const confirmSwitch = (): void => {
    if (pendingSwitch) void setAgentFramework(pendingSwitch)
    setPendingSwitch(null)
  }

  const activeFramework = agentFrameworks.find((framework) => framework.id === agentFrameworkId)
  const pendingSwitchName = agentFrameworks.find(
    (framework) => framework.id === pendingSwitch
  )?.displayName

  // The section-level Re-detect re-scans all three frameworks at once; the per-card detect buttons
  // were removed in favor of this single action.
  const isDetectingAnyFramework = isDetectingClaude || isDetectingOpencode || isDetectingCodex
  const handleDetectAllFrameworks = (): void => {
    void detectClaude()
    void detectOpencode()
    void detectCodex()
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
    onInstall: (source: ClaudeInstallSource) => void
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
      onInstall: (source) => void installClaude(source)
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
      onInstall: (source) => void installOpencode(source)
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
        if (source !== 'official-script') void installCodex(source)
      }
    }
  ]

  const installedFrameworks = frameworkCards.filter((card) => card.ready)
  const availableFrameworks = frameworkCards.filter((card) => !card.ready)

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
      version={card.version}
      path={card.path}
      sourceLabel={card.sourceLabel}
      sourceUrl={card.sourceUrl}
      notReadyHint={card.notReadyHint}
      active={agentFrameworkId === card.frameworkId}
      onSelect={() => requestSwitch(card.frameworkId)}
      selectDisabled={anyInstalling || isUninstalling}
      uninstallCommand={card.uninstallCommand}
      managed={card.managed}
      isUninstalling={isUninstalling && pendingUninstall === card.key}
      isDetecting={isDetectingAnyFramework}
      promptInFlight={promptInFlight}
      onUninstall={() => setPendingUninstall(card.key)}
      installSources={card.installSources}
      install={card.install}
      installRunning={anyInstalling}
      npmAvailable={npmAvailable}
      onInstall={(source) => card.onInstall(source)}
    />
  )

  return (
    <div className="space-y-5 p-5">
      <ModelFrameworkCompatibilityAlert />

      {/* The runtime cards double as the framework selector: pick a card to make it the active
          backend (confirmed, since it starts a fresh session). Cards are grouped by install state
          so management (Installed) and acquisition (Available) don't compete for attention — but
          the active runtime can't be uninstalled (switch to the other one first). */}
      <SettingsSection
        title="Agent framework"
        aria-label="Agent framework"
        description={
          <>
            Choose which coding-agent backend drives your sessions. Select a card to switch;
            switching starts a fresh agent session, and open conversations have their transcript
            replayed to the new backend. The active runtime can&apos;t be uninstalled — switch to
            the other one first.
          </>
        }
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDetectAllFrameworks}
            disabled={isDetectingAnyFramework || anyInstalling || isUninstalling}
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
    </div>
  )
}

export { AgentPanel }
