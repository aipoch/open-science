import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentFrameworkId,
  AgentFrameworkView,
  ClaudeInfo,
  ClaudeInstallProgressEvent,
  ClaudeInstallResult,
  ClaudeInstallSource,
  CodexInfo,
  EnvironmentCheckResult,
  OpencodeInfo,
  Preflight
} from '../../../../shared/settings'
import { selectAnyInstalling, useSettingsStore } from '@/stores/settings-store'

type EnvironmentMode = 'automatic' | 'manual'

const describeInstallFailure = (result: ClaudeInstallResult): string => {
  if (result.error) return result.error
  if (result.timedOut) return 'The installer timed out before Claude was ready.'
  if (result.exitCode !== undefined) return `The installer exited with code ${result.exitCode}.`

  return 'Claude was not detected after the installer finished.'
}

// Ready only when the latest check is for the CURRENTLY selected framework and no re-check is in
// flight — otherwise switching a ready Claude to an uninstalled OpenCode would let Continue fire on
// the stale (Claude) result before the re-detect lands.
const useEnvironmentReady = (): boolean => {
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)

  return (
    !isCheckingEnvironment &&
    environmentCheck?.ready === true &&
    environmentCheck.agentFrameworkId === agentFrameworkId
  )
}

type AgentEnvironment = {
  agentFrameworkId: AgentFrameworkId
  agentFrameworks: AgentFrameworkView[]
  claude: ClaudeInfo
  opencode: OpencodeInfo
  codex: CodexInfo
  preflight: Preflight
  isDetectingClaude: boolean
  isDetectingOpencode: boolean
  isDetectingCodex: boolean
  isInstalling: boolean
  installBusy: boolean
  installLogs: string[]
  installProgress: ClaudeInstallProgressEvent | null
  storeInstallError: string | undefined
  npmAvailable: boolean
  environmentCheck: EnvironmentCheckResult | undefined
  environmentCheckError: string | undefined
  isCheckingEnvironment: boolean
  environmentMode: EnvironmentMode
  setEnvironmentMode: React.Dispatch<React.SetStateAction<EnvironmentMode>>
  showFrameworkSwitcher: boolean
  setShowFrameworkSwitcher: React.Dispatch<React.SetStateAction<boolean>>
  automaticInstallError: string | undefined
  handleEnvironmentCheck: () => Promise<void>
  handleInstall: (source: ClaudeInstallSource, framework?: AgentFrameworkId) => Promise<void>
  handlePickFramework: (id: AgentFrameworkId) => void
}

