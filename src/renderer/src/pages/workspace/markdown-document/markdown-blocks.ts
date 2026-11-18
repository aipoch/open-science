import type { Descendant, Path, TElement } from 'platejs'
import type { PlateEditor } from 'platejs/react'

export const DROPDOWN_LANGUAGE = 'openscience-dropdown'

export type MarkdownInsertKind =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'numbered'
  | 'checklist'
  | 'table'
  | 'image'
  | 'code'
  | 'quote'
  | 'divider'
  | 'date'
  | 'dropdown'

export type DropdownDefinition = Readonly<{
  options: readonly string[]
  selected: string
}>

const text = (value = ''): Descendant => ({ text: value })
const paragraph = (value = ''): TElement => ({ type: 'p', children: [text(value)] })

/** Return a node that the existing Plate Markdown codec can serialize. */
export const createMarkdownBlock = (
  kind: MarkdownInsertKind,
  options: Readonly<{ imageUrl?: string; imageAlt?: string; date?: string; code?: string }> = {}
): TElement => {
  switch (kind) {
    case 'h1':
    case 'h2':
    case 'h3':
      return { type: kind, children: [text('')] }
    case 'bullet':
      return {
        type: 'ul',
        children: [{ type: 'li', children: [{ type: 'lic', children: [text('')] }] }]
      }
    case 'numbered':
      return {
        type: 'ol',
        children: [{ type: 'li', children: [{ type: 'lic', children: [text('')] }] }]
      }
    case 'checklist':
      return {
        type: 'ul',
        children: [
          { type: 'li', checked: false, children: [{ type: 'lic', children: [text('')] }] }
        ]
      }
    case 'table':
      return {
        type: 'table',
        children: [
          {
            type: 'tr',
            children: [
              { type: 'th', children: [paragraph()] },
              { type: 'th', children: [paragraph()] }
            ]
          },
          {
            type: 'tr',
            children: [
              { type: 'td', children: [paragraph()] },
              { type: 'td', children: [paragraph()] }
            ]
          }
        ]
      }
    case 'image':
      return {
        type: 'img',
        url: options.imageUrl ?? '',
        caption: [{ text: options.imageAlt ?? '' }],
        children: [text('')]
      }
    case 'code':
      return {
        type: 'code_block',
        children: [{ type: 'code_line', children: [text(options.code ?? '')] }]
      }
    case 'quote':
      return { type: 'blockquote', children: [paragraph()] }
    case 'divider':
      return { type: 'hr', children: [text('')] }
    case 'date':
      return paragraph(options.date ?? new Date().toISOString().slice(0, 10))
    case 'dropdown': {
      const definition = encodeDropdownDefinition({
        options: ['1', '2'],
        selected: '1'
      })
      return {
        type: 'code_block',
        lang: DROPDOWN_LANGUAGE,
        children: [{ type: 'code_line', children: [text(definition)] }]
      }
    }
  }
}

/** Insert after a block's top-level ancestor and select the new block. */
export const insertMarkdownBlock = (
  editor: PlateEditor,
  selectedPath: Path | undefined,
  kind: MarkdownInsertKind,
  options: Readonly<{ imageUrl?: string; imageAlt?: string; date?: string; code?: string }> = {}
): Path => {
  const at = [
    selectedPath ? Math.min(selectedPath[0] + 1, editor.children.length) : editor.children.length
  ]
  const node = createMarkdownBlock(kind, options)
  editor.tf.withNewBatch(() => {
    editor.tf.insertNodes(node, { at, select: true })
  })
  return at
}

export const isSafeRemoteImageUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

export const encodeDropdownDefinition = (definition: DropdownDefinition): string => {
  const options = [...new Set(definition.options.map((option) => option.trim()).filter(Boolean))]
  const selected = options.includes(definition.selected) ? definition.selected : (options[0] ?? '')
  // The codec intentionally treats HTML-looking text as source-mode content. Escaping angle
  // brackets in JSON keeps labels portable without weakening that safety policy.
  return JSON.stringify({ options, selected })
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

export const decodeDropdownDefinition = (value: string): DropdownDefinition | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || !('options' in parsed) || !('selected' in parsed))
      return undefined
    const optionsValue = parsed.options
    const selectedValue = parsed.selected
    if (
      !Array.isArray(optionsValue) ||
      typeof selectedValue !== 'string' ||
      optionsValue.length === 0
    )
      return undefined
    const options = optionsValue
      .map((option) => (typeof option === 'string' ? option.trim() : ''))
      .filter(Boolean)
    if (
      options.length !== optionsValue.length ||
      new Set(options).size !== options.length ||
      !options.includes(selectedValue)
    )
      return undefined
    return { options, selected: selectedValue }
  } catch {
    return undefined
  }
}

export const moveMarkdownBlockTo = (
  editor: PlateEditor,
  fromPath: Path,
  targetIndex: number
): boolean => {
  if (
    fromPath.length !== 1 ||
    !Number.isInteger(fromPath[0]) ||
    fromPath[0] < 0 ||
    fromPath[0] >= editor.children.length ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= editor.children.length
  )
    return false
  if (targetIndex === fromPath[0]) return false
  editor.tf.withNewBatch(() => {
    editor.tf.moveNodes({ at: fromPath, to: [targetIndex] })
  })
  return true
}
