import { createPlateEditor } from 'platejs/react'
import type { PlateEditor } from 'platejs/react'
import type { Value } from 'platejs'
import { deserializeMd, MarkdownPlugin, parseMarkdownBlocks, serializeMd } from '@platejs/markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { markdownElementPlugins } from './markdown-editor'
import { markdownListRules } from './markdown-list-rules'

export type MarkdownEditorMode = 'rich' | 'source'

export type MarkdownSourceFormat = Readonly<{
  newline: 'lf' | 'crlf'
  hasTrailingNewline: boolean
  hasUtf8Bom: boolean
}>

export type MarkdownDiagnostic = Readonly<{
  code:
    | 'unsupported-html'
    | 'unsupported-frontmatter'
    | 'unsupported-directive'
    | 'unsupported-mermaid'
    | 'conversion-failed'
  message: string
  severity: 'warning' | 'error'
}>

export type MarkdownCodecResult = Readonly<{
  value: Value
  diagnostics: readonly MarkdownDiagnostic[]
  mode: MarkdownEditorMode
}>

const remarkPlugins = [remarkGfm, remarkMath]

const unsupportedDiagnostics = (source: string): MarkdownDiagnostic[] => {
  const diagnostics: MarkdownDiagnostic[] = []
  if (/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/u.test(source)) {
    diagnostics.push({
      code: 'unsupported-frontmatter',
      message: 'Front matter is preserved in source mode.',
      severity: 'warning'
    })
  }
  if (/<[A-Za-z][^>]*>/u.test(source)) {
    diagnostics.push({
      code: 'unsupported-html',
      message: 'Raw HTML is preserved in source mode.',
      severity: 'warning'
    })
  }
  if (/^\s*```(?:mermaid|flowchart|sequenceDiagram)\b/imu.test(source)) {
    diagnostics.push({
      code: 'unsupported-mermaid',
      message: 'Mermaid blocks are preserved in source mode.',
      severity: 'warning'
    })
  }
  if (/(^|\n)\s*:::[^\n]*/u.test(source)) {
    diagnostics.push({
      code: 'unsupported-directive',
      message: 'Custom directives are preserved in source mode.',
      severity: 'warning'
    })
  }
  return diagnostics
}

const createEditor = (): PlateEditor =>
  createPlateEditor({
    plugins: [
      ...markdownElementPlugins,
      MarkdownPlugin.configure({
        options: {
          remarkPlugins,
          rules: markdownListRules,
          disallowedNodes: ['html', 'yaml']
        }
      })
    ]
  })

export const parseMarkdownDocument = (source: string): MarkdownCodecResult => {
  const diagnostics = unsupportedDiagnostics(source)
  if (diagnostics.length > 0) {
    return { value: [], diagnostics, mode: 'source' }
  }

  const editor = createEditor()
  try {
    const value = deserializeMd(editor, source, {
      remarkPlugins,
      rules: markdownListRules,
      withoutMdx: true,
      onError: (error) => {
        diagnostics.push({
          code: 'conversion-failed',
          message: error.message,
          severity: 'error'
        })
      }
    })
    return {
      value,
      diagnostics,
      mode: diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'source' : 'rich'
    }
  } catch (error) {
    return {
      value: [],
      diagnostics: [
        ...diagnostics,
        {
          code: 'conversion-failed',
          message: error instanceof Error ? error.message : String(error),
          severity: 'error'
        }
      ],
      mode: 'source'
    }
  }
}

export const serializeMarkdownDocument = (value: Value): string => {
  const editor = createEditor()
  editor.children = value
  return serializeMd(editor, {
    remarkPlugins,
    rules: markdownListRules,
    remarkStringifyOptions: {
      bullet: '-',
      fence: '`',
      fences: true,
      listItemIndent: 'one'
    }
  })
}

export const markdownBlocks = (source: string): readonly unknown[] => parseMarkdownBlocks(source)

export const markdownSelectionAnchor = (
  source: string,
  quote: string,
  prefix?: string,
  suffix?: string
): { start: number; end: number; prefix?: string; suffix?: string } | undefined => {
  if (!quote) return undefined
  const candidates: number[] = []
  let from = 0
  while (from <= source.length) {
    const index = source.indexOf(quote, from)
    if (index < 0) break
    candidates.push(index)
    from = index + Math.max(quote.length, 1)
  }
  const matching = candidates.filter((index) => {
    const before = source.slice(Math.max(0, index - (prefix?.length ?? 0)), index)
    const after = source.slice(index + quote.length, index + quote.length + (suffix?.length ?? 0))
    return (!prefix || before === prefix) && (!suffix || after === suffix)
  })
  const positions = matching.length > 0 ? matching : candidates
  if (positions.length !== 1) return undefined
  const start = positions[0]
  return {
    start,
    end: start + quote.length,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {})
  }
}

export const markdownSourceWithFormat = (source: string, format: MarkdownSourceFormat): string => {
  const withoutBom = source.replace(/^\uFEFF/u, '')
  const normalized = withoutBom.replace(/\r\n|\r/g, '\n')
  const withTrailingNewline = format.hasTrailingNewline
    ? normalized.endsWith('\n')
      ? normalized
      : `${normalized}\n`
    : normalized.replace(/\n+$/u, '')
  const withNewlines =
    format.newline === 'crlf' ? withTrailingNewline.replace(/\n/g, '\r\n') : withTrailingNewline
  return format.hasUtf8Bom ? `\uFEFF${withNewlines}` : withNewlines
}
