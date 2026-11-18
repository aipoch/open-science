import {
  createBlockStartInputRule,
  createMarkInputRule,
  createSlatePlugin,
  defineInputRule,
  type NodeComponents,
  type SelectionInputRuleContext,
  type Value
} from 'platejs'
import { createPlateEditor, type PlateEditor } from 'platejs/react'
import { MarkdownPlugin } from '@platejs/markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { markdownListRules } from './markdown-list-rules'

const isProse = ({ editor, getBlockEntry }: SelectionInputRuleContext): boolean => {
  const type = getBlockEntry()?.[0].type
  return type !== 'code_line' && type !== 'code_block' && !editor.api.marks()?.code
}

// Match within the current text block before invoking Plate's mark transform. In particular,
// a lone closing '*' must not consume the first half of a '**bold**' delimiter.
const markRules = [
  {
    start: '***',
    marks: ['bold', 'italic'],
    pattern: /(?:^|\s)\*\*\*[^*\s](?:[^*]*[^*\s])?\*\*$/u
  },
  { start: '**', marks: ['bold'], pattern: /(?:^|\s)\*\*[^*\s](?:[^*]*[^*\s])?\*$/u },
  { start: '__', marks: ['bold'], pattern: /(?:^|\s)__[^_\s](?:[^_]*[^_\s])?_$/u },
  { start: '*', marks: ['italic'], pattern: /(?:^|\s)\*[^*\s](?:[^*]*[^*\s])?$/u },
  { start: '_', marks: ['italic'], pattern: /(?:^|\s)_[^_\s](?:[^_]*[^_\s])?$/u },
  { start: '`', marks: ['code'], pattern: /(?:^|\s)`[^`\s](?:[^`]*[^`\s])?$/u },
  { start: '~~', marks: ['strikethrough'], pattern: /(?:^|\s)~~[^~\s](?:[^~]*[^~\s])?~$/u }
].map(({ start, marks, pattern }) => {
  const rule = createMarkInputRule({
    start,
    end: start.slice(0, -1),
    trigger: start.slice(-1),
    marks,
    enabled: (context) => isProse(context) && pattern.test(context.getBlockStartText() ?? '')
  })
  return {
    ...rule,
    apply: (context: Parameters<typeof rule.apply>[0], match: Parameters<typeof rule.apply>[1]) => {
      context.editor.tf.withNewBatch(() => {
        context.editor.tf.withoutNormalizing(() => rule.apply(context, match))
      })
      return true
    }
  }
})

