import type { CodeHighlighterPlugin, HighlightResult, ThemeInput } from '@streamdown/code'

// Same themes the app passes to Streamdown (AgentMarkdown.tsx) so a mermaid source view is
// highlighted identically to a fenced code block.
const HIGHLIGHT_THEMES: [ThemeInput, ThemeInput] = ['github-light', 'github-light']
const MAX_CACHED_HIGHLIGHTS = 50

let loadingPlugin: Promise<CodeHighlighterPlugin | undefined> | undefined

const loadCodeHighlighter = (): Promise<CodeHighlighterPlugin | undefined> => {
  loadingPlugin ??= import('./code-highlighter-runtime').then(
    ({ code }) => code,
    (error: unknown) => {
      loadingPlugin = undefined
      console.error('Failed to load mermaid source highlighting.', error)
      return undefined
    }
  )
  return loadingPlugin
}

const htmlBySource = new Map<string, string>()

const rememberHighlight = (source: string, html: string): string => {
  htmlBySource.delete(source)
  htmlBySource.set(source, html)
  while (htmlBySource.size > MAX_CACHED_HIGHLIGHTS) {
    const oldest = htmlBySource.keys().next().value
    if (oldest === undefined) break
    htmlBySource.delete(oldest)
  }
  return html
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Shiki dual-theme tokens carry the light color on `color`; the app registers github-light for
// both slots, so one color covers both modes — identical to how fenced code blocks render.
const tokensToHtml = (result: HighlightResult): string =>
  result.tokens
    .map((line) =>
      line
        .map((token) => {
          const styles = [
            token.color ? `color:${token.color}` : '',
            token.fontStyle && token.fontStyle & 1 ? 'font-style:italic' : '',
            token.fontStyle && token.fontStyle & 2 ? 'font-weight:600' : ''
          ].filter(Boolean)
          const style = styles.length > 0 ? ` style="${styles.join(';')}"` : ''
          return `<span${style}>${escapeHtml(token.content)}</span>`
        })
        .join('')
    )
    .join('\n')

// Highlights mermaid source with the app's shared Shiki plugin (the same lazy chunk fenced code
// blocks use) and delivers token HTML to `apply`. Sources render as plain text first; `apply`
// fires only when highlighting actually succeeds, so an unsupported grammar or a failed chunk
// load simply leaves the plain text in place.
const highlightMermaidSource = (source: string, apply: (html: string) => void): void => {
  const cached = htmlBySource.get(source)
  if (cached !== undefined) {
    apply(cached)
    return
  }

  void loadCodeHighlighter().then((plugin) => {
    if (!plugin || !plugin.supportsLanguage('mermaid')) return
    const deliver = (result: HighlightResult): void => {
      apply(htmlBySource.get(source) ?? rememberHighlight(source, tokensToHtml(result)))
    }
    const immediate = plugin.highlight(
      { code: source, language: 'mermaid', themes: HIGHLIGHT_THEMES },
      deliver
    )
    if (immediate) deliver(immediate)
  })
}

export { highlightMermaidSource, tokensToHtml }
