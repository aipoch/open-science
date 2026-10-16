import { useState, type PropsWithChildren } from 'react'
import { LiteratureHostContext, type LiteratureRendererHost } from './renderer-host'

// One stable host per mounted feature tree. Replace it by unmounting the old tree first.
export function LiteratureRendererProvider({
  host,
  children
}: PropsWithChildren<{ host: LiteratureRendererHost }>): React.JSX.Element {
  const [binding] = useState(() => ({
    original: host,
    instance: Object.create(host) as LiteratureRendererHost
  }))
  if (binding.original !== host)
    throw new Error('Remount LiteratureRendererProvider to replace its host.')
  const instance = binding.instance
  return (
    <LiteratureHostContext.Provider value={instance}>{children}</LiteratureHostContext.Provider>
  )
}
