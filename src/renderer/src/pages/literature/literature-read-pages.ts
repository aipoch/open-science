import { useMemo } from 'react'
import { useLiteratureHost } from './renderer-host'
import { createLiteratureQueries } from './queries'
export { createLiteratureQueries } from './queries'

export function useLiteratureClient(): ReturnType<typeof createLiteratureQueries> {
  const host = useLiteratureHost()
  return useMemo(() => createLiteratureQueries(() => host.api), [host])
}
