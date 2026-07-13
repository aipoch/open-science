import { DOMParser } from '@xmldom/xmldom'
import type { ToolDescriptor } from '../types'

const text = (el: Element | undefined): string | undefined => el?.textContent?.trim() ?? undefined

// arXiv Atom API: read-only literature search (XML response).
export const LITERATURE_TOOLS: ToolDescriptor[] = [
  {
    id: 'arxiv_search',
    connector: 'literature',
    description: 'Search arXiv papers; returns id, title, and summary per hit.',
    input: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer', default: 5 } },
      required: ['query']
    },
    required: ['query'],
    format: 'text',
    url: (a) =>
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(String(a.query))}&max_results=${Number(a.max_results ?? 5)}`,
    parse: (raw) => {
      const doc = new DOMParser().parseFromString(String(raw), 'text/xml')
      return Array.from(doc.getElementsByTagName('entry')).map((e) => ({
        id: text(e.getElementsByTagName('id')[0]),
        title: text(e.getElementsByTagName('title')[0]),
        summary: text(e.getElementsByTagName('summary')[0])
      }))
    }
  }
]
