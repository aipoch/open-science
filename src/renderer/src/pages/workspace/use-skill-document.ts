import { useCallback, useEffect, useRef, useState } from 'react'

import { useSettingsStore } from '@/stores/settings-store'

type SkillDocumentState =
  | {
      status: 'loading' | 'failed' | 'unavailable'
    }
  | {
      status: 'ready'
      title: string
      markdown: string
    }

type UseSkillDocumentResult = SkillDocumentState & { retry: () => void }

// Resolves the renderable SKILL.md document for a canonical skill invocation name. The runtime
// materializes enabled skills, so an enabled catalog entry wins a name collision; its body comes
// from getSkillDetail. Skills outside the managed catalog (connector-provisioned mcp-* skills) are
// resolved through the main process, which knows every source the runtime can load from. 'failed'
// is a transient fetch error (Retry re-attempts); 'unavailable' means no source provides the name
// and the caller should fall back to its generic presentation.
const useSkillDocument = (skillName: string | undefined): UseSkillDocumentResult => {
  const entry = useSettingsStore((state) =>
    skillName
      ? (state.skills.find(
          (skill) => skill.available !== false && skill.name === skillName && skill.enabled
        ) ?? state.skills.find((skill) => skill.available !== false && skill.name === skillName))
      : undefined
  )
  // Keyed by catalog id (or bare name on the IPC path) so a re-imported or renamed skill cannot
  // show a stale body.
  const key = skillName ? (entry?.id ?? `name:${skillName}`) : undefined
  const [loaded, setLoaded] = useState<
    { key: string; title: string; markdown: string } | undefined
  >()
  const [failedKey, setFailedKey] = useState<string | undefined>()
  const [unavailableKey, setUnavailableKey] = useState<string | undefined>()
  const requestRef = useRef(0)
  const ready = loaded && loaded.key === key ? loaded : undefined
  const failed = key !== undefined && failedKey === key
  const unavailable = key !== undefined && unavailableKey === key

  useEffect(() => {
    if (!key || !skillName || ready || failed || unavailable) return undefined

    const requestId = ++requestRef.current
    let cancelled = false
    const settle = (action: () => void): void => {
      if (!cancelled && requestRef.current === requestId) action()
    }

    if (entry) {
      void window.api.settings.getSkillDetail(entry.id).then(
        (detail) =>
          settle(() =>
            setLoaded({
              key,
              title: detail.displayName || detail.name,
              markdown: detail.body
            })
          ),
        () => settle(() => setFailedKey(key))
      )
    } else {
      // Electron-only bridge: off-Electron hosts have no connector document sources. Deferred so
      // the classification never sets state synchronously inside the effect body.
      const resolveSkillDocument = window.api.settings.resolveSkillDocument
      if (typeof resolveSkillDocument !== 'function') {
        queueMicrotask(() => settle(() => setUnavailableKey(key)))
        return undefined
      }
      void resolveSkillDocument({ name: skillName }).then(
        (document) =>
          settle(() => {
            if (document) {
              setLoaded({
                key,
                title: document.displayName || document.name,
                markdown: document.body
              })
            } else {
              setUnavailableKey(key)
            }
          }),
        () => settle(() => setFailedKey(key))
      )
    }

    return () => {
      cancelled = true
    }
  }, [key, skillName, entry, ready, failed, unavailable])

  const retry = useCallback(() => setFailedKey(undefined), [])

  if (!key) return { status: 'unavailable', retry }
  if (ready) return { status: 'ready', title: ready.title, markdown: ready.markdown, retry }
  if (failed) return { status: 'failed', retry }
  if (unavailable) return { status: 'unavailable', retry }
  return { status: 'loading', retry }
}

export { useSkillDocument }
export type { UseSkillDocumentResult }
