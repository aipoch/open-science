import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useTranslation } from 'react-i18next'
import type { ResearchDraft } from '../../../../shared/research-draft'
import type { ResearchWorkspaceRequest } from '../../../../shared/research-workspace'
import type { ComposerDraft } from './workspace-composer-upload-controller'
import { observeComposerDrafts } from './composer-draft-storage'
import { payloadToDraft, researchDraftPersistence } from './research-draft-persistence'
export type ResearchDraftRecoveryProps = {
  drafts: ResearchDraft[]
  saving: boolean
  error?: string
  onRestore: (draft: ResearchDraft) => Promise<void>
  onDiscard: (draft: ResearchDraft) => Promise<void>
  onRefresh: () => void
}
export const useResearchDraftRecovery = (options: {
  scope?: ResearchWorkspaceRequest
  draftKey: string
  version: () => number
  apply: (draft: ComposerDraft, expectedVersion: number) => boolean
}): ResearchDraftRecoveryProps | undefined => {
  const { t } = useTranslation()
  const [manager] = useState(researchDraftPersistence)
  const managerVersion = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot
  )
  const key = options.scope
    ? JSON.stringify([options.scope.projectId, options.scope.sourceSessionId])
    : undefined
  const [recovered, setRecovered] = useState<{ key: string; drafts: ResearchDraft[] }>()
  const [error, setError] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const current = useRef(options)
  useLayoutEffect(() => {
    current.current = options
    if (options.scope) manager.bind(options.scope, options.draftKey)
  })
  useLayoutEffect(
    () =>
      observeComposerDrafts((projectId, draftKey, draft) => {
        manager.write(projectId, draftKey, draft)
      }),
    [manager]
  )
  useEffect(() => {
    if (!key) return
    let cancelled = false
    const scope = current.current.scope!
    void manager
      .list(scope)
      .then((drafts) => {
        if (!cancelled) setRecovered({ key, drafts })
      })
      .catch(() => {
        if (!cancelled)
          setError(t('Draft storage is unavailable. Copy your draft before leaving this page.'))
      })
    return () => {
      cancelled = true
    }
  }, [key, manager, refresh, t])
  const restore = useCallback(
    async (draft: ResearchDraft): Promise<void> => {
      const before = current.current
      const version = before.version()
      try {
        const claimed = await manager.claim(draft)
        const now = current.current
        if (
          now.draftKey !== before.draftKey ||
          now.scope?.projectId !== draft.projectId ||
          now.scope.sourceSessionId !== draft.sourceSessionId ||
          !now.apply(
            payloadToDraft(claimed.payload, t('Choose the file again to restore this attachment.')),
            version
          )
        ) {
          setError(t('Your newer draft was kept. The saved draft is still available to restore.'))
        } else {
          manager.adopt(claimed)
          setError(undefined)
        }
        setRefresh((value) => value + 1)
      } catch {
        setError(t('Draft storage is unavailable. Copy your draft before leaving this page.'))
      }
    },
    [manager, t]
  )
  const discard = useCallback(
    async (draft: ResearchDraft): Promise<void> => {
      try {
        await manager.discard(draft)
        setRefresh((value) => value + 1)
      } catch {
        setError(t('Draft storage is unavailable. Copy your draft before leaving this page.'))
      }
    },
    [manager, t]
  )
  void managerVersion
  if (!options.scope || !window.api?.researchDrafts) return undefined
  return {
    drafts:
      recovered && recovered.key === key
        ? recovered.drafts.filter((draft) => draft.id !== manager.currentId(options.scope!))
        : [],
    saving: manager.saving,
    error:
      error ??
      (manager.error
        ? t('Draft storage is unavailable. Copy your draft before leaving this page.')
        : undefined),
    onRestore: restore,
    onDiscard: discard,
    onRefresh: () => setRefresh((value) => value + 1)
  }
}
