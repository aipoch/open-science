import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('renderer content security policy', () => {
  it('permits only self-hosted and Blob workers', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')

    expect(html).toContain("worker-src 'self' blob:")
    expect(html).toContain("font-src 'self' data: blob:")
  })
})
