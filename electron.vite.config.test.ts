import { describe, expect, it } from 'vitest'

import config from './electron.vite.config'

describe('electron Vite renderer configuration', () => {
  it('forces dependency optimization for every development-server start', () => {
    const rendererConfig = (
      config as {
        renderer?: { optimizeDeps?: { force?: boolean } }
      }
    ).renderer

    expect(rendererConfig?.optimizeDeps?.force).toBe(true)
  })
})
