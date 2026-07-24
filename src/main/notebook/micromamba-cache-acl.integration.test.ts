import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  hardenWindowsCacheAcl,
  isTrustedWindowsCacheAcl,
  readWindowsCacheAcl
} from './micromamba-cache'

describe.runIf(process.platform === 'win32')('Windows micromamba cache ACL integration', () => {
  it('applies an ACL accepted by the production trust verifier', () => {
    const directory = mkdtempSync(join(tmpdir(), 'os-cache-acl-'))
    try {
      hardenWindowsCacheAcl(directory)

      expect(isTrustedWindowsCacheAcl(readWindowsCacheAcl(directory))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
