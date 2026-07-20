import { describe, expect, it } from 'vitest'

import { buildDevWebCommand, DEFAULT_WEB_PORT } from './dev-web.cjs'

describe('buildDevWebCommand', () => {
  it('injects the default web port when unset', () => {
    const { command, args, env } = buildDevWebCommand(['node', 'dev-web.cjs'], {})
    expect(command).toBe('npx')
    expect(args).toEqual(['electron-vite', 'dev'])
    expect(env.OPEN_SCIENCE_WEB_PORT).toBe(DEFAULT_WEB_PORT)
  })

  it('respects an existing OPEN_SCIENCE_WEB_PORT', () => {
    const { env } = buildDevWebCommand(['node', 'dev-web.cjs'], { OPEN_SCIENCE_WEB_PORT: '44200' })
    expect(env.OPEN_SCIENCE_WEB_PORT).toBe('44200')
  })

  it('forwards --headless to Electron as the namespaced --open-science-headless flag', () => {
    const { args } = buildDevWebCommand(['node', 'dev-web.cjs', '--headless'], {})
    expect(args).toEqual(['electron-vite', 'dev', '--', '--open-science-headless'])
  })

  it('does not add a passthrough separator without --headless', () => {
    const { args } = buildDevWebCommand(['node', 'dev-web.cjs'], {})
    expect(args).not.toContain('--')
  })
})
