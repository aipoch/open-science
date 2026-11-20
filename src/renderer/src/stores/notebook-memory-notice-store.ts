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
  pressure?: NotebookMemoryPolicyChangedEvent
  dismissedPressureScopes: string[]
  dismissedRefusalIds: string[]
}>(() => ({ dismissedPressureScopes: [], dismissedRefusalIds: [] }))

export const presentNotebookMemoryRejection = (rejection: NotebookMemoryRejectedEvent): void => {
  const { terminal, dismissedRefusalIds } = useNotebookMemoryNoticeStore.getState()
  if (rejection.refusalId && dismissedRefusalIds.includes(rejection.refusalId)) return
  const terminalRejection = rejection.source === 'user' && rejection.inputKind === 'terminal'
  useNotebookMemoryNoticeStore.setState({
    rejection,
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
    dismissedRefusalIds: rejection?.refusalId
      ? [...dismissedRefusalIds.slice(-63), rejection.refusalId]
      : dismissedRefusalIds
  })
}

export const dismissNotebookMemoryPressure = (): void => {
  const { pressure, dismissedPressureScopes } = useNotebookMemoryNoticeStore.getState()
  if (!pressure) return
  const scope = pressure.memory.executionScope
  useNotebookMemoryNoticeStore.setState({
    pressure: undefined,
    dismissedPressureScopes: dismissedPressureScopes.includes(scope)
      ? dismissedPressureScopes
      : [...dismissedPressureScopes.slice(-63), scope]
  })
}

export const observeNotebookMemoryPolicy = (event: NotebookMemoryPolicyChangedEvent): void => {
  const state = useNotebookMemoryNoticeStore.getState()
  const scope = event.memory.executionScope
  const dismissedPressureScopes =
    event.memory.status === 'healthy'
      ? state.dismissedPressureScopes.filter((entry) => entry !== scope)
      : state.dismissedPressureScopes
  useNotebookMemoryNoticeStore.setState({
    dismissedPressureScopes,
    ...(state.rejection?.memory.executionScope === scope
      ? { rejection: { ...state.rejection, memory: event.memory } }
      : {}),
    pressure:
      event.hasLiveResources &&
      event.memory.status === 'pressured' &&
      event.memory.pressureLevel !== 'normal' &&
      !dismissedPressureScopes.includes(scope)
        ? event
        : state.pressure?.memory.executionScope === scope
          ? undefined
          : state.pressure
  })
}
