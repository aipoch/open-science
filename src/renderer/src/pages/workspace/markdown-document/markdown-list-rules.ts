import { ElementApi, NodeApi, type Descendant, type TElement } from 'platejs'
import {
  convertChildrenDeserialize,
  convertNodesSerialize,
  defaultRules,
  type MdRules,
  type DeserializeMdOptions,
  type SerializeMdOptions,
  type MdDecoration
} from '@platejs/markdown'
import type { List, ListItem, Paragraph, RootContent } from 'mdast'

const deserializeList = (
  node: List,
  deco: MdDecoration,
  options: DeserializeMdOptions
): TElement => ({
  type: node.ordered ? 'ol' : 'ul',
  ...(node.start && node.start !== 1 ? { start: node.start } : {}),
  children: node.children.map((item) => ({
    type: 'li',
    ...(typeof item.checked === 'boolean' ? { checked: item.checked } : {}),
    children: item.children.flatMap((child): Descendant[] => {
      if (child.type === 'list') return [deserializeList(child, deco, options)]
      const converted = convertChildrenDeserialize([child], deco, options)
      return converted.map((element) =>
        ElementApi.isElement(element) && element.type === 'p'
          ? { ...element, type: 'lic' }
          : element
      )
    })
  }))
})

const serializeList = (node: TElement, options: SerializeMdOptions): List => ({
  type: 'list',
  ordered: node.type === 'ol',
  spread: false,
  ...(typeof node.start === 'number' ? { start: node.start } : {}),
  children: node.children.filter(ElementApi.isElement).map((item): ListItem => ({
    type: 'listItem',
    spread: false,
    ...(typeof item.checked === 'boolean' ? { checked: item.checked } : {}),
    children: item.children.flatMap((child): ListItem['children'] => {
      if (!ElementApi.isElement(child)) return []
      if (child.type === 'ul' || child.type === 'ol') return [serializeList(child, options)]
      if (child.type === 'lic') {
        // The codec returns generic unist nodes; the lic schema owns phrasing children.
        const children = convertNodesSerialize(child.children, options) as Paragraph['children']
        // GFM omits the checkbox of a paragraph with no phrasing nodes. Retain an
        // invisible editable placeholder so a newly inserted/cleared task stays a task.
        if (typeof item.checked === 'boolean' && NodeApi.string(child) === '') {
          children.push({ type: 'text', value: '\u200b' })
        }
        return [{ type: 'paragraph', children }]
      }
      const blocks = convertNodesSerialize([child], options) as RootContent[]
      return blocks.filter(
        (block): block is ListItem['children'][number] => block.type !== 'definition'
      )
    })
  }))
})

const isEmptyTextCell = (node: TElement): boolean =>
  node.children.every((child) =>
    ElementApi.isElement(child)
      ? child.type === 'p' &&
        child.children.every((leaf) => !ElementApi.isElement(leaf) && leaf.text === '')
      : child.text === ''
  )

export const markdownListRules: MdRules = {
  list: { deserialize: deserializeList, serialize: serializeList },
  td: {
    serialize: (node, options) =>
      isEmptyTextCell(node)
        ? { type: 'tableCell', children: [] }
        : defaultRules.td!.serialize!(node, options)
  },
  th: {
    serialize: (node, options) =>
      isEmptyTextCell(node)
        ? { type: 'tableCell', children: [] }
        : defaultRules.th!.serialize!(node, options)
  }
}
