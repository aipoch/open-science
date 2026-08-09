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
import type { SideChatEntry, SideChatSnapshot } from '../../../../shared/side-chat'
import type { ChatSession } from '@/stores/session-store'

type SideChatView = Readonly<{
  generation: number
  revision?: number
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
  views: ReadonlyMap<string, SideChatView>
  closingParentSessionIds: ReadonlySet<string>
  hydrated: boolean
  hydrationError?: string
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
  const [views, setViews] = useState<ReadonlyMap<string, SideChatView>>(() => new Map())
  const [hydrated, setHydrated] = useState(() => !window.api?.sideChat?.list)
  const [hydrationError, setHydrationError] = useState<string>()
  const viewsRef = useRef<ReadonlyMap<string, SideChatView>>(views)
  const [closingParentSessionIds, setClosingParentSessionIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const closingParentSessionIdsRef = useRef<ReadonlySet<string>>(closingParentSessionIds)
  const revisionByParentRef = useRef(new Map<string, number>())
  const sequenceRef = useRef(0)

  const update = useCallback(
    (
      parentSessionId: string,
      value:
        SideChatView | undefined | ((current: SideChatView | undefined) => SideChatView | undefined)
    ): void => {
      const current = viewsRef.current.get(parentSessionId)
      const next = typeof value === 'function' ? value(current) : value
      if (next === current) return
      const updated = new Map(viewsRef.current)
      if (next) updated.set(parentSessionId, next)
      else updated.delete(parentSessionId)
      viewsRef.current = updated
      setViews(updated)
    },
    []
  )

  const viewFromSnapshot = useCallback(
    (snapshot: SideChatSnapshot, current?: SideChatView): SideChatView => ({
      generation: current?.generation ?? ++sequenceRef.current,
      revision: snapshot.revision,
      parentSessionId: snapshot.parentSessionId,
      projectId: snapshot.projectId,
      sideSessionId: snapshot.sideSessionId,
      entries: snapshot.entries,
      draft: current?.draft ?? '',
      running: snapshot.running,
      error: snapshot.error
    }),
    []
  )

  useEffect(() => {
    const api = window.api?.sideChat
    if (!api?.onEvent) {
      setHydrated(true)
      return
    }
    let disposed = false
    const removeListener = api.onEvent((envelope) => {
      const lastRevision = revisionByParentRef.current.get(envelope.parentSessionId) ?? 0
      const revision = envelope.revision ?? lastRevision + 1
      if (revision < lastRevision) return
      revisionByParentRef.current.set(envelope.parentSessionId, revision)

      const event = envelope.event
      if (event.kind === 'closed') {
        if (event.reason === 'closed') {
          update(envelope.parentSessionId, undefined)
        } else {
          update(envelope.parentSessionId, (current) =>
            current
              ? {
                  ...current,
                  revision,
                  running: false,
                  error: 'Side chat connection ended. Send a Follow up to reconnect.'
                }
              : current
          )
        }
        return
      }
      update(envelope.parentSessionId, (current) => {
        if (current?.sideSessionId && envelope.sideSessionId !== current.sideSessionId) {
          return current
        }
        let next: SideChatView = current
          ? { ...current, revision, sideSessionId: current.sideSessionId ?? envelope.sideSessionId }
          : {
              generation: ++sequenceRef.current,
              revision,
              parentSessionId: envelope.parentSessionId,
              projectId: envelope.projectId,
              sideSessionId: envelope.sideSessionId,
              entries: [],
              draft: '',
              running: true
            }
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
              if (entry?.kind === 'message') {
                entries[existing] = { ...entry, text: entry.text + text }
              }
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
          next = {
            ...next,
            running: false,
            error: event.text ?? event.title ?? 'Side chat failed.'
          }
        } else if (event.kind === 'stop') {
          next = { ...next, running: false }
        }
        return next
      })
    })

    if (!api.list) {
      setHydrated(true)
      return removeListener
    }
    void api.list().then(
      (snapshotList) => {
        if (disposed) return
        const next = new Map(viewsRef.current)
        const liveParents = new Set(snapshotList.chats.map((chat) => chat.parentSessionId))
        for (const [parentSessionId, view] of next) {
          if (!liveParents.has(parentSessionId) && (view.revision ?? 0) <= snapshotList.revision) {
            next.delete(parentSessionId)
          }
        }
        for (const snapshot of snapshotList.chats) {
          const lastRevision = revisionByParentRef.current.get(snapshot.parentSessionId) ?? 0
          if (snapshot.revision < lastRevision) continue
          revisionByParentRef.current.set(snapshot.parentSessionId, snapshot.revision)
          next.set(
            snapshot.parentSessionId,
            viewFromSnapshot(snapshot, next.get(snapshot.parentSessionId))
          )
        }
        viewsRef.current = next
        setViews(next)
        setHydrationError(undefined)
        setHydrated(true)
      },
      (error) => {
        if (disposed) return
        setHydrationError(`Could not restore Side chats: ${errorText(error)}`)
        setHydrated(false)
      }
    )
    return () => {
      disposed = true
      removeListener()
    }
  }, [update, viewFromSnapshot])

  const start = useCallback(
    async (
      parent: Readonly<{ sessionId: string; projectId: string }>,
      rawText: string
    ): Promise<boolean> => {
      const text = rawText.trim()
      if (
        !text ||
        !hydrated ||
        viewsRef.current.has(parent.sessionId) ||
        closingParentSessionIdsRef.current.has(parent.sessionId) ||
        !window.api?.sideChat
      ) {
        return false
      }
      sequenceRef.current += 1
      const generation = sequenceRef.current
      const next: SideChatView = {
        generation,
        revision: 0,
        parentSessionId: parent.sessionId,
        projectId: parent.projectId,
        entries: [{ id: `side-user-${generation}-1`, kind: 'message', role: 'user', text }],
        draft: '',
        running: true
      }
      update(parent.sessionId, next)
      try {
        const started = await window.api.sideChat.start({
          parentSessionId: parent.sessionId,
          projectId: parent.projectId,
          text
        })
        const current = viewsRef.current.get(parent.sessionId)
        if (!current || current.generation !== generation) {
          await window.api.sideChat.close({ sideSessionId: started.sideSessionId })
          return false
        }
        update(parent.sessionId, { ...current, sideSessionId: started.sideSessionId })
        return true
      } catch (error) {
        const current = viewsRef.current.get(parent.sessionId)
        if (current?.generation === generation) {
          update(parent.sessionId, undefined)
          throw error
        }
        return false
      }
    },
    [hydrated, update]
  )

  const send = useCallback(
    async (parentSessionId: string, rawText: string): Promise<boolean> => {
      const text = rawText.trim()
      const current = viewsRef.current.get(parentSessionId)
      if (!current?.sideSessionId || current.running || !text) return false
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
      update(parentSessionId, next)
      try {
        await window.api.sideChat.send({ sideSessionId: current.sideSessionId, text })
        return true
      } catch (error) {
        update(parentSessionId, (latest) =>
          latest?.generation === current.generation
            ? { ...latest, running: false, error: errorText(error) }
            : latest
        )
        return false
      }
    },
    [update]
  )

  const cancel = useCallback(
    (parentSessionId: string): void => {
      const current = viewsRef.current.get(parentSessionId)
      if (!current?.sideSessionId || !current.running) return
      void window.api.sideChat.cancel({ sideSessionId: current.sideSessionId }).catch((error) => {
        update(parentSessionId, (latest) =>
          latest?.generation === current.generation
            ? { ...latest, error: errorText(error) }
            : latest
        )
      })
    },
    [update]
  )

  const setDraft = useCallback(
    (parentSessionId: string, value: SetStateAction<string>): void => {
      update(parentSessionId, (current) => {
        if (!current) return current
        const draft = typeof value === 'function' ? value(current.draft) : value
        return { ...current, draft }
      })
    },
    [update]
  )

  const close = useCallback(
    (parentSessionId: string): void => {
      const current = viewsRef.current.get(parentSessionId)
      if (!current) return
      const closing = new Set(closingParentSessionIdsRef.current).add(parentSessionId)
      closingParentSessionIdsRef.current = closing
      setClosingParentSessionIds(closing)
      update(parentSessionId, undefined)
      const request = current.sideSessionId
        ? { sideSessionId: current.sideSessionId }
        : { parentSessionId: current.parentSessionId }
      void window.api.sideChat
        .close(request)
        .catch((error) => {
          update(
            parentSessionId,
            (latest) =>
              latest ?? {
                ...current,
                running: false,
                error: `Could not close Side chat: ${errorText(error)}`
              }
          )
        })
        .finally(() => {
          const next = new Set(closingParentSessionIdsRef.current)
          next.delete(parentSessionId)
          closingParentSessionIdsRef.current = next
          setClosingParentSessionIds(next)
        })
    },
    [update]
  )

  return useMemo<SideChatRuntimeController>(
    () => ({
      views,
      closingParentSessionIds,
      hydrated,
      hydrationError,
      start,
      send,
      setDraft,
      cancel,
      close
    }),
    [cancel, close, closingParentSessionIds, hydrated, hydrationError, send, setDraft, start, views]
  )
}

