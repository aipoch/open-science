import { describe, expect, it } from 'vitest'
import {
  literatureSynthesisContract,
  synthesisNoteSearchText,
  synthesisNoteSourceMetadata,
  synthesisNoteSummary,
  synthesisNoteSummarySchema,
  type SynthesisStoredNote
} from './literature-synthesis'

describe('synthesisNoteSearchText', () => {
  it('derives content search text without duplicating source metadata', () => {
    const note = {
      title: 'Pathway review',
      blocks: [
        { type: 'text', id: 'analysis', text: 'Interpretation' },
        {
          type: 'excerpt',
          id: 'excerpt',
          snapshot: {
            bibliography: {
              title: 'A paper about enzymes',
              authors: 'Research Group',
              itemId: 'paper'
            },
            tags: [{ id: 'tag', name: 'Methods' }],
            annotation: {
              target: { selector: { kind: 'text', exact: 'Preserved quote' } },
              note: 'Follow-up annotation'
            }
          }
        }
      ]
    } as unknown as Pick<SynthesisStoredNote, 'title' | 'blocks'>

    expect(synthesisNoteSearchText(note)).toBe(
      ['Interpretation', 'Preserved quote', 'Follow-up annotation'].join('\n')
    )
  })

  it('keeps text-only legacy notes searchable', () => {
    const note = {
      title: 'Legacy note',
      blocks: [{ type: 'text', id: 'text', text: 'Saved content' }]
    } as unknown as Pick<SynthesisStoredNote, 'title' | 'blocks'>

    expect(synthesisNoteSearchText(note)).toBe('Saved content')
  })
})

describe('synthesisNoteSourceMetadata', () => {
  it('deduplicates papers and merges each paper’s tags in excerpt order', () => {
    const note = {
      blocks: [
        {
          type: 'excerpt',
          id: 'first',
          snapshot: {
            itemId: 'paper-1',
            bibliography: { itemId: 'paper-1', title: 'Paper One', authors: 'Author One' },
            tags: [
              { id: 'methods', name: 'Methods' },
              { id: 'methods-duplicate', name: 'Methods' }
            ]
          }
        },
        {
          type: 'excerpt',
          id: 'second',
          snapshot: {
            itemId: 'paper-1',
            bibliography: { itemId: 'paper-1', title: 'Paper One', authors: 'Author One' },
            tags: [{ id: 'evidence', name: 'Evidence' }]
          }
        },
        {
          type: 'excerpt',
          id: 'third',
          snapshot: {
            itemId: 'paper-2',
            bibliography: { itemId: 'paper-2', title: 'Paper Two', authors: 'Author Two' },
            tags: []
          }
        }
      ]
    } as unknown as Pick<SynthesisStoredNote, 'blocks'>

    expect(synthesisNoteSourceMetadata(note)).toEqual([
      { title: 'Paper One', authors: 'Author One', tags: ['Methods', 'Evidence'] },
      { title: 'Paper Two', authors: 'Author Two', tags: [] }
    ])
  })
})

describe('synthesisNoteSummary', () => {
  it('omits blocks and mutation receipts while keeping all snapshot metadata searchable', () => {
    const note = {
      id: 'note',
      title: 'Note',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      creationRequest: { id: 'request', fingerprint: 'a'.repeat(64) },
      blocks: Array.from({ length: 3 }, (_, index) => ({
        type: 'excerpt',
        id: `block-${index}`,
        snapshot: {
          itemId: 'paper',
          bibliography: {
            itemId: 'paper',
            title: index === 2 ? 'Renamed paper' : 'Original paper',
            authors: index === 2 ? 'New author' : 'Original author'
          },
          tags: Array.from({ length: 24 }, (_, tag) => ({
            id: `tag-${index}-${tag}`,
            name: `Tag ${index * 24 + tag}`
          })),
          annotation: { target: { selector: { kind: 'text', exact: 'Repeated quote' } }, note: '' }
        }
      }))
    } as unknown as SynthesisStoredNote
    const summary = synthesisNoteSummarySchema.parse(synthesisNoteSummary(note))
    expect(summary).not.toHaveProperty('blocks')
    expect(summary).not.toHaveProperty('creationRequest')
    expect(summary.searchText).toBe('Repeated quote')
    expect(summary.sourceMetadata).toHaveLength(2)
    expect(summary.sourceMetadata?.[0].tags).toHaveLength(48)
    expect(summary.sourceMetadata?.[0].tags.at(-1)).toBe('Tag 47')
    expect(summary.sourceMetadata?.[1]).toMatchObject({
      title: 'Renamed paper',
      authors: 'New author'
    })
  })
})

it('preserves a recognizable block-limit result across the shared JSON transport contract', () => {
  const rejected = { action: 'append-rejected', reason: 'block-limit', maxBlocks: 200 }
  expect(literatureSynthesisContract.result.parse(JSON.parse(JSON.stringify(rejected)))).toEqual(
    rejected
  )
})

it('transports a source-free revision response without accepting note contents', () => {
  expect(
    literatureSynthesisContract.args.parse([{ action: 'revision', noteId: 'note-1' }])
  ).toEqual([{ action: 'revision', noteId: 'note-1' }])
  const result = { action: 'revision', noteId: 'note-1', revision: 7 }
  expect(literatureSynthesisContract.result.parse(JSON.parse(JSON.stringify(result)))).toEqual(
    result
  )
  expect(() => literatureSynthesisContract.result.parse({ ...result, blocks: [] })).toThrow()
})
