import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type SetStateAction
} from 'react'

import { getAcpRuntimeEventText } from '../../../../shared/acp'
import { useSessionStore, type ChatSession } from '@/stores/session-store'

type SideChatEntry =
  | Readonly<{ id: string; kind: 'message'; role: 'user' | 'assistant'; text: string }>
  | Readonly<{ id: string; kind: 'tool'; title: string; status?: string }>

type SideChatView = Readonly<{
  generation: number
  parentSessionId: string
  projectId: string
  sideSessionId?: string
  entries: readonly SideChatEntry[]
  draft: string
  running: boolean
  error?: string
}>

type SideChatController = Readonly<{
  view: SideChatView | undefined
  unavailableReason?: string
  start: (text: string) => Promise<boolean>
  send: (text: string) => Promise<boolean>
  setDraft: (value: SetStateAction<string>) => void
  cancel: () => void
  close: () => void
}>

type SideChatRuntimeController = Readonly<{
  view: SideChatView | undefined
  start: (
    parent: Readonly<{ sessionId: string; projectId: string }>,
    text: string
  ) => Promise<boolean>
  send: (parentSessionId: string, text: string) => Promise<boolean>
  setDraft: (parentSessionId: string, value: SetStateAction<string>) => void
  cancel: (parentSessionId: string) => void
  close: (parentSessionId: string) => void
}>

const SideChatContext = createContext<SideChatRuntimeController | undefined>(undefined)

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const hasMainConversation = (session: ChatSession | undefined): boolean =>
  Boolean(session?.messages.some((message) => message.role === 'user' && !message.relayedFrom))

const useOwnedSideChatRuntime = (): SideChatRuntimeController => {
  const [view, setView] = useState<SideChatView>()
  const activeRef = useRef<SideChatView | undefined>(undefined)
  const sequenceRef = useRef(0)

  const update = useCallback((next: SideChatView | undefined): void => {
    activeRef.current = next
    setView(next)
  }, [])

  useEffect(() => {
    const api = window.api?.sideChat
    if (!api?.onEvent) return
    return api.onEvent((envelope) => {
      const current = activeRef.current
      if (
        !current ||
        envelope.parentSessionId !== current.parentSessionId ||
        (current.sideSessionId && envelope.sideSessionId !== current.sideSessionId)
      ) {
        return
      }
      const event = envelope.event
      if (event.kind === 'closed') {
        update(undefined)
        return
      }
      let next = current.sideSessionId
        ? current
        : { ...current, sideSessionId: envelope.sideSessionId }
      if (event.kind === 'message' && event.role === 'assistant') {
        const text = getAcpRuntimeEventText(event)
        if (text) {
          const streamId = event.messageId ?? event.id
          const existing = next.entries.findIndex(
            (entry) =>
              entry.kind === 'message' && entry.role === 'assistant' && entry.id === streamId
          )
          const entries = [...next.entries]
          if (existing >= 0) {
            const entry = entries[existing]
            if (entry?.kind === 'message') entries[existing] = { ...entry, text: entry.text + text }
          } else {
            entries.push({ id: streamId, kind: 'message', role: 'assistant', text })
          }
          next = { ...next, entries }
        }
      } else if (event.kind === 'tool' && event.toolCallId) {
        const existing = next.entries.findIndex(
          (entry) => entry.kind === 'tool' && entry.id === event.toolCallId
        )
        const tool: SideChatEntry = {
          id: event.toolCallId,
          kind: 'tool',
          title: event.title ?? event.providerToolName ?? 'Tool',
          status: event.status
        }
        const entries = [...next.entries]
        if (existing >= 0) entries[existing] = tool
        else entries.push(tool)
        next = { ...next, entries }
      } else if (event.kind === 'error') {
        next = { ...next, running: false, error: event.text ?? event.title ?? 'Side chat failed.' }
      } else if (event.kind === 'stop') {
        next = { ...next, running: false }
      }
      update(next)
    })
  }, [update])

  // Session navigation does not touch Side chat. Deleting its parent does: main owns runtime
  // teardown, while this app-lifetime projection only drops the now-unreachable panel state.
  useEffect(() => {
    if (typeof useSessionStore.subscribe !== 'function') return
    return useSessionStore.subscribe((state) => {
      const current = activeRef.current
      if (current && !state.sessions.some((session) => session.id === current.parentSessionId)) {
        update(undefined)
      }
    })
  }, [update])

  const start = useCallback(
    async (
      parent: Readonly<{ sessionId: string; projectId: string }>,
      rawText: string
    ): Promise<boolean> => {
      const text = rawText.trim()
      const alreadyOpen = activeRef.current !== undefined
      if (!text || alreadyOpen || !window.api?.sideChat) return false
      sequenceRef.current += 1
      const generation = sequenceRef.current
      const next: SideChatView = {
        generation,
        parentSessionId: parent.sessionId,
        projectId: parent.projectId,
        entries: [{ id: `side-user-${generation}-1`, kind: 'message', role: 'user', text }],
        draft: '',
        running: true
      }
      update(next)
      try {
        const started = await window.api.sideChat.start({
          parentSessionId: parent.sessionId,
          projectId: parent.projectId,
          text
        })
        const current = activeRef.current
        if (!current || current.generation !== generation) {
          await window.api.sideChat.close({ sideSessionId: started.sideSessionId })
          return false
        }
        update({ ...current, sideSessionId: started.sideSessionId })
        return true
      } catch (error) {
        const current = activeRef.current
        if (current?.generation === generation) {
          update(undefined)
          throw error
        }
        return false
      }
    },
    [update]
  )

  const send = useCallback(
    async (parentSessionId: string, rawText: string): Promise<boolean> => {
      const text = rawText.trim()
      const current = activeRef.current
      if (
        current?.parentSessionId !== parentSessionId ||
        !current.sideSessionId ||
        current.running ||
        !text
      ) {
        return false
      }
      sequenceRef.current += 1
      const next = {
        ...current,
        entries: [
          ...current.entries,
          {
            id: `side-user-${current.generation}-${sequenceRef.current}`,
            kind: 'message' as const,
            role: 'user' as const,
            text
          }
        ],
        running: true,
        error: undefined
      }
      update(next)
      try {
        await window.api.sideChat.send({ sideSessionId: current.sideSessionId, text })
        return true
      } catch (error) {
        const latest = activeRef.current
        if (latest?.generation === current.generation) {
          update({ ...latest, running: false, error: errorText(error) })
        }
        return false
      }
    },
    [update]
  )

  const cancel = useCallback(
    (parentSessionId: string): void => {
      const current = activeRef.current
      if (
        current?.parentSessionId !== parentSessionId ||
        !current.sideSessionId ||
        !current.running
      ) {
        return
      }
      void window.api.sideChat.cancel({ sideSessionId: current.sideSessionId }).catch((error) => {
        const latest = activeRef.current
        if (latest?.generation === current.generation) {
          update({ ...latest, error: errorText(error) })
        }
      })
    },
    [update]
  )

  const setDraft = useCallback(
    (parentSessionId: string, value: SetStateAction<string>): void => {
      const current = activeRef.current
      if (current?.parentSessionId !== parentSessionId) return
      const draft = typeof value === 'function' ? value(current.draft) : value
      update({ ...current, draft })
    },
    [update]
  )

  const close = useCallback(
    (parentSessionId: string): void => {
      const current = activeRef.current
      if (current?.parentSessionId !== parentSessionId) return
      update(undefined)
      if (current.sideSessionId) {
        void window.api.sideChat
          .close({ sideSessionId: current.sideSessionId })
          .catch(() => undefined)
      } else {
        void window.api.sideChat
          .close({ parentSessionId: current.parentSessionId, discardRelays: false })
          .catch(() => undefined)
      }
    },
    [update]
  )

  const controller = useMemo<SideChatRuntimeController>(
    () => ({ view, start, send, setDraft, cancel, close }),
    [cancel, close, send, setDraft, start, view]
  )

  return controller
}

