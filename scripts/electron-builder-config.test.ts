import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('electron-builder Windows targets', () => {
  it('ships both the NSIS installer and the portable zip', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const windowsConfig = config.match(/^win:\n([\s\S]*?)(?=^[^\s#])/m)?.[1]

    expect(windowsConfig).toBeDefined()
    // Both formats, mirroring mac (dmg + zip): the installer plus a portable, no-install build.
    expect(windowsConfig).toMatch(/^\s+- nsis\s*$/m)
    expect(windowsConfig).toMatch(/^\s+- zip\s*$/m)
  })
})
