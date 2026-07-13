import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { RNA_TOOLS } from './rna'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => RNA_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

describe('rna / rfam', () => {
  it('rfam_get_family builds the URL and flattens the rfam envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        rfam: {
          acc: 'RF00005',
          id: 'tRNA',
          description: 'tRNA',
          curation: { type: 'Gene; tRNA;' }
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('rfam_get_family'),
      { family: 'RF00005' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00005?content-type=application/json'
    )
    expect(out).toEqual({
      rfam_acc: 'RF00005',
      id: 'tRNA',
      description: 'tRNA',
      type: 'Gene; tRNA;'
    })
  })

  it('rfam_get_family accepts a family id and tolerates missing curation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        rfam: { acc: 'RF00005', id: 'tRNA', description: 'tRNA' }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('rfam_get_family'),
      { family: 'tRNA' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/tRNA?content-type=application/json'
    )
    expect(out).toEqual({
      rfam_acc: 'RF00005',
      id: 'tRNA',
      description: 'tRNA',
      type: undefined
    })
  })

  it('rfam_acc_to_id builds the URL and trims the text response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textRes('tRNA\n'))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('rfam_acc_to_id'),
      { accession: 'RF00005' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rfam.org/family/RF00005/id?content-type=text/plain'
    )
    expect(out).toEqual({ accession: 'RF00005', id: 'tRNA' })
  })
})
