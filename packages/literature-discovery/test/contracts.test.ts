import { z } from 'zod'
import { describe, it, expect } from 'vitest'
import {
  literatureFullTextRequestSchema,
  literatureFullTextResultSchema
} from '../src/contracts.js'

describe('Literature full-text transfer contract', () => {
  it('restores a transfer by item and acknowledges only an explicit task identity', () => {
    const args = z.tuple([literatureFullTextRequestSchema])
    const result = literatureFullTextResultSchema
    expect(args.parse([{ mode: 'transfer', itemId: 'item' }])).toEqual([
      { mode: 'transfer', itemId: 'item' }
    ])
    expect(() => args.parse([{ mode: 'transfer', itemId: 'item', acknowledgeId: '' }])).toThrow()
    expect(result.parse({ mode: 'transfer' })).toEqual({ mode: 'transfer' })
    const transfer = {
      id: 'task',
      itemId: 'item',
      status: 'running',
      candidate: {
        id: 'candidate',
        provider: 'unpaywall',
        source: 'Repository',
        url: 'https://example.com/paper.pdf'
      },
      progress: { receivedBytes: 10, bytesPerSecond: 2, phase: 'downloading' }
    }
    expect(result.parse({ mode: 'transfer', transfer })).toEqual({ mode: 'transfer', transfer })
    expect(() =>
      result.parse({ mode: 'transfer', transfer: { ...transfer, status: 'invented' } })
    ).toThrow()
  })
})
