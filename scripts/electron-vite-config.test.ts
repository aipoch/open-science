import { describe, expect, it } from 'vitest'

import config from '../electron.vite.config'

describe('electron-vite main process dependencies', () => {
  it('bundles the source-only Notebook network sandbox package', () => {
    expect(config).toMatchObject({
      main: {
        build: {
          externalizeDeps: { exclude: ['@aipoch/notebook-network-sandbox'] }
        }
      }
    })
  })
})
