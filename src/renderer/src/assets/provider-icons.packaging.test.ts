import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('provider icon license packaging', () => {
  it('copies the LobeHub license into every packaged app', () => {
    const config = readFileSync(resolve(process.cwd(), 'electron-builder.yml'), 'utf8')

    expect(config).toContain(
      '  - from: src/renderer/src/assets/provider-icons/LobeHub-icons-LICENSE\n    to: LobeHub-icons-LICENSE'
    )
  })
})
