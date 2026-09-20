// Streamdown never puts the mermaid fence's source text into the DOM — it lives only in React
// props. The view toggle needs it at the DOM layer, so the mermaid plugin wrapper in
// mermaid-runtime.ts records every rendered chart here, keyed by the render id that is also
// stamped onto the SVG as MERMAID_RENDER_ID_ATTRIBUTE.

const MAX_REMEMBERED_SOURCES = 100

const MERMAID_RENDER_ID_ATTRIBUTE = 'data-mermaid-render-id'

const sourcesByRenderId = new Map<string, string>()

const rememberMermaidSource = (renderId: string, source: string): void => {
  sourcesByRenderId.delete(renderId)
  sourcesByRenderId.set(renderId, source)
  while (sourcesByRenderId.size > MAX_REMEMBERED_SOURCES) {
    const oldest = sourcesByRenderId.keys().next().value
    if (oldest === undefined) break
    sourcesByRenderId.delete(oldest)
  }
}

const getMermaidSource = (renderId: string): string | undefined => sourcesByRenderId.get(renderId)

export { MERMAID_RENDER_ID_ATTRIBUTE, getMermaidSource, rememberMermaidSource }
