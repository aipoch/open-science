import { ElementApi, PathApi, RangeApi, type Path, type TElement } from 'platejs'
import type { PlateEditor } from 'platejs/react'

export const isMarkdownList = (node: unknown): node is TElement =>
  ElementApi.isElement(node) && (node.type === 'ul' || node.type === 'ol')

export const isMarkdownListItem = (editor: PlateEditor, path: Path): boolean =>
  editor.api.node(path)?.[0].type === 'li' &&
  isMarkdownList(editor.api.node(path.slice(0, -1))?.[0])

/** Remove an emptied list before Slate normalizes it into a text-containing container. */
export const removeEmptyMarkdownList = (editor: PlateEditor, path: Path): void => {
  const node = editor.api.node(path)?.[0]
  if (isMarkdownList(node) && node.children.length === 0) editor.tf.removeNodes({ at: path })
}

/** Tab only owns a caret in list prose, never a code block or an embedded control. */
export const getMarkdownListItemAtCaret = (editor: PlateEditor): Path | undefined => {
  if (!editor.selection || !RangeApi.isCollapsed(editor.selection)) return
  const block = editor.api.block()
  if (block?.[0].type !== 'lic') return
  const path = block[1].slice(0, -1)
  return isMarkdownListItem(editor, path) ? path : undefined
}

/** Move one item and its subtree, keeping the caret and the entire operation in one undo step. */
export const indentMarkdownListItem = (
  editor: PlateEditor,
  path: Path,
  outdent = false
): boolean => {
  if (!isMarkdownListItem(editor, path)) return false
  const listPath = PathApi.parent(path)
  const list = editor.api.node<TElement>(listPath)![0]
  const index = path[path.length - 1]
  if (!outdent && index === 0) return false

  editor.tf.withNewBatch(() =>
    editor.tf.withoutNormalizing(() => {
      if (!outdent) {
        const previousPath = PathApi.previous(path)!
        const previous = editor.api.node<TElement>(previousPath)![0]
        const last = previous.children.at(-1)
        const reuse = isMarkdownList(last) && last.type === list.type
        const nestedPath = [...previousPath, previous.children.length - (reuse ? 1 : 0)]
        if (!reuse) editor.tf.insertNodes({ type: list.type, children: [] }, { at: nestedPath })
        editor.tf.moveNodes({
          at: path,
          to: [...nestedPath, reuse ? last.children.length : 0]
        })
        return
      }

      const parentItemPath = listPath.slice(0, -1)
      if (isMarkdownListItem(editor, parentItemPath)) {
        // Following siblings become children of the lifted item, preserving reading order.
        const item = editor.api.node<TElement>(path)![0]
        const trailingCount = list.children.length - index - 1
        if (trailingCount > 0) {
          const last = item.children.at(-1)
          const reuse = isMarkdownList(last) && last.type === list.type
          const nestedPath = [...path, item.children.length - (reuse ? 1 : 0)]
          if (!reuse) editor.tf.insertNodes({ type: list.type, children: [] }, { at: nestedPath })
          const start = reuse ? last.children.length : 0
          for (let offset = 0; offset < trailingCount; offset++) {
            editor.tf.moveNodes({ at: PathApi.next(path), to: [...nestedPath, start + offset] })
          }
        }
        editor.tf.moveNodes({ at: path, to: PathApi.next(parentItemPath) })
        removeEmptyMarkdownList(editor, listPath)
      } else {
        // At the outermost level Shift+Tab turns just this item into ordinary blocks.
        const itemRef = editor.api.pathRef(path)
        editor.tf.liftNodes({ at: path })
        const lifted = itemRef.unref()!
        const item = editor.api.node<TElement>(lifted)![0]
        item.children.forEach((child, childIndex) => {
          if (ElementApi.isElement(child) && child.type === 'lic') {
            editor.tf.setNodes({ type: 'p' }, { at: [...lifted, childIndex] })
          }
        })
        editor.tf.unwrapNodes({ at: lifted })
      }
    })
  )
  return true
}