const SideChatProvider = ({ children }: PropsWithChildren): ReactElement =>
  createElement(SideChatContext.Provider, { value: useOwnedSideChatRuntime() }, children)

const useSideChatController = (
  parent: Readonly<{ sessionId: string; projectId: string }> | undefined
): SideChatController => {
  const runtime = useContext(SideChatContext)
  const belongsToParent = Boolean(
    parent &&
    runtime?.view?.parentSessionId === parent.sessionId &&
    runtime.view.projectId === parent.projectId
  )
  const view = belongsToParent ? runtime?.view : undefined
  const unavailableReason =
    runtime?.view && !belongsToParent
      ? 'Another Side chat is open. Return to that conversation or close it first.'
      : undefined

  return {
    view,
    unavailableReason,
    start: (text) => (runtime && parent ? runtime.start(parent, text) : Promise.resolve(false)),
    send: (text) =>
      runtime && parent ? runtime.send(parent.sessionId, text) : Promise.resolve(false),
    setDraft: (text) => {
      if (runtime && parent) runtime.setDraft(parent.sessionId, text)
    },
    cancel: () => {
      if (runtime && parent) runtime.cancel(parent.sessionId)
    },
    close: () => {
      if (runtime && parent) runtime.close(parent.sessionId)
    }
  }
}

const useOpenSideChatParentSessionId = (): string | undefined =>
  useContext(SideChatContext)?.view?.parentSessionId

export {
  hasMainConversation,
  SideChatProvider,
  useOpenSideChatParentSessionId,
  useSideChatController
}
export type { SideChatController, SideChatEntry, SideChatView }
