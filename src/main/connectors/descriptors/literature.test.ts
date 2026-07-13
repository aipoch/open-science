import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { LITERATURE_TOOLS } from './literature'

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/1234</id><title>Test Title</title><summary>A summary.</summary></entry>
</feed>`

describe('literature / arxiv', () => {
  it('parses Atom XML entries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => ATOM } as Response)
    const tool = LITERATURE_TOOLS.find((t) => t.id === 'arxiv_search')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { query: 'diffusion' },
      {}
    )) as unknown[]
    expect(out).toEqual([
      { id: 'http://arxiv.org/abs/1234', title: 'Test Title', summary: 'A summary.' }
    ])
  })
})
