import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  hardenWindowsCacheAcl,
  hardenWindowsCacheAclWithIcacls,
  isTrustedWindowsCacheAcl,
  readWindowsCacheAcl,
  windowsCacheAclReadScript
} from './micromamba-cache'

// Each ACL call spawns a real PowerShell process; two cold-start module-discovery
// round-trips on a scrubbed CI runner can exceed Vitest's 15-second default.
const ACL_INTEGRATION_TIMEOUT_MS = 30_000

describe.runIf(process.platform === 'win32')('Windows micromamba cache ACL integration', () => {
  it(
    'reads a hardened ACL without automatic PowerShell module discovery',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'os-cache-acl-'))
      try {
        hardenWindowsCacheAcl(directory)

        const raw = execFileSync(
          join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; ${windowsCacheAclReadScript(directory)}`
          ],
          { encoding: 'utf8', windowsHide: true }
        )
        expect(isTrustedWindowsCacheAcl(JSON.parse(raw))).toBe(true)
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
import { execFileSync } from 'node:child_process'
