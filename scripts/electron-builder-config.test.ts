import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('electron-builder Windows targets', () => {
  it('ships only the NSIS installer', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const windowsConfig = config.match(/^win:\n([\s\S]*?)(?=^[^\s#])/m)?.[1]

    expect(windowsConfig).toBeDefined()
    expect(windowsConfig).toMatch(/^\s+target:\n\s+- nsis\s*$/m)
    expect(windowsConfig).not.toMatch(/^\s+- zip\s*$/m)
  })
})
