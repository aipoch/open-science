import { create } from 'zustand'
import type {
  NotebookMemoryRejectedEvent,
  NotebookMemoryPolicyChangedEvent
} from '../../../shared/notebook-memory'

type CurrentNotebookTerminal = Readonly<{
  id: string
  projectId: string
  sessionId: string
  target: string
  enabled: boolean
  retry: () => Promise<void>
}>

// This is a visible decision and the current mounted editor, never a saved execution or code.
export const useNotebookMemoryNoticeStore = create<{
  rejection?: NotebookMemoryRejectedEvent
  terminal?: CurrentNotebookTerminal
  rejectedTerminalId?: string
  warning?: NotebookMemoryPolicyChangedEvent
  pressure?: NotebookMemoryPolicyChangedEvent
  criticalScopes: string[]
  dismissedRefusalIds: string[]
}>(() => ({ criticalScopes: [], dismissedRefusalIds: [] }))

export const presentNotebookMemoryRejection = (rejection: NotebookMemoryRejectedEvent): void => {
  const { terminal, dismissedRefusalIds } = useNotebookMemoryNoticeStore.getState()
  if (rejection.refusalId && dismissedRefusalIds.includes(rejection.refusalId)) return
  const terminalRejection = rejection.source === 'user' && rejection.inputKind === 'terminal'
  useNotebookMemoryNoticeStore.setState({
    rejection,
    warning: undefined,
    rejectedTerminalId:
      terminalRejection &&
      terminal?.projectId === rejection.projectId &&
      terminal.sessionId === rejection.sessionId &&
      (!rejection.terminalTarget || rejection.terminalTarget === terminal.target)
        ? terminal.id
        : undefined
  })
}

export const registerNotebookMemoryTerminal = (terminal: CurrentNotebookTerminal): (() => void) => {
  useNotebookMemoryNoticeStore.setState({ terminal })
  return () => {
    if (useNotebookMemoryNoticeStore.getState().terminal === terminal) {
      useNotebookMemoryNoticeStore.setState({ terminal: undefined })
    }
  }
}

export const dismissNotebookMemoryRejection = (): void => {
  const { rejection, dismissedRefusalIds } = useNotebookMemoryNoticeStore.getState()
  useNotebookMemoryNoticeStore.setState({
    rejection: undefined,
    rejectedTerminalId: undefined,
    warning: undefined,
    dismissedRefusalIds: rejection?.refusalId
      ? [...dismissedRefusalIds.slice(-63), rejection.refusalId]
      : dismissedRefusalIds
  })
}

export const observeNotebookMemoryPolicy = (event: NotebookMemoryPolicyChangedEvent): void => {
  const state = useNotebookMemoryNoticeStore.getState()
  const scope = event.memory.executionScope
  const criticalScopes =
    event.memory.status === 'healthy'
      ? state.criticalScopes.filter((entry) => entry !== scope)
      : state.criticalScopes
  const critical =
    event.hasLiveResources &&
    event.memory.status === 'pressured' &&
    event.memory.executionScope === 'darwin:host' &&
    event.memory.source === 'darwin-sysctl-dispatch' &&
    event.memory.pressureLevel === 'critical'
  const showWarning = critical && !criticalScopes.includes(scope)
  useNotebookMemoryNoticeStore.setState({
    criticalScopes: showWarning ? [...criticalScopes, scope] : criticalScopes,
    ...(state.rejection?.memory.executionScope === scope
      ? { rejection: { ...state.rejection, memory: event.memory } }
      : {}),
    warning: state.rejection
      ? undefined
      : showWarning
        ? event
        : state.warning?.memory.executionScope === scope
          ? event.hasLiveResources
            ? event
            : undefined
          : state.warning,
    pressure:
      event.hasLiveResources && event.memory.status === 'pressured'
        ? event
        : state.pressure?.memory.executionScope === scope
          ? undefined
          : state.pressure
  })
}
