import { describe, expect, it } from 'vitest'

import config from '../electron.vite.config'

const resolvedConfig = (config as (input: { command: 'build'; mode: string }) => unknown)({
  command: 'build',
  mode: 'production'
})

describe('electron-vite main process dependencies', () => {
  it('bundles the source-only Notebook network sandbox package', () => {
    expect(resolvedConfig).toMatchObject({
      main: {
        build: {
          externalizeDeps: { exclude: ['@aipoch/notebook-network-sandbox'] }
        }
      }
    })
  })
})
