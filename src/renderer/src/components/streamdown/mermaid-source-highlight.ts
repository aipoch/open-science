import type { CodeHighlighterPlugin, HighlightResult, ThemeInput } from '@streamdown/code'

// Same themes the app passes to Streamdown (AgentMarkdown.tsx) so a mermaid source view is
// highlighted identically to a fenced code block.
const HIGHLIGHT_THEMES: [ThemeInput, ThemeInput] = ['github-light', 'github-light']
const MAX_CACHED_HIGHLIGHTS = 50

type SourceHighlight = {
  html: string
  bg?: string
  fg?: string
}

// Same class streamdown puts on every line span of a line-numbered code block. The gutter
// styling (including the app's compact-gutter override) keys off the 'counter(line)' class
// attribute, so reusing the exact class makes the source view indistinguishable.
const LINE_CLASS =
  'block before:content-[counter(line)] before:inline-block before:[counter-increment:line] before:w-6 before:mr-4 before:text-[13px] before:text-right before:text-muted-foreground/50 before:font-mono before:select-none'

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

const highlightBySource = new Map<string, SourceHighlight>()

const rememberHighlight = (source: string, highlight: SourceHighlight): SourceHighlight => {
  highlightBySource.delete(source)
  highlightBySource.set(source, highlight)
  while (highlightBySource.size > MAX_CACHED_HIGHLIGHTS) {
    const oldest = highlightBySource.keys().next().value
    if (oldest === undefined) break
    highlightBySource.delete(oldest)
  }
  return highlight
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Mirrors streamdown's highlighted body renderer exactly: one block line span per source line,
// token spans colored through the --sdm-c custom property (fontStyle intentionally unused —
// streamdown's renderer only maps colors). Line spans are display:block, so no newline joins.
const tokensToHtml = (result: HighlightResult): string =>
  result.tokens
    .map((line) => {
      const tokens = line
        .map((token) => {
          const style = token.color ? ` style="--sdm-c:${token.color}"` : ''
          return `<span class="text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]"${style}>${escapeHtml(token.content)}</span>`
        })
        .join('')
      return `<span class="${LINE_CLASS}">${tokens}</span>`
    })
    .join('')

// Highlights mermaid source with the app's shared Shiki plugin (the same lazy chunk fenced code
// blocks use) and delivers line-numbered token HTML to `apply`. Sources render as plain text
// first; `apply` fires only when highlighting actually succeeds, so an unsupported grammar or a
// failed chunk load simply leaves the plain text in place.
const highlightMermaidSource = (
  source: string,
  apply: (highlight: SourceHighlight) => void
): void => {
  const cached = highlightBySource.get(source)
  if (cached !== undefined) {
    apply(cached)
    return
  }

  void loadCodeHighlighter().then((plugin) => {
    if (!plugin || !plugin.supportsLanguage('mermaid')) return
    const deliver = (result: HighlightResult): void => {
      apply(
        highlightBySource.get(source) ??
          rememberHighlight(source, { html: tokensToHtml(result), bg: result.bg, fg: result.fg })
      )
    }
    const immediate = plugin.highlight(
      { code: source, language: 'mermaid', themes: HIGHLIGHT_THEMES },
      deliver
    )
    if (immediate) deliver(immediate)
  })
}

export { highlightMermaidSource, LINE_CLASS, tokensToHtml }
export type { SourceHighlight }
