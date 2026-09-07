import { useEffect, useMemo, useRef, useState } from 'react'

type HistoryPage<Version> = { versions: Version[]; nextCursor?: string }

// Pages survive selection changes within one file/head, but never cross an identity or head change.
export const useVersionHistoryPages = <Version extends { id: string; versionNumber: number }>({
  historyKey,
  initial,
  loadPage
}: {
  historyKey: string
  initial?: HistoryPage<Version>
  loadPage: (cursor: string) => Promise<HistoryPage<Version>>
}): {
  versions: Version[]
  nextCursor?: string
  loading: boolean
  error?: string
  loadEarlier: () => void
} => {
  const [state, setState] = useState<{
    key: string
    pages: HistoryPage<Version>[]
    loading: boolean
    error?: string
  }>()
  const request = useRef<object | undefined>(undefined)
  useEffect(() => {
    request.current = undefined
    return () => {
      request.current = undefined
    }
  }, [historyKey])
  const current = state?.key === historyKey ? state : undefined
  const pages = current?.pages ?? []
  const nextCursor = pages.length ? pages.at(-1)!.nextCursor : initial?.nextCursor
  const versions = useMemo(
    () =>
      [
        ...new Map(
          [
            ...(current?.pages ?? []).flatMap((page) => page.versions),
            ...(initial?.versions ?? [])
          ].map((version) => [version.id, version])
        ).values()
      ].sort((left, right) => left.versionNumber - right.versionNumber),
    [current?.pages, initial?.versions]
  )
  return {
    versions,
    nextCursor,
    loading: current?.loading ?? false,
    error: current?.error,
    loadEarlier: () => {
      if (!nextCursor || request.current) return
      const token = {}
      request.current = token
      setState({ key: historyKey, pages, loading: true })
      void loadPage(nextCursor)
        .then((page) => {
          if (request.current !== token) return
          setState({ key: historyKey, pages: [...pages, page], loading: false })
        })
        .catch((error: unknown) => {
          if (request.current !== token) return
          setState({
            key: historyKey,
            pages,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          })
        })
        .finally(() => {
          if (request.current === token) request.current = undefined
        })
    }
  }
}
