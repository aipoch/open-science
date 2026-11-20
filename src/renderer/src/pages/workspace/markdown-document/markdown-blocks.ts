import { NodeApi, PathApi, type Descendant, type Path, type TElement } from 'platejs'
import type { PlateEditor } from 'platejs/react'
import {
  isMarkdownList,
  isMarkdownListItem,
  removeEmptyMarkdownList
} from './markdown-list-transforms'

const isEditableBlock = (editor: PlateEditor, path: Path): boolean =>
  path.length > 0 &&
  path.every((index) => Number.isInteger(index) && index >= 0) &&
  !!editor.api.node(path) &&
  (path.length === 1 || isMarkdownListItem(editor, path))

export const markdownBlockSiblingCount = (editor: PlateEditor, path: Path): number =>
  editor.api.node<TElement>(path.slice(0, -1))?.[0].children.length ?? 0

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

export type MarkdownPlaceholderElement = TElement & {
  placeholderKind?: MarkdownInsertKind
}

export type DropdownDefinition = Readonly<{
  options: readonly string[]
  selected: string
}>

const text = (value = ''): Descendant => ({ text: value })
const paragraph = (value = ''): TElement => ({ type: 'p', children: [text(value)] })

const listItem = (value: string, checked?: boolean): TElement => ({
  type: 'li',
  ...(checked === undefined ? {} : { checked }),
  children: [{ type: 'lic', children: [text(value)] }]
})

const setBlockText = (node: TElement, value: string): void => {
  switch (node.type) {
    case 'h1':
    case 'h2':
    case 'h3':
      node.children = [text(value)]
      break
    case 'blockquote':
      node.children = [paragraph(value)]
      break
    case 'ul':
    case 'ol': {
      const currentItem = node.children[0]
      const checked =
        currentItem &&
        typeof currentItem === 'object' &&
        'checked' in currentItem &&
        typeof currentItem.checked === 'boolean'
          ? currentItem.checked
          : undefined
      node.children = [listItem(value, checked)]
      break
    }
    case 'table': {
      const firstRow = node.children[0]
      if (
        firstRow &&
        typeof firstRow === 'object' &&
        'children' in firstRow &&
        Array.isArray(firstRow.children)
      ) {
        const firstCell = firstRow.children[0]
        if (
          firstCell &&
          typeof firstCell === 'object' &&
          'children' in firstCell &&
          Array.isArray(firstCell.children)
        )
          firstCell.children = [paragraph(value)]
      }
      break
    }
    case 'img':
      node.caption = [text(value)]
      break
    case 'code_block':
      node.children = [{ type: 'code_line', children: [text(value)] }]
      break
    case 'p':
      node.children = [text(value)]
      break
    default:
      break
  }
}

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

/** Insert after the selected block or list item and select its first editable text. */
export const insertMarkdownBlock = (
  editor: PlateEditor,
  selectedPath: Path | undefined,
  kind: MarkdownInsertKind,
  options: Readonly<{ imageUrl?: string; imageAlt?: string; date?: string; code?: string }> = {}
): Path => {
  const at = [
    selectedPath ? Math.min(selectedPath[0] + 1, editor.children.length) : editor.children.length
  ]
  const node: MarkdownPlaceholderElement = {
    ...createMarkdownBlock(kind, options),
    placeholderKind: kind
  }
  if (selectedPath && isMarkdownListItem(editor, selectedPath)) {
    let insertedPath = PathApi.next(selectedPath)
    const list = editor.api.node(PathApi.parent(selectedPath))![0]
    editor.tf.withNewBatch(() =>
      editor.tf.withoutNormalizing(() => {
        if (isMarkdownList(node) && node.type === list.type) {
          editor.tf.insertNodes(
            { ...node.children[0], placeholderKind: kind },
            { at: insertedPath, select: true }
          )
        } else {
          // Split the containing list so a different block really sits after this item,
          // rather than after the entire list or illegally inside a ul/ol.
          editor.tf.insertNodes(listItem(''), { at: insertedPath })
          const ref = editor.api.pathRef(insertedPath)
          editor.tf.liftNodes({ at: insertedPath })
          insertedPath = ref.unref()!
          editor.tf.replaceNodes(node, { at: insertedPath, select: true })
        }
      })
    )
    return insertedPath
  }
  editor.tf.withNewBatch(() => editor.tf.insertNodes(node, { at, select: true }))
  return at
}

export const duplicateMarkdownBlock = (editor: PlateEditor, path: Path): Path | undefined => {
  if (!isEditableBlock(editor, path)) return undefined
  const node = structuredClone(editor.api.node(path)![0])
  const next = PathApi.next(path)
  editor.tf.withNewBatch(() => editor.tf.insertNodes(node, { at: next, select: true }))
  return next
}

