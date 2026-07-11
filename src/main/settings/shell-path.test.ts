import { delimiter } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EXTRA_PATH_DIRS, augmentedPathEnv } from './shell-path'

describe('augmentedPathEnv', () => {
  it('appends the well-known dirs after the existing PATH', () => {
    const result = augmentedPathEnv({ PATH: '/usr/bin' })
    const dirs = (result.PATH ?? '').split(delimiter)

    expect(dirs[0]).toBe('/usr/bin')
    for (const dir of EXTRA_PATH_DIRS) {
      expect(dirs).toContain(dir)
    }
  })

  it('does not duplicate a dir already on PATH', () => {
    const result = augmentedPathEnv({ PATH: EXTRA_PATH_DIRS[0] })
    const dirs = (result.PATH ?? '').split(delimiter)

    expect(dirs.filter((dir) => dir === EXTRA_PATH_DIRS[0])).toHaveLength(1)
  })

  it('handles an empty or missing PATH', () => {
    const result = augmentedPathEnv({})

    expect((result.PATH ?? '').split(delimiter)).toEqual(EXTRA_PATH_DIRS)
  })

  it('preserves other env vars', () => {
    const result = augmentedPathEnv({ PATH: '/usr/bin', HOME: '/home/x' })

    expect(result.HOME).toBe('/home/x')
  })
})
