import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

describe('main startup ordering', () => {
  it('registers the managed-preview protocol bridge before creating the first window', () => {
    const registerBridge = mainSource.indexOf(
      'const managedPreviewProtocolBridge = createManagedPreviewProtocolBridge(protocol)'
    )
    const createFirstWindow = mainSource.indexOf(
      'createMainWindow(startupWindowCloseOptions, translate)'
    )

    expect(registerBridge).toBeGreaterThan(-1)
    expect(createFirstWindow).toBeGreaterThan(registerBridge)
  })
})
