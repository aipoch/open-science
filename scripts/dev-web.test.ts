import { describe, expect, it } from 'vitest'

import { buildDevWebCommand, DEFAULT_WEB_PORT } from './dev-web.cjs'

describe('buildDevWebCommand', () => {
  it('injects the default web port when unset', () => {
    const { command, args, env } = buildDevWebCommand(['node', 'dev-web.cjs'], {})
    expect(command).toBe(process.execPath)
    expect(args).toEqual(['out/backend/index.cjs', '--development', `--serve=${DEFAULT_WEB_PORT}`])
    expect(env.OPEN_SCIENCE_WEB_PORT).toBe(DEFAULT_WEB_PORT)
  })

  it('respects an existing OPEN_SCIENCE_WEB_PORT', () => {
    const { env } = buildDevWebCommand(['node', 'dev-web.cjs'], { OPEN_SCIENCE_WEB_PORT: '44200' })
    expect(env.OPEN_SCIENCE_WEB_PORT).toBe('44200')
  })

  it('accepts the historical headless option while launching ordinary Node', () => {
    const { args } = buildDevWebCommand(['node', 'dev-web.cjs', '--headless'], {})
    expect(args).toEqual(['out/backend/index.cjs', '--development', `--serve=${DEFAULT_WEB_PORT}`])
  })

  it('does not add a passthrough separator without --headless', () => {
    const { args } = buildDevWebCommand(['node', 'dev-web.cjs'], {})
    expect(args).not.toContain('--')
  })
})
