import { useEffect, useState } from 'react'
import type { CodeHighlighterPlugin } from '@streamdown/code'

let loadedPlugin: CodeHighlighterPlugin | undefined
let loadingPlugin: Promise<CodeHighlighterPlugin | undefined> | undefined

const loadCodeHighlighter = (): Promise<CodeHighlighterPlugin | undefined> => {
  if (loadedPlugin) return Promise.resolve(loadedPlugin)

  loadingPlugin ??= import('./code-highlighter-runtime').then(
    ({ code }) => (loadedPlugin = code),
    (error: unknown) => {
      loadingPlugin = undefined
      console.error('Failed to load Markdown code highlighting.', error)
      return undefined
    }
  )
  return loadingPlugin
}

const useCodeHighlighter = (enabled: boolean): CodeHighlighterPlugin | undefined => {
  const [plugin, setPlugin] = useState(loadedPlugin)

  useEffect(() => {
    if (!enabled || plugin) return

    let active = true
    void loadCodeHighlighter().then((loaded) => {
      if (active && loaded) setPlugin(loaded)
    })
    return () => {
      active = false
    }
  }, [enabled, plugin])

  return plugin
}

export { useCodeHighlighter }