// All agent-runtime state and actions shared by the Agent step and the recovery view: framework
// selection (with the prefer-installed auto-pick), detection, and installs across the three
// supported frameworks. `isRecovery` only suppresses the first-run auto-pick — a returning user's
// saved framework always wins there.
const useAgentEnvironment = (isRecovery: boolean): AgentEnvironment => {
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const setAgentFramework = useSettingsStore((state) => state.setAgentFramework)
  const isDetectingOpencode = useSettingsStore((state) => state.isDetectingOpencode)
  const isDetectingCodex = useSettingsStore((state) => state.isDetectingCodex)
  const isDetectingClaude = useSettingsStore((state) => state.isDetectingClaude)
  const detectCodex = useSettingsStore((state) => state.detectCodex)
  const installOpencode = useSettingsStore((state) => state.installOpencode)
  const installCodex = useSettingsStore((state) => state.installCodex)
  const installClaude = useSettingsStore((state) => state.installClaude)
  const claude = useSettingsStore((state) => state.claude)
  const opencode = useSettingsStore((state) => state.opencode)
  const codex = useSettingsStore((state) => state.codex)
  const preflight = useSettingsStore((state) => state.preflight)
  // Progress belongs to the selected runtime, while the global lock prevents concurrent installs.
  const activeInstall = useSettingsStore((state) => state.installStates[state.agentFrameworkId])
  const installBusy = useSettingsStore(selectAnyInstalling)
  const isInstalling = activeInstall.isInstalling
  const installLogs = activeInstall.installLogs
  const installProgress = activeInstall.installProgress
  const storeInstallError = activeInstall.installError
  const npmAvailable = useSettingsStore((state) => state.npmAvailable)
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)

  const [environmentMode, setEnvironmentMode] = useState<EnvironmentMode>('automatic')
  // The framework switcher stays collapsed once the selected agent is ready; the user reveals it with
  // "Change agent" only when they actually want a different runtime.
  const [showFrameworkSwitcher, setShowFrameworkSwitcher] = useState(false)
  const [automaticInstallError, setAutomaticInstallError] = useState<string | undefined>(undefined)

  // Once the user manually picks an agent, stop auto-selecting; and only auto-select once per mount.
  const userPickedFramework = useRef(false)
  const autoSelectAttempted = useRef(false)
  // Serializes framework switches: detection + preflight run async in the store, so a second switch
  // started before the first settles could interleave and leave the selection, preflight, and
  // environment result out of sync. This synchronous guard drops any switch while one is in flight.
  const switchInFlight = useRef(false)

  const handleEnvironmentCheck = async (): Promise<void> => {
    setAutomaticInstallError(undefined)
    if (agentFrameworkId === 'codex') await detectCodex()
    await checkEnvironment()
  }

  const handleInstall = async (
    source: ClaudeInstallSource,
    framework: AgentFrameworkId = agentFrameworkId
  ): Promise<void> => {
    setAutomaticInstallError(undefined)

    try {
      // Install the requested framework: the per-card button names its own, the automatic one-click
      // install targets the selected framework.
      let result: ClaudeInstallResult
      if (framework === 'codex') {
        if (source === 'official-script') {
          throw new Error('Codex supports app-managed or npm installation only.')
        }
        result = await installCodex(source)
      } else if (framework === 'opencode') {
        result = await installOpencode(source)
      } else {
        result = await installClaude(
          source,
          source === 'managed' ? environmentCheck?.recommendedRegistry : undefined
        )
      }

      if (!result.ok) {
        setAutomaticInstallError(describeInstallFailure(result))
        return
      }

      await checkEnvironment()
    } catch (error) {
      setAutomaticInstallError(
        error instanceof Error ? error.message : 'The installer could not be started.'
      )
    }
  }

  // Switching the framework re-detects it and re-runs the host inspection so the environment card
  // reflects the chosen runtime immediately. Serialized by switchInFlight so overlapping switches can't
  // interleave the store's async detection/preflight; refs (not setState) keep it usable from effects.
  const runFrameworkSwitch = useCallback(
    async (id: AgentFrameworkId): Promise<void> => {
      if (switchInFlight.current || id === agentFrameworkId) return

      switchInFlight.current = true
      try {
        await setAgentFramework(id)
        await checkEnvironment()
      } finally {
        switchInFlight.current = false
      }
    },
    [agentFrameworkId, setAgentFramework, checkEnvironment]
  )

  // Records an explicit user choice so the prefer-installed auto-selection below never overrides it.
  const handlePickFramework = (id: AgentFrameworkId): void => {
    userPickedFramework.current = true
    setAutomaticInstallError(undefined)
    void runFrameworkSwitch(id)
  }

  // Prefer an installed runtime during first-time onboarding. Registry order is the stable tie-breaker
  // (currently Claude Code, OpenCode, then Codex), while an installed current selection always wins.
  // Runs once and never overrides an explicit user choice or a returning user's saved framework.
  useEffect(() => {
    if (isRecovery || userPickedFramework.current || autoSelectAttempted.current) return
    if (agentFrameworks.length < 2) return

    const readyByFramework: Record<AgentFrameworkId, boolean> = {
      'claude-code': preflight.claudeReady,
      opencode: preflight.opencodeReady,
      codex: preflight.codexReady
    }
    if (readyByFramework[agentFrameworkId]) return

    const installedFramework = agentFrameworks.find((framework) => readyByFramework[framework.id])
    if (installedFramework) {
      autoSelectAttempted.current = true
      void runFrameworkSwitch(installedFramework.id)
    }
  }, [
    isRecovery,
    agentFrameworks,
    agentFrameworkId,
    preflight.claudeReady,
    preflight.opencodeReady,
    preflight.codexReady,
    runFrameworkSwitch
  ])

  return {
    agentFrameworkId,
    agentFrameworks,
    claude,
    opencode,
    codex,
    preflight,
    isDetectingClaude,
    isDetectingOpencode,
    isDetectingCodex,
    isInstalling,
    installBusy,
    installLogs,
    installProgress,
    storeInstallError,
    npmAvailable,
    environmentCheck,
    environmentCheckError,
    isCheckingEnvironment,
    environmentMode,
    setEnvironmentMode,
    showFrameworkSwitcher,
    setShowFrameworkSwitcher,
    automaticInstallError,
    handleEnvironmentCheck,
    handleInstall,
    handlePickFramework
  }
}

export { useAgentEnvironment, useEnvironmentReady }
export type { EnvironmentMode }