const SideChatProvider = ({ children }: PropsWithChildren): ReactElement =>
  createElement(SideChatContext.Provider, { value: useOwnedSideChatRuntime() }, children)

const useSideChatController = (
  parent: Readonly<{ sessionId: string; projectId: string }> | undefined
): SideChatController => {
  const runtime = useContext(SideChatContext)
  const candidate = parent ? runtime?.views.get(parent.sessionId) : undefined
  const view = candidate?.projectId === parent?.projectId ? candidate : undefined
  const unavailableReason = runtime?.hydrationError
    ? runtime.hydrationError
    : runtime && !runtime.hydrated
      ? 'Restoring Side chats…'
      : parent && runtime?.closingParentSessionIds.has(parent.sessionId)
        ? 'Closing Side chat…'
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

const useOpenSideChatParentSessionIds = (): ReadonlySet<string> => {
  const runtime = useContext(SideChatContext)
  return useMemo(() => new Set(runtime?.views.keys() ?? []), [runtime?.views])
}

const useIsSideChatOpenForSession = (sessionId: string): boolean =>
  useContext(SideChatContext)?.views.has(sessionId) ?? false

export {
  hasMainConversation,
  SideChatProvider,
  useIsSideChatOpenForSession,
  useOpenSideChatParentSessionIds,
  useSideChatController
}
export type { SideChatController, SideChatEntry, SideChatView }
