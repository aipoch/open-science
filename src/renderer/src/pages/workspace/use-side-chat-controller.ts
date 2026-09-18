import { sideChatParentBranch } from '../../../../shared/side-chat'
import { useProjectStore } from '@/stores/project-store'
import { sideChatBlock, sideChatBlockMessage, type SideChatAction } from './side-chat-availability'
import { validateAnnotations, type Annotation } from '../../../../shared/annotations'
import { previewCloseGuards } from '@/stores/preview-close-guard'
import {
  usePreviewWorkbenchStore,
  sideChatTabId,
  type PreviewItem
} from '@/stores/preview-workbench-store'
import { SideChatCloseConfirmation } from './SideChatCloseConfirmation'
import {
  Fragment,
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

import { useTranslation } from 'react-i18next'

import { getAcpRuntimeEventText } from '../../../../shared/acp'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSettingsStore, selectFrameworkApiEndpoints } from '@/stores/settings-store'
import { buildConfiguredModelCatalog } from '../../../../shared/configured-model-catalog'
import { resolveSessionAgentConfiguration } from '../../../../shared/session-agent-configuration'
import type {
  SideChatModelSelection,
  SideChatEntry,
  SideChatSnapshot
} from '../../../../shared/side-chat'
import { useSessionStore, type ChatSession } from '@/stores/session-store'

type SideChatView = Readonly<{
  modelSelection?: SideChatModelSelection
  id?: string
  draftOnly?: boolean
  generation: number
  revision?: number
  parentSessionId: string
  projectId: string
  sideSessionId?: string
  entries: readonly SideChatEntry[]
  liveTurnUserEntryId?: string
  draft: string
  annotations?: readonly Annotation[]
  running: boolean
  error?: string
  persistenceError?: string
  notice?: SideChatSnapshot['notice']
}>

type SideChatController = Readonly<{
  views?: readonly SideChatView[]
  createDraft?: () => string | undefined
  view: SideChatView | undefined
  unavailableReason?: string
  openDisabledReason?: string
  start: (text: string) => Promise<boolean>
  send: (text: string) => Promise<boolean>
  retryHydration?: () => void
  setAnnotations?: (value: SetStateAction<readonly Annotation[]>) => void
  setModelSelection: (selection: SideChatModelSelection) => void
  setDraft: (value: SetStateAction<string>) => void
  cancel: () => void
  close: () => void
}>

type SideChatRuntimeController = Readonly<{
  persistence: SideChatPersistence
  getView: (id: string) => SideChatView | undefined
  views: ReadonlyMap<string, SideChatView>
  closingChatIds: ReadonlySet<string>
  hydrated: boolean
  hydrationError?: string
  retryHydration: () => void
  refreshTargets: () => Promise<void> | undefined
  blockReason: (
    parent: Readonly<{ sessionId: string; projectId: string }>,
    action: SideChatAction,
    chatId?: string
  ) => string | undefined
  createDraft: (parent: Readonly<{ sessionId: string; projectId: string }>) => string | undefined
  start: (
    parent: Readonly<{ sessionId: string; projectId: string }>,
    text: string,
    existingId?: string
  ) => Promise<boolean>
  send: (chatId: string, text: string) => Promise<boolean>
  setAnnotations: (chatId: string, value: SetStateAction<readonly Annotation[]>) => void
  setModelSelection: (chatId: string, selection: SideChatModelSelection) => void
  setDraft: (chatId: string, value: SetStateAction<string>) => void
  cancel: (chatId: string) => void
  close: (chatId: string) => void
}>

const SideChatContext = createContext<SideChatRuntimeController | undefined>(undefined)

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method 'side-chat:[^']+': (?:Error: )?/,
    ''
  )

const hasMainConversation = (session: ChatSession | undefined): boolean =>
  Boolean(session?.messages.some((message) => message.role === 'user' && !message.relayedFrom))

const getLastSideChatUserEntryId = (entries: readonly SideChatEntry[]): string | undefined =>
  entries.findLast((entry) => entry.kind === 'message' && entry.role === 'user')?.id

