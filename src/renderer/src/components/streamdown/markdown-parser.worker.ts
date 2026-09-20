import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { cjk } from '@streamdown/cjk'
import type { Root } from 'mdast'

export type MarkdownParseRequest = { id: number; source: string }
export type MarkdownParseResponse =
  { id: number; tree: Root; bytes: number } | { id: number; error: string }

// Match AgentMarkdown's syntax extensions. Transforms, sanitation and React rendering stay in
// Streamdown; importing its math renderer here would pull DOM-only KaTeX/HTML dependencies in.
const parser = unified()
  .use(remarkParse)
  .use(cjk.remarkPluginsBefore)
  .use(remarkGfm)
  .use(cjk.remarkPluginsAfter)
  .use(remarkMath, { singleDollarTextMath: true })

self.onmessage = ({ data }: MessageEvent<MarkdownParseRequest>): void => {
  let result: MarkdownParseResponse
  try {
    const tree = parser.parse(data.source)
    result = { id: data.id, tree, bytes: 2 * (data.source.length + JSON.stringify(tree).length) }
  } catch (error) {
    result = { id: data.id, error: error instanceof Error ? error.message : String(error) }
  }
  self.postMessage(result)
}
