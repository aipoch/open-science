import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// The tool sees the main-process capability; Plate sees a separate token bound to its range.
// Neither the current cursor nor the current file path is a write target.
export function useMarkdownEditRequest(scope: string): {
  submit(
    projectId: string,
    token: string,
    markdown: string,
    send: (handle: string) => Promise<boolean>
  ): Promise<boolean>
  replacement?: { markdown: string; token: string; onDismiss(): void }
} {
  const active = useRef<{ token: string; handle?: string } | undefined>(undefined)
  const [candidate, setCandidate] = useState<{ token: string; markdown: string }>()
  const dismiss = useCallback(() => {
    const handle = active.current?.handle
    active.current = undefined
    setCandidate(undefined)
    if (handle) void window.api.markdownEdits?.close(handle).catch(() => {})
  }, [])
  useLayoutEffect(() => {
    const unsubscribe = window.api.markdownEdits?.onReplacement(({ handle, markdown }) => {
      if (active.current?.handle !== handle) return
      setCandidate({ token: active.current.token, markdown })
    })
    return () => {
      unsubscribe?.()
      dismiss()
    }
  }, [scope, dismiss])

  const submit = async (
    projectId: string,
    token: string,
    markdown: string,
    send: (handle: string) => Promise<boolean>
  ): Promise<boolean> => {
    const api = window.api.markdownEdits
    if (!api) return false
    dismiss()
    const request: { token: string; handle?: string } = { token }
    active.current = request
    try {
      const handle = await api.open(projectId, markdown)
      if (active.current !== request) {
        await api.close(handle)
        return false
      }
      request.handle = handle
      if (await send(handle)) return true
    } catch {
      // The caller owns translated error presentation.
    }
    if (active.current === request) dismiss()
    return false
  }
  return { submit, replacement: candidate && { ...candidate, onDismiss: dismiss } }
}