export const deleteMarkdownBlock = (editor: PlateEditor, path: Path): boolean => {
  if (!isEditableBlock(editor, path)) return false
  editor.tf.withNewBatch(() =>
    editor.tf.withoutNormalizing(() => {
      editor.tf.removeNodes({ at: path })
      removeEmptyMarkdownList(editor, PathApi.parent(path))
    })
  )
  return true
}

export const turnMarkdownBlockInto = (
  editor: PlateEditor,
  path: Path,
  kind: MarkdownInsertKind
): boolean => {
  if (!isEditableBlock(editor, path)) return false
  const current = editor.api.node<TElement>(path)![0]
  const item = isMarkdownListItem(editor, path)
  const value = NodeApi.string(item ? current.children[0] : current)
  const node: MarkdownPlaceholderElement = {
    ...createMarkdownBlock(kind, { code: value, date: value || undefined, imageAlt: value }),
    placeholderKind: kind
  }
  if (kind !== 'divider' && kind !== 'dropdown' && !(kind === 'date' && !value))
    setBlockText(node, value)
  if (kind === 'dropdown' && value) {
    const selected = value.trim()
    const definition = encodeDropdownDefinition({ options: [selected], selected })
    node.children = [{ type: 'code_line', children: [text(definition)] }]
  }
  editor.tf.withNewBatch(() =>
    editor.tf.withoutNormalizing(() => {
      if (!item) {
        editor.tf.replaceNodes(node, { at: path, select: true })
        return
      }
      const trailing = current.children.slice(1)
      if (isMarkdownList(node)) {
        const replacement = node.children[0] as TElement
        replacement.children.push(...trailing)
        const parent = editor.api.node(PathApi.parent(path))![0]
        if (node.type === parent.type) {
          editor.tf.replaceNodes(replacement, { at: path, select: true })
          return
        }
      }
      const ref = editor.api.pathRef(path)
      editor.tf.liftNodes({ at: path })
      editor.tf.replaceNodes(isMarkdownList(node) ? node : [node, ...trailing], {
        at: ref.unref()!,
        select: true
      })
    })
  )
  return true
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
    !isEditableBlock(editor, fromPath) ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= markdownBlockSiblingCount(editor, fromPath)
  )
    return false
  if (targetIndex === fromPath[fromPath.length - 1]) return false
  editor.tf.withNewBatch(() => {
    editor.tf.moveNodes({ at: fromPath, to: [...PathApi.parent(fromPath), targetIndex] })
  })
  return true
}

/** Drop at an actual block boundary, not the list's top-level ancestor. */
export const moveMarkdownBlockRelative = (
  editor: PlateEditor,
  from: Path,
  target: Path,
  after: boolean
): boolean => {
  if (
    !isEditableBlock(editor, from) ||
    !isEditableBlock(editor, target) ||
    PathApi.equals(from, target) ||
    PathApi.isAncestor(from, target) ||
    PathApi.isAncestor(target, from)
  )
    return false
  const sameParent = PathApi.equals(PathApi.parent(from), PathApi.parent(target))
  if (sameParent) {
    const boundary = target[target.length - 1] + (after ? 1 : 0)
    return moveMarkdownBlockTo(editor, from, boundary - (from[from.length - 1] < boundary ? 1 : 0))
  }
  const fromItem = isMarkdownListItem(editor, from)
  const targetItem = isMarkdownListItem(editor, target)
  editor.tf.withNewBatch(() =>
    editor.tf.withoutNormalizing(() => {
      const parentRef = editor.api.pathRef(PathApi.parent(from))
      const sourceRef = editor.api.pathRef(from)
      const sourceList = editor.api.node<TElement>(PathApi.parent(from))![0]
      const boundary = after ? PathApi.next(target) : target
      if (!fromItem && targetItem) {
        // Make a block boundary between the target list items, never a paragraph
        // directly inside ul/ol. Path refs track both the split and the move.
        editor.tf.insertNodes(listItem(''), { at: boundary })
        const boundaryRef = editor.api.pathRef(boundary)
        editor.tf.liftNodes({ at: boundary })
        editor.tf.moveNodes({ at: sourceRef.current!, to: boundaryRef.current! })
        editor.tf.removeNodes({ at: boundaryRef.unref()! })
      } else {
        editor.tf.moveNodes({ at: from, to: boundary })
        if (fromItem && !targetItem) {
          editor.tf.wrapNodes({ type: sourceList.type, children: [] }, { at: sourceRef.current! })
        }
      }
      sourceRef.unref()
      const parent = parentRef.unref()
      if (parent) removeEmptyMarkdownList(editor, parent)
    })
  )
  return true
}
