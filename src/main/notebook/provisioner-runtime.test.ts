import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { md5File, runMicromamba, verifyExecutable } from './provisioner-runtime'

describe('verifyExecutable', () => {
  it('resolves for a real interpreter that answers --version', async () => {
    // node itself answers `--version`; use it as a stand-in executable.
    await expect(verifyExecutable(process.execPath)).resolves.toBeUndefined()
  })

  it('rejects for a missing executable', async () => {
    await expect(verifyExecutable('/no/such/binary-xyz')).rejects.toThrow()
  })
})

describe('md5File', () => {
  it('computes the md5 hex of file contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'os-md5-'))
    const file = join(dir, 'f')
    writeFileSync(file, 'abc')
    // md5("abc") = 900150983cd24fb0d6963f7d28e17f72
    await expect(md5File(file)).resolves.toBe('900150983cd24fb0d6963f7d28e17f72')
  })
})

describe('runMicromamba', () => {
  it('resolves on a zero-exit argv', async () => {
    // node (process.execPath) is a cross-platform zero-exit stand-in for the micromamba binary.
    await expect(
      runMicromamba([process.execPath, '-e', 'process.exit(0)'])
    ).resolves.toBeUndefined()
  })

  it('rejects with a stderr summary on non-zero exit', async () => {
    await expect(
      runMicromamba([process.execPath, '-e', 'process.stderr.write("boom"); process.exit(3)'])
    ).rejects.toThrow(/boom/)
  })
})
