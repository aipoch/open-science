// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../../../../shared/session-persistence'
import {
  constrainMessageClipboard,
  copyMessageToClipboard,
  readMessageClipboard
} from './message-clipboard'
import {
  docFromMessageParts,
  docToText,
  emptyDoc,
  MAX_COMPOSER_ARTIFACT_MENTIONS,
  MAX_COMPOSER_SESSION_MENTIONS
} from './composer-doc'

const parts: MessagePart[] = [
  { type: 'text', text: 'Analyze <data> & ' },
  {
    type: 'artifact',
    id: 'upload',
    sourceFileId: 'file',
    versionId: 'v1',
    source: 'upload',
    name: 'data.csv',
    path: 'uploads/data.csv'
  },
  {
    type: 'artifact',
    id: 'artifact',
    versionId: 'v2',
    source: 'artifact',
    name: 'results.xlsx',
    path: 'artifacts/result.xlsx'
  },
  {
    type: 'artifact',
    id: 'linked',
    source: 'linked-folder',
    name: 'local.csv',
    rootId: 'granted-root',
    relativePath: 'data/local.csv'
  },
  { type: 'skill', id: 'skill', name: 'analysis' },
  { type: 'session', sessionId: 'session', title: 'Previous work' },
  { type: 'literature-scope', scope: 'project' },
  { type: 'literature-scope', scope: 'collection', collectionId: 'collection', name: 'Reading' },
  {
    type: 'literature',
    itemId: 'paper',
    metadataRevision: 2,
    item: {
      itemType: 'journalArticle',
      title: 'Research',
      abstract: '',
      issuedText: '',
      containerTitle: '',
      shortTitle: '',
      language: '',
      rights: '',
      url: '',
      extra: '',
      typeFields: {},
      creators: [],
      identifiers: []
    }
  }
]
const text = docToText(docFromMessageParts(parts))
let clipboard: Map<string, string>
let writeText: ReturnType<typeof vi.fn>
let write: ReturnType<typeof vi.fn>

beforeEach(() => {
  clipboard = new Map()
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly data: Record<string, Blob>) {}
    }
  )
  writeText = vi.fn(async (value: string) => {
    clipboard.set('text/plain', value)
  })
  write = vi.fn(async (items: { data: Record<string, Blob> }[]) => {
    for (const [type, blob] of Object.entries(items[0].data)) clipboard.set(type, await blob.text())
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write, writeText }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('message clipboard', () => {
  it('round-trips inline references while preserving readable external text', async () => {
    await copyMessageToClipboard(text, parts, 'project')
    expect(clipboard.get('text/plain')).toBe(text)
    expect(readMessageClipboard(clipboard.get('text/html')!, text, 'project')).toEqual(
      docFromMessageParts(parts)
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it('accepts native clipboard newline conversion without changing reference identities', async () => {
    const multiline = [...parts, { type: 'text' as const, text: '\nsecond line\nthird line' }]
    const sourceText = docToText(docFromMessageParts(multiline))
    await copyMessageToClipboard(sourceText, multiline, 'project')
    expect(
      readMessageClipboard(
        clipboard.get('text/html')!,
        sourceText.replaceAll('\n', '\r\n'),
        'project'
      )
    ).toEqual(docFromMessageParts(multiline))
  })

  it('does not restore references across projects, origins, or mismatched text', async () => {
    await copyMessageToClipboard(text, parts, 'project')
    const html = clipboard.get('text/html')!
    expect(readMessageClipboard(html, text, 'other')).toBeUndefined()
    expect(readMessageClipboard(html, text, undefined)).toBeUndefined()
    expect(readMessageClipboard(html, 'different text', 'project')).toBeUndefined()
    const template = document.createElement('template')
    template.innerHTML = html
    const element = template.content.firstElementChild!
    const value = JSON.parse(element.getAttribute('data-open-science-message')!)
    value.origin = 'https://other.example'
    element.setAttribute('data-open-science-message', JSON.stringify(value))
    expect(readMessageClipboard(element.outerHTML, text, 'project')).toBeUndefined()
  })

  it.each([
    'not JSON',
    JSON.stringify({ version: 2, origin: location.origin, projectId: 'project', parts }),
    JSON.stringify({
      version: 1,
      origin: location.origin,
      projectId: 'project',
      parts: [...parts, { type: 'unknown' }]
    }),
    JSON.stringify({
      version: 1,
      origin: location.origin,
      projectId: 'project',
      parts: [{ type: 'artifact', id: 'x' }]
    })
  ])('rejects malformed or unsupported metadata', (value) => {
    const element = document.createElement('span')
    element.setAttribute('data-open-science-message', value)
    expect(readMessageClipboard(element.outerHTML, text, 'project')).toBeUndefined()
  })

  it('falls back to text when rich clipboard writes fail or the host lacks support', async () => {
    write.mockRejectedValueOnce(new Error('unsupported'))
    await copyMessageToClipboard(text, parts, 'project')
    expect(writeText).toHaveBeenCalledWith(text)
    vi.stubGlobal('ClipboardItem', undefined)
    await copyMessageToClipboard(text, parts, 'project')
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('keeps historical text-only messages and inconsistent parts as text', async () => {
    await copyMessageToClipboard('@data.csv', undefined, 'project')
    await copyMessageToClipboard('changed', parts, 'project')
    await copyMessageToClipboard(text, parts, undefined)
    expect(write).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledTimes(3)
  })

  it('propagates a failed plain copy so the UI cannot claim success', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    await expect(copyMessageToClipboard('plain', undefined, 'project')).rejects.toThrow('denied')
  })

  it('keeps reference caps and allows only one available Skill without losing labels', () => {
    const artifact = parts[1]
    const session = parts[5]
    const remaining = docFromMessageParts([
      ...Array.from({ length: MAX_COMPOSER_ARTIFACT_MENTIONS }, () => artifact),
      ...Array.from({ length: MAX_COMPOSER_SESSION_MENTIONS }, () => session),
      { type: 'skill', id: 'existing', name: 'existing' }
    ])
    const result = constrainMessageClipboard(
      docFromMessageParts(parts),
      remaining,
      new Set(['skill'])
    )
    expect(result.nodes.every((node) => node.type === 'text')).toBe(true)
    expect(docToText(result)).toBe(text)
    const skills = docFromMessageParts([
      { type: 'skill', id: 'unavailable', name: 'unavailable' },
      { type: 'skill', id: 'skill', name: 'analysis' },
      { type: 'skill', id: 'skill', name: 'analysis' }
    ])
    expect(
      constrainMessageClipboard(skills, emptyDoc, new Set(['skill'])).nodes.map((node) => node.type)
    ).toEqual(['text', 'skill', 'text'])
  })
})