const MarkdownLiveInputPlugin = createSlatePlugin({
  key: 'markdownLiveInput',
  inputRules: [
    ...markRules,
    createBlockStartInputRule({
      trigger: ' ',
      match: /^(#{1,6}|>|[-+*]|1[.)])$/u,
      enabled: (context) => isProse(context) && context.getBlockEntry()?.[0].type === 'p',
      apply: ({ editor, getBlockEntry }, { range, text }) => {
        const entry = getBlockEntry()
        if (!entry) return false
        const [, path] = entry
        editor.tf.withNewBatch(() => {
          editor.tf.withoutNormalizing(() => {
            editor.tf.delete({ at: range })
            if (text.startsWith('#')) {
              editor.tf.setNodes({ type: `h${text.length}` }, { at: path })
            } else if (text === '>') {
              editor.tf.wrapNodes({ type: 'blockquote', children: [] }, { at: path })
            } else {
              editor.tf.setNodes({ type: 'lic' }, { at: path })
              editor.tf.wrapNodes({ type: 'li', children: [] }, { at: path })
              editor.tf.wrapNodes(
                { type: text.startsWith('1') ? 'ol' : 'ul', children: [] },
                { at: path }
              )
            }
          })
        })
        return true
      }
    }),
    defineInputRule({
      target: 'insertBreak',
      resolve: ({ editor, getBlockEntry, getBlockStartRange, getBlockStartText, isCollapsed }) => {
        if (!isCollapsed) return
        const entry = getBlockEntry()
        if (!entry || !editor.selection || !editor.api.isEnd(editor.selection.focus, entry[1]))
          return
        const text = getBlockStartText() ?? ''
        const range = getBlockStartRange()
        if (!range) return
        const [node, path] = entry
        if (node.type === 'p') {
          const fence = /^(?:```|~~~)([\w+-]*)$/u.exec(text)
          if (fence && !/^(mermaid|flowchart|sequenceDiagram)$/iu.test(fence[1])) {
            return { kind: 'code', path, range, lang: fence[1] || undefined }
          }
          if (/^(?:---+|\*\*\*+|___+)$/u.test(text)) return { kind: 'hr', path, range }
        }
        if (typeof node.type === 'string' && /^h[1-6]$/u.test(node.type)) {
          return { kind: 'paragraph', path, range }
        }
        if (node.type === 'code_line' && /^(?:```|~~~)$/u.test(text)) {
          return { kind: 'exitCode', path, range }
        }
        if (node.type === 'lic') return { kind: text ? 'list' : 'exitList', path, range }
        return undefined
      },
      apply: ({ editor, insertBreak }, { kind, path, range, lang }) => {
        editor.tf.withNewBatch(() => {
          editor.tf.withoutNormalizing(() => {
            if (kind === 'paragraph') {
              insertBreak()
              editor.tf.setNodes({ type: 'p', placeholderKind: undefined })
            } else if (kind === 'list') {
              editor.tf.splitNodes({ match: (node) => node.type === 'li', always: true })
            } else if (kind === 'exitList') {
              // Lift the empty item out of its list, then unwrap its item container.
              const itemPath = path.slice(0, -1)
              editor.tf.liftNodes({ at: itemPath })
              editor.tf.unwrapNodes({ match: (node) => node.type === 'li', split: true })
              editor.tf.setNodes({ type: 'p', placeholderKind: undefined })
            } else if (kind === 'exitCode') {
              editor.tf.delete({ at: range })
              editor.tf.liftNodes({ at: path })
              editor.tf.setNodes({ type: 'p', placeholderKind: undefined })
            } else {
              editor.tf.delete({ at: range })
              if (kind === 'code') {
                editor.tf.setNodes({ type: 'code_line' }, { at: path })
                editor.tf.wrapNodes({ type: 'code_block', lang, children: [] }, { at: path })
              } else {
                editor.tf.setNodes({ type: 'hr' }, { at: path })
                const nextPath = [...path.slice(0, -1), path[path.length - 1] + 1]
                editor.tf.insertNodes(
                  { type: 'p', children: [{ text: '' }] },
                  { at: nextPath, select: true }
                )
              }
            }
          })
        })
        return true
      }
    })
  ]
})

// The codec's classic-list mappings resolve these node keys through the plugin registry.
export const markdownElementPlugins = [
  ...[
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'ul',
    'ol',
    'li',
    'lic',
    'code_block',
    'code_line',
    'table',
    'tr',
    'td',
    'th'
  ].map((key) => createSlatePlugin({ key, node: { isElement: true } })),
  createSlatePlugin({ key: 'a', node: { isElement: true, isInline: true } }),
  createSlatePlugin({ key: 'img', node: { isElement: true, isVoid: true } }),
  createSlatePlugin({ key: 'hr', node: { isElement: true, isVoid: true } })
]

export const createMarkdownEditor = (value: Value, components: NodeComponents = {}): PlateEditor =>
  createPlateEditor({
    plugins: [
      ...markdownElementPlugins,
      ...['bold', 'italic', 'code', 'strikethrough'].map((key) =>
        createSlatePlugin({ key, node: { isLeaf: true } })
      ),
      MarkdownPlugin.configure({
        options: { remarkPlugins: [remarkGfm, remarkMath], rules: markdownListRules }
      }),
      MarkdownLiveInputPlugin
    ],
    override: { components },
    value
  })