const inheritedModelSelection = (parentSessionId: string): SideChatModelSelection | undefined => {
  const settings = useSettingsStore.getState()
  const parent = useSessionStore
    .getState()
    .sessions.find((session) => session.id === parentSessionId)
  const catalog = buildConfiguredModelCatalog({
    providers: settings.providers,
    activeProviderId: settings.activeProviderId,
    claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId,
    includeAllClaudeSubscriptions: true,
    frameworkId: settings.agentFrameworkId,
    frameworkEndpoints: selectFrameworkApiEndpoints(settings)
  })
  const { configuration } = resolveSessionAgentConfiguration({
    providers: settings.providers,
    session: parent ?? {},
    catalog,
    activeProviderId: settings.activeProviderId,
    activeModel: settings.activeModel,
    activeReasoningEffort: settings.reasoningEffort
  })
  return configuration
    ? {
        providerId: configuration.providerId,
        reasoningEffort: configuration.reasoningEffort,
        ...(configuration.model ? { model: configuration.model } : {})
      }
    : undefined
}

type SideChatPersistence = Readonly<{ ready: boolean; blockedSessionIds: readonly string[] }>
const readyPersistence: SideChatPersistence = { ready: true, blockedSessionIds: [] }
const useOwnedSideChatRuntime = (persistence: SideChatPersistence): SideChatRuntimeController => {
  const { t } = useTranslation()
  const persistenceRef = useRef(persistence)
  persistenceRef.current = persistence
  const [views, setViews] = useState<ReadonlyMap<string, SideChatView>>(() => new Map())
  const [hydrated, setHydrated] = useState(() => !window.api?.sideChat?.list)
  const [hydrationError, setHydrationError] = useState<string>()
  const viewsRef = useRef<ReadonlyMap<string, SideChatView>>(views)
  const [closingChatIds, setClosingChatIds] = useState<ReadonlySet<string>>(() => new Set())
  const closingChatIdsRef = useRef<ReadonlySet<string>>(closingChatIds)
  const revisionByChatRef = useRef(new Map<string, number>())
  const closedSideSessionIdsRef = useRef(new Set<string>())
  const hydrationGenerationRef = useRef(0)
  const sequenceRef = useRef(0)

  const update = useCallback(
    (
      chatId: string,
      value:
        SideChatView | undefined | ((current: SideChatView | undefined) => SideChatView | undefined)
    ): void => {
      const current = viewsRef.current.get(chatId)
      const next = typeof value === 'function' ? value(current) : value
      if (next === current) return
      const updated = new Map(viewsRef.current)
      if (next) updated.set(chatId, next)
      else updated.delete(chatId)
      viewsRef.current = updated
      setViews(updated)
    },
    []
  )

  const viewFromSnapshot = useCallback(
    (snapshot: SideChatSnapshot, current?: SideChatView): SideChatView => ({
      id: current?.id ?? snapshot.sideSessionId ?? snapshot.parentSessionId,
      generation: current?.generation ?? ++sequenceRef.current,
      revision: snapshot.revision,
      parentSessionId: snapshot.parentSessionId,
      projectId: snapshot.projectId,
      sideSessionId: snapshot.sideSessionId,
      modelSelection: current?.modelSelection ?? snapshot.modelSelection,
      entries: snapshot.entries,
      liveTurnUserEntryId: snapshot.running
        ? getLastSideChatUserEntryId(snapshot.entries)
        : current?.liveTurnUserEntryId,
      draft: current?.draft ?? '',
      annotations: current?.annotations,
      running: snapshot.running,
      error: snapshot.error ? errorText(snapshot.error) : undefined,
      persistenceError: snapshot.persistenceError,
      notice: snapshot.notice
    }),
    []
  )

  const hydrate = useCallback(
    (retryOnce: boolean): void => {
      const list = window.api?.sideChat?.list
      if (!list) {
        setHydrationError(undefined)
        setHydrated(true)
        return
      }

      const generation = ++hydrationGenerationRef.current
      setHydrationError(undefined)
      setHydrated(false)
      const read = (): ReturnType<typeof list> => Promise.resolve().then(() => list())
      const restoredList = retryOnce ? read().catch(() => read()) : read()
      void restoredList.then(
        (snapshotList) => {
          if (hydrationGenerationRef.current !== generation) return
          const next = new Map(viewsRef.current)
          const liveChatIds = new Set(
            snapshotList.chats.map((chat) => chat.sideSessionId ?? chat.parentSessionId)
          )
          for (const [parentSessionId, view] of next) {
            if (
              !view.draftOnly &&
              !liveChatIds.has(parentSessionId) &&
              (view.revision ?? 0) <= snapshotList.revision
            ) {
              next.delete(parentSessionId)
            }
          }
          for (const snapshot of snapshotList.chats) {
            const lastRevision =
              revisionByChatRef.current.get(snapshot.sideSessionId ?? snapshot.parentSessionId) ?? 0
            if (snapshot.revision < lastRevision) continue
            revisionByChatRef.current.set(
              snapshot.sideSessionId ?? snapshot.parentSessionId,
              snapshot.revision
            )
            next.set(
              snapshot.sideSessionId ?? snapshot.parentSessionId,
              viewFromSnapshot(
                snapshot,
                next.get(snapshot.sideSessionId ?? snapshot.parentSessionId)
              )
            )
          }
          viewsRef.current = next
          setViews(next)
          setHydrationError(undefined)
          setHydrated(true)
        },
        (error) => {
          if (hydrationGenerationRef.current !== generation) return
          setHydrationError(errorText(error))
          setHydrated(false)
        }
      )
    },
    [viewFromSnapshot]
  )

  useEffect(() => {
    const api = window.api?.sideChat
    if (!api?.onEvent) {
      setHydrated(true)
      return
    }
    const removeListener = api.onEvent((envelope) => {
      const chatId =
        [...viewsRef.current].find(
          ([, view]) => view.sideSessionId === envelope.sideSessionId
        )?.[0] ?? envelope.sideSessionId
      if (closedSideSessionIdsRef.current.has(envelope.sideSessionId)) return
      const lastRevision = revisionByChatRef.current.get(chatId) ?? 0
      const revision = envelope.revision ?? lastRevision + 1
      if (revision < lastRevision) return
      revisionByChatRef.current.set(chatId, revision)

      const event = envelope.event
      if (closingChatIdsRef.current.has(chatId)) return
      if (event.kind === 'closed') {
        if (event.reason === 'closed') {
          closedSideSessionIdsRef.current.add(envelope.sideSessionId)
          update(chatId, undefined)
        } else {
          update(chatId, (current) =>
            current
              ? {
                  ...current,
                  revision,
                  running: false,
                  error: undefined,
                  notice: 'connection-ended'
                }
              : current
          )
        }
        return
      }
      if (event.kind === 'persistence') {
        update(chatId, (current) =>
          current?.sideSessionId === envelope.sideSessionId
            ? { ...current, revision, persistenceError: event.error }
            : current
        )
        return
      }
      update(chatId, (current) => {
        if (current?.sideSessionId && envelope.sideSessionId !== current.sideSessionId) {
          return current
        }
        let next: SideChatView = current
          ? { ...current, revision, sideSessionId: current.sideSessionId ?? envelope.sideSessionId }
          : {
              id: chatId,
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
    hydrate(true)
    return () => {
      hydrationGenerationRef.current += 1
      removeListener()
    }
  }, [hydrate, update, viewFromSnapshot])

  // Reconcile destinations with runtime authority whenever a move picker opens.
  // Keep local drafts and stable tab IDs; never revive a chat closed during the read.
  const refreshTargets = useCallback((): Promise<void> | undefined => {
    const list = window.api?.sideChat?.list
    if (!list) return undefined
    return list().then(({ chats }) => {
      for (const snapshot of chats) {
        if (!snapshot.sideSessionId || closedSideSessionIdsRef.current.has(snapshot.sideSessionId))
          continue
        const existing = [...viewsRef.current].find(
          ([, view]) => view.sideSessionId === snapshot.sideSessionId
        )
        const id = existing?.[0] ?? snapshot.sideSessionId
        if (
          closingChatIdsRef.current.has(id) ||
          snapshot.revision < (revisionByChatRef.current.get(id) ?? 0)
        )
          continue
        revisionByChatRef.current.set(id, snapshot.revision)
        update(id, (current) => viewFromSnapshot(snapshot, current))
      }
    })
  }, [update, viewFromSnapshot])

  const setModelSelection = useCallback(
    (chatId: string, selection: SideChatModelSelection): void => {
      update(chatId, (current) => (current ? { ...current, modelSelection: selection } : current))
    },
    [update]
  )

  const retryHydration = useCallback((): void => hydrate(false), [hydrate])

  const blockReason = useCallback(
    (
      parent: { sessionId: string; projectId: string },
      action: SideChatAction,
      chatId?: string
    ): string | undefined => {
      const session = useSessionStore
        .getState()
        .sessions.find((item) => item.id === parent.sessionId)
      const project = useProjectStore
        .getState()
        .projects.find((item) => item.id === parent.projectId)
      const view = chatId ? viewsRef.current.get(chatId) : undefined
      return sideChatBlockMessage(
        sideChatBlock({
          action,
          parent: session,
          projectId: parent.projectId,
          projectArchived:
            project?.archivedAt !== undefined || (useProjectStore.getState().isLoaded && !project),
          persistenceReady:
            persistenceRef.current.ready &&
            !persistenceRef.current.blockedSessionIds.includes(parent.sessionId),
          hydrated,
          hydrationError,
          closing: chatId ? closingChatIdsRef.current.has(chatId) : false,
          running: view?.running
        }),
        t,
        hydrationError
      )
    },
    [hydrated, hydrationError, t]
  )

  const createDraft = useCallback(
    (parent: Readonly<{ sessionId: string; projectId: string }>): string | undefined => {
      if (blockReason(parent, 'open')) return undefined
      const id = `side-chat-${crypto.randomUUID()}`
      update(id, {
        id,
        sideSessionId: id,
        generation: ++sequenceRef.current,
        parentSessionId: parent.sessionId,
        projectId: parent.projectId,
        entries: [],
        draft: '',
        running: false,
        draftOnly: true,
        modelSelection: inheritedModelSelection(parent.sessionId)
      })
      usePreviewWorkbenchStore.getState().upsertAndActivateItem({
        id: sideChatTabId(id),
        sideChatId: id,
        type: 'tool',
        toolKind: 'side-chat',
        sessionId: parent.sessionId,
        projectId: parent.projectId,
        title: 'Side chat'
      })
      return id
    },
    [blockReason, update]
  )

  const start = useCallback(
    async (
      parent: Readonly<{ sessionId: string; projectId: string }>,
      rawText: string,
      existingId?: string
    ): Promise<boolean> => {
      const text = rawText.trim()
      if (!text || !window.api?.sideChat) return false
      const blocked = blockReason(parent, 'send', existingId)
      if (blocked) {
        if (existingId) update(existingId, (view) => (view ? { ...view, error: blocked } : view))
        throw new Error(blocked)
      }
      const id = existingId ?? createDraft(parent)
      if (!id) return false
      const current = viewsRef.current.get(id)
      if (!current?.draftOnly || current.running) return false
      const userEntryId = `side-user-${++sequenceRef.current}`
      update(id, {
        ...current,
        entries: [{ id: userEntryId, kind: 'message', role: 'user', text }],
        liveTurnUserEntryId: userEntryId,
        running: true,
        draftOnly: false
      })
      try {
        const started = await window.api.sideChat.start({
          sideSessionId: id,
          parentSessionId: parent.sessionId,
          projectId: parent.projectId,
          expectedParentBranch: sideChatParentBranch(
            useSessionStore.getState().sessions.find((session) => session.id === parent.sessionId)
              ?.conversationGraph
          ),
          ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
          text
        })
        const latest = viewsRef.current.get(id)
        if (!latest) {
          closedSideSessionIdsRef.current.add(started.sideSessionId)
          await window.api.sideChat.close({ sideSessionId: started.sideSessionId })
          return false
        }
        update(id, { ...latest, sideSessionId: started.sideSessionId })
        return true
      } catch (error) {
        if (viewsRef.current.has(id)) {
          if (existingId)
            update(id, (latest) => ({
              ...current,
              modelSelection: latest?.modelSelection ?? current.modelSelection,
              running: false,
              error: errorText(error)
            }))
          else update(id, undefined)
          throw error
        }
        return false
      }
    },
    [blockReason, createDraft, update]
  )

  const send = useCallback(
    async (chatId: string, rawText: string): Promise<boolean> => {
      const text = rawText.trim()
      const current = viewsRef.current.get(chatId)
      if (!current?.sideSessionId || !text) return false
      const blocked = blockReason(
        { sessionId: current.parentSessionId, projectId: current.projectId },
        'send',
        chatId
      )
      if (blocked) {
        update(chatId, (view) => (view ? { ...view, error: blocked } : view))
        return false
      }
      if (current.draftOnly) {
        try {
          return await start(
            { sessionId: current.parentSessionId, projectId: current.projectId },
            text,
            chatId
          )
        } catch {
          return false
        }
      }
      sequenceRef.current += 1
      const userEntryId = `side-user-${current.generation}-${sequenceRef.current}`
      const next = {
        ...current,
        entries: [
          ...current.entries,
          {
            id: userEntryId,
            kind: 'message' as const,
            role: 'user' as const,
            text
          }
        ],
        liveTurnUserEntryId: userEntryId,
        running: true,
        notice: undefined,
        error: undefined
      }
      update(chatId, next)
      try {
        await window.api.sideChat.send({
          sideSessionId: current.sideSessionId,
          expectedParentBranch: sideChatParentBranch(
            useSessionStore
              .getState()
              .sessions.find((session) => session.id === current.parentSessionId)?.conversationGraph
          ),
          ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
          text
        })
        return true
      } catch (error) {
        // A rejected IPC call may have lost the response after admission. Reconcile first;
        // never infer delivery from identical text or delete provider-owned transcript entries.
        const failedTurnId = viewsRef.current.get(chatId)?.liveTurnUserEntryId
        let snapshots: Awaited<ReturnType<Window['api']['sideChat']['list']>> | undefined
        try {
          snapshots = await window.api.sideChat.list?.()
        } catch {
          // Keep the visible transcript if its authority cannot be read.
        }
        let admitted = false
        update(chatId, (latest) => {
          if (latest?.generation !== current.generation) return latest
          if (latest.liveTurnUserEntryId !== failedTurnId) {
            admitted = latest.running
            return latest
          }
          const snapshot = snapshots?.chats.find(
            (chat) => chat.sideSessionId === current.sideSessionId
          )
          const lastRevision = revisionByChatRef.current.get(chatId) ?? 0
          if (snapshot && snapshot.revision >= lastRevision) {
            revisionByChatRef.current.set(chatId, snapshot.revision)
            admitted = snapshot.running
            const restored = viewFromSnapshot(snapshot, latest)
            return { ...restored, error: admitted ? restored.error : errorText(error) }
          }
          if (snapshot || (latest.liveTurnUserEntryId !== userEntryId && latest.running)) {
            admitted = latest.running
            return latest
          }
          return { ...latest, running: false, error: errorText(error) }
        })
        return admitted
      }
    },
    [blockReason, start, update, viewFromSnapshot]
  )

  const cancel = useCallback(
    (chatId: string): void => {
      const current = viewsRef.current.get(chatId)
      if (!current?.sideSessionId || !current.running) return
      void window.api.sideChat.cancel({ sideSessionId: current.sideSessionId }).catch((error) => {
        update(chatId, (latest) =>
          latest?.generation === current.generation
            ? { ...latest, error: errorText(error) }
            : latest
        )
      })
    },
    [update]
  )

  const setAnnotations = useCallback(
    (chatId: string, value: SetStateAction<readonly Annotation[]>): void => {
      update(chatId, (current) =>
        current
          ? {
              ...current,
              annotations: typeof value === 'function' ? value(current.annotations ?? []) : value
            }
          : current
      )
    },
    [update]
  )

  const setDraft = useCallback(
    (chatId: string, value: SetStateAction<string>): void => {
      update(chatId, (current) => {
        if (!current) return current
        const draft = typeof value === 'function' ? value(current.draft) : value
        return { ...current, draft }
      })
    },
    [update]
  )

  const close = useCallback(
    (chatId: string): void => {
      const current = viewsRef.current.get(chatId)
      if (!current) return
      if (current.sideSessionId) closedSideSessionIdsRef.current.add(current.sideSessionId)
      const closing = new Set(closingChatIdsRef.current).add(chatId)
      closingChatIdsRef.current = closing
      setClosingChatIds(closing)
      update(chatId, undefined)
      if (current.draftOnly) {
        const next = new Set(closingChatIdsRef.current)
        next.delete(chatId)
        closingChatIdsRef.current = next
        setClosingChatIds(next)
        return
      }
      const request = current.sideSessionId
        ? { sideSessionId: current.sideSessionId }
        : { parentSessionId: current.parentSessionId }
      void window.api.sideChat
        .close(request)
        .catch((error) => {
          if (current.sideSessionId) closedSideSessionIdsRef.current.delete(current.sideSessionId)
          update(
            chatId,
            (latest) =>
              latest ?? {
                ...current,
                running: false,
                error: t('Could not close Side chat: {{error}}', { error: errorText(error) })
              }
          )
        })
        .finally(() => {
          const next = new Set(closingChatIdsRef.current)
          next.delete(chatId)
          closingChatIdsRef.current = next
          setClosingChatIds(next)
        })
    },
    [t, update]
  )

  useEffect(() => {
    const discardEmpty = (matches: (view: SideChatView) => boolean): void => {
      for (const [id, view] of viewsRef.current) {
        if (
          view.draftOnly &&
          !view.running &&
          !view.draft.trim() &&
          !view.annotations?.length &&
          view.entries.length === 0 &&
          matches(view)
        )
          close(id)
      }
    }
    const removeNavigation = useNavigationStore.subscribe((state, previous) => {
      if (state.view !== previous.view || state.activeProjectId !== previous.activeProjectId) {
        discardEmpty((view) => view.projectId === previous.activeProjectId)
      }
    })
    const removeSession = useSessionStore.subscribe((state, previous) => {
      if (state.selectedSessionId !== previous.selectedSessionId) {
        discardEmpty((view) => view.parentSessionId === previous.selectedSessionId)
      }
    })
    const removePreview = usePreviewWorkbenchStore.subscribe((state, previous) => {
      if (
        state.activeItemId !== previous.activeItemId ||
        state.activeProjectId !== previous.activeProjectId
      ) {
        discardEmpty((view) => sideChatTabId(view.id!) === previous.activeItemId)
      }
    })
    return () => {
      removeNavigation()
      removeSession()
      removePreview()
    }
  }, [close])

  return useMemo<SideChatRuntimeController>(
    () => ({
      persistence,
      getView: (id) => viewsRef.current.get(id),
      views,
      closingChatIds,
      hydrated,
      hydrationError,
      retryHydration,
      blockReason,
      refreshTargets,
      createDraft,
      start,
      send,
      setDraft,
      setModelSelection,
      setAnnotations,
      cancel,
      close
    }),
    [
      cancel,
      close,
      closingChatIds,
      hydrated,
      hydrationError,
      retryHydration,
      blockReason,
      persistence,
      refreshTargets,
      createDraft,
      send,
      setDraft,
      setModelSelection,
      setAnnotations,
      start,
      views
    ]
  )
}

const SideChatProvider = ({
  children,
  persistence = readyPersistence
}: PropsWithChildren<{ persistence?: SideChatPersistence }>): ReactElement => {
  const runtime = useOwnedSideChatRuntime(persistence)
  const { views, hydrated, close } = runtime
  const activeProjectId = usePreviewWorkbenchStore((state) => state.activeProjectId)
  // Existing durable Side chat records are the authority for open tabs, including after restart.
  // Preview persistence preserves these runtime-owned tabs during subsequent snapshot refreshes.
  useEffect(() => {
    if (!hydrated) return
    const store = usePreviewWorkbenchStore.getState()
    for (const view of views.values()) {
      if (
        view.projectId === activeProjectId &&
        !store.items.some((item) => item.id === sideChatTabId(view.id!))
      ) {
        // Restoring only the tab data leaves a Side-chat-only workspace collapsed.
        // Reveal the first restored chat; preserve an already visible preview selection.
        const current = usePreviewWorkbenchStore.getState()
        const restore =
          current.panelState === 'collapsed' ? current.upsertAndActivateItem : current.upsertItem
        restore({
          id: sideChatTabId(view.id!),
          type: 'tool',
          toolKind: 'side-chat',
          sideChatId: view.id,
          projectId: view.projectId,
          sessionId: view.parentSessionId,
          title: 'Side chat'
        })
      }
    }
    for (const item of store.items) {
      if (
        item.type === 'tool' &&
        item.toolKind === 'side-chat' &&
        !views.has(item.sideChatId ?? item.sessionId)
      ) {
        previewCloseGuards.runApproved([item.id], () => store.removeItem(item.id))
      }
    }
  }, [activeProjectId, views, hydrated])
  useEffect(
    () =>
      usePreviewWorkbenchStore.subscribe((state, previous) => {
        const allItems = (value: typeof state): PreviewItem[] => [
          ...value.items,
          ...Object.entries(value.byProject)
            .filter(([projectId]) => projectId !== value.activeProjectId)
            .flatMap(([, slice]) => slice.items)
        ]
        const remaining = new Set(allItems(state).map((item) => item.id))
        for (const item of allItems(previous)) {
          if (item.type === 'tool' && item.toolKind === 'side-chat' && !remaining.has(item.id))
            close(item.sideChatId ?? item.sessionId)
        }
      }),
    [close]
  )
  return createElement(
    SideChatContext.Provider,
    { value: runtime },
    createElement(Fragment, { key: 'provider-children' }, children),
    createElement(
      Fragment,
      { key: 'close-confirmations' },
      ...[...views.keys()].map((sessionId) =>
        createElement(SideChatCloseConfirmation, { key: sessionId, sessionId })
      )
    )
  )
}

const useSideChatController = (
  parent: Readonly<{ sessionId: string; projectId: string }> | undefined,
  sideChatId?: string
): SideChatController => {
  const { t } = useTranslation()
  const runtime = useContext(SideChatContext)
  useSessionStore((state) => state.sessions)
  useProjectStore((state) => state.projects)
  const views = parent
    ? [...(runtime?.views.values() ?? [])].filter(
        (view) => view.parentSessionId === parent.sessionId && view.projectId === parent.projectId
      )
    : []
  const candidate = sideChatId ? runtime?.views.get(sideChatId) : views.at(-1)
  const selectedId = candidate?.id ?? sideChatId
  const owned =
    candidate?.projectId === parent?.projectId && candidate?.parentSessionId === parent?.sessionId
      ? candidate
      : undefined
  const view = owned
    ? {
        ...owned,
        error:
          owned.notice === 'interrupted'
            ? t('Side chat was interrupted when the app closed. Send a Follow up to continue.')
            : owned.notice === 'connection-ended'
              ? t('Side chat connection ended. Send a Follow up to reconnect.')
              : owned.error === 'Side chat prompt cancelled.'
                ? t('Side chat prompt cancelled.')
                : owned.error
      }
    : undefined
  const openDisabledReason = parent ? runtime?.blockReason(parent, 'open') : undefined
  const unavailableReason = parent ? runtime?.blockReason(parent, 'send', sideChatId) : undefined

  return {
    views,
    createDraft: () => (runtime && parent ? runtime.createDraft(parent) : undefined),
    view,
    unavailableReason,
    openDisabledReason,
    start: (text) => (runtime && parent ? runtime.start(parent, text) : Promise.resolve(false)),
    send: (text) =>
      runtime && selectedId ? runtime.send(selectedId, text) : Promise.resolve(false),
    retryHydration: runtime?.hydrationError ? runtime.retryHydration : undefined,
    setAnnotations: (value) => {
      if (runtime && selectedId) runtime.setAnnotations(selectedId, value)
    },
    setModelSelection: (selection) => {
      if (runtime && selectedId) runtime.setModelSelection(selectedId, selection)
    },
    setDraft: (text) => {
      if (runtime && selectedId) runtime.setDraft(selectedId, text)
    },
    cancel: () => {
      if (runtime && selectedId) runtime.cancel(selectedId)
    },
    close: () => {
      if (runtime && selectedId) runtime.close(selectedId)
    }
  }
}

type SideChatTransfers = {
  views: readonly SideChatView[]
  unavailableReason: (
    parent: { sessionId: string; projectId: string },
    chatId?: string
  ) => string | undefined
  refresh: () => Promise<void> | undefined
  create: (parent: { sessionId: string; projectId: string }) => string | undefined
  receive: (
    id: string,
    transfer: { parentSessionId: string; projectId: string; annotation: Annotation }
  ) => boolean
  open: (id: string) => void
}
const useSideChatTransfers = (): SideChatTransfers => {
  const runtime = useContext(SideChatContext)
  useSessionStore((state) => state.sessions)
  useProjectStore((state) => state.projects)
  return {
    views: [...(runtime?.views.values() ?? [])],
    unavailableReason: (parent, chatId) =>
      runtime?.blockReason(parent, chatId ? 'transfer' : 'open', chatId),
    refresh: () => runtime?.refreshTargets(),
    create: (parent: { sessionId: string; projectId: string }): string | undefined =>
      runtime?.createDraft(parent),
    receive: (
      id: string,
      transfer: { parentSessionId: string; projectId: string; annotation: Annotation }
    ): boolean => {
      const view = runtime?.getView(id)
      if (
        !runtime ||
        !view ||
        runtime.closingChatIds.has(id) ||
        view.parentSessionId !== transfer.parentSessionId ||
        view.projectId !== transfer.projectId
      )
        return false
      const annotations = view.annotations ?? []
      if (annotations.some((item) => item.id === transfer.annotation.id)) return true
      const next = [...annotations, transfer.annotation]
      if (
        runtime.blockReason(
          { sessionId: view.parentSessionId, projectId: view.projectId },
          'transfer',
          id
        ) ||
        validateAnnotations(next, view.draft)
      )
        return false
      runtime.setAnnotations(id, next)
      return true
    },
    open: (id: string): void => {
      const view = runtime?.getView(id)
      if (!view) return
      usePreviewWorkbenchStore.getState().upsertAndActivateItem({
        id: sideChatTabId(id),
        sideChatId: id,
        type: 'tool',
        toolKind: 'side-chat',
        sessionId: view.parentSessionId,
        projectId: view.projectId,
        title: 'Side chat'
      })
    }
  }
}

const useOpenSideChatParentSessionIds = (): ReadonlySet<string> => {
  const runtime = useContext(SideChatContext)
  return useMemo(
    () => new Set([...(runtime?.views.values() ?? [])].map((view) => view.parentSessionId)),
    [runtime?.views]
  )
}

const useIsSideChatOpenForSession = (sessionId: string): boolean =>
  [...(useContext(SideChatContext)?.views.values() ?? [])].some(
    (view) => view.parentSessionId === sessionId
  )

export {
  hasMainConversation,
  SideChatProvider,
  useIsSideChatOpenForSession,
  useOpenSideChatParentSessionIds,
  useSideChatController,
  useSideChatTransfers
}
export type { SideChatController, SideChatEntry, SideChatView }
