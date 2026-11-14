import { describe, expect, it } from 'vitest'
import { createLiteratureSourceCitationHref } from '../../../../shared/literature-source-citation'
import {
  literatureSourceCitationHrefsByPrompt,
  literatureSourceCitationHrefsForMessage
} from './literature-tool-presentation'

const href = createLiteratureSourceCitationHref({
  itemId: 'paper-1',
  title: 'A trial',
  kind: 'abstract',
  quote: 'The treatment did not reduce mortality.'
})
const presentation = (hrefs: readonly string[]): unknown => ({
  type: 'content',
  content: {
    type: 'text',
    text: JSON.stringify({
      openScienceLiteraturePresentation: { sourceCitationHrefs: hrefs }
    })
  }
})
const activity = {
  status: 'completed' as const,
  promptMessageId: 'prompt-1',
  providerToolName: 'mcp__open_science_library__read_library_abstract',
  title: 'Read abstract',
  toolContent: [presentation([href])]
}

describe('Library source citation receipts', () => {
  it('accepts only completed built-in tools with explicit prompt ownership', () => {
    expect(literatureSourceCitationHrefsByPrompt([activity]).get('prompt-1')).toEqual([href])
    for (const invalid of [
      { ...activity, status: 'failed' as const },
      { ...activity, status: 'in_progress' as const },
      { ...activity, promptMessageId: undefined },
      {
        ...activity,
        providerToolName: 'external/read_library_abstract',
        title: activity.providerToolName
      },
      { ...activity, providerToolName: 'mcp__open_science_library__save_to_inbox' },
      { ...activity, toolContent: [] }
    ])
      expect(literatureSourceCitationHrefsByPrompt([invalid]).size).toBe(0)
  })

  it('uses the first normalized presentation rather than later raw duplicate claims', () => {
    const receipts = literatureSourceCitationHrefsByPrompt([
      { ...activity, toolContent: [presentation([]), presentation([href])] }
    ])
    expect(receipts.size).toBe(0)
  })

  it('never recovers source receipts from tool input or unprojected raw output', () => {
    const rawOnly = {
      ...activity,
      toolContent: [],
      rawOutput: presentation([href]),
      rawInput: presentation([href])
    }
    expect(literatureSourceCitationHrefsByPrompt([rawOnly]).size).toBe(0)
  })

  it('resolves assistant fragments to their own prompt without borrowing another turn', () => {
    const receipts = literatureSourceCitationHrefsByPrompt([activity])
    const messages = new Map([
      ['prompt-1', { id: 'prompt-1', role: 'user' as const }],
      ['prompt-2', { id: 'prompt-2', role: 'user' as const }],
      ['answer-1', { id: 'answer-1', role: 'agent' as const, responseToMessageId: 'prompt-1' }]
    ])
    expect(
      literatureSourceCitationHrefsForMessage(
        { id: 'answer-2', role: 'agent', responseToMessageId: 'answer-1' },
        messages,
        receipts
      )
    ).toEqual([href])
    expect(
      literatureSourceCitationHrefsForMessage(
        { id: 'answer-2', role: 'agent', responseToMessageId: 'prompt-2' },
        messages,
        receipts
      )
    ).toEqual([])
    expect(
      literatureSourceCitationHrefsForMessage({ id: 'prompt-1', role: 'user' }, messages, receipts)
    ).toEqual([])
    expect(
      literatureSourceCitationHrefsForMessage(
        { id: 'answer-2', role: 'agent', responseToMessageId: 'missing' },
        messages,
        receipts
      )
    ).toEqual([])
  })

  it('fails closed on a cyclic reply chain', () => {
    const cyclic = { id: 'cycle', role: 'agent' as const, responseToMessageId: 'cycle' }
    expect(
      literatureSourceCitationHrefsForMessage(
        cyclic,
        new Map([['cycle', cyclic]]),
        literatureSourceCitationHrefsByPrompt([activity])
      )
    ).toEqual([])
  })
})
