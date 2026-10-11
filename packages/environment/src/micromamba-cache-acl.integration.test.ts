import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  hardenWindowsCacheAcl,
  hardenWindowsCacheAclWithIcacls,
  isTrustedWindowsCacheAcl,
  readWindowsCacheAcl
} from './micromamba-cache'

// Each ACL call spawns a real PowerShell process; two cold-start module-discovery
// round-trips on a scrubbed CI runner can exceed Vitest's 15-second default.
const ACL_INTEGRATION_TIMEOUT_MS = 30_000

describe.runIf(process.platform === 'win32')('Windows micromamba cache ACL integration', () => {
  it(
    'applies an ACL accepted by the production trust verifier',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'os-cache-acl-'))
      try {
        hardenWindowsCacheAcl(directory)

        expect(isTrustedWindowsCacheAcl(readWindowsCacheAcl(directory))).toBe(true)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    ACL_INTEGRATION_TIMEOUT_MS
  )

  it(
    'applies a fallback ACL accepted by the production trust verifier',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'os-cache-icacls-'))
      try {
        hardenWindowsCacheAclWithIcacls(directory)

        expect(isTrustedWindowsCacheAcl(readWindowsCacheAcl(directory))).toBe(true)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    ACL_INTEGRATION_TIMEOUT_MS
  )
})
