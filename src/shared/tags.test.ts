import { describe, expect, it } from 'vitest'

import { tagApplicationCommandContracts } from './tags'

describe('tag application command contracts', () => {
  it('accepts system and custom tags without exposing nameKey', () => {
    const snapshot = {
      revision: 1,
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'custom',
          name: 'Analysis',
          iconKey: 'flask-conical',
          colorKey: 'blue',
          createdAt: 1,
          updatedAt: 2
        }
      ],
      assignments: [
        {
          tagId: 'custom',
          resourceType: 'catalog.skill',
          resourceId: 'literature-review',
          createdAt: 2
        }
      ]
    } as const

    expect(tagApplicationCommandContracts.snapshot.result.parse(snapshot)).toBe(snapshot)
    expect(() =>
      tagApplicationCommandContracts.snapshot.result.parse({
        ...snapshot,
        tags: [{ ...snapshot.tags[1], nameKey: 'analysis' }]
      })
    ).toThrow()
  })

  it('rejects renderer-supplied ids and unsupported resources', () => {
    expect(() =>
      tagApplicationCommandContracts.create.args.parse([
        { id: 'forged', name: 'Analysis', iconKey: 'tag', colorKey: 'blue' }
      ])
    ).toThrow()
    expect(() =>
      tagApplicationCommandContracts.setAssignment.args.parse([
        {
          tagId: 'custom',
          resourceType: 'catalog.message',
          resourceId: 'message-1',
          assigned: true
        }
      ])
    ).toThrow()
  })

  it('accepts only a strict ordered Tag id list', () => {
    expect(tagApplicationCommandContracts.reorder.args.parse([{ tagIds: ['a', 'b'] }])).toEqual([
      { tagIds: ['a', 'b'] }
    ])
    expect(() =>
      tagApplicationCommandContracts.reorder.args.parse([{ tagIds: ['a'], extra: true }])
    ).toThrow()
  })
})
