import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..')

describe('packaging config', () => {
  it('ships the exec-loop scripts unpacked from the asar', () => {
    // The notebook driver resolves <process.resourcesPath>/notebook/python_loop.py and
    // .../r_loop.R in the packaged app, so both must exist in the repo AND asarUnpack must cover
    // them (electron-builder only unpacks matched globs).
    expect(existsSync(join(repoRoot, 'resources/notebook/python_loop.py'))).toBe(true)
    expect(existsSync(join(repoRoot, 'resources/notebook/r_loop.R'))).toBe(true)
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/asarUnpack:\s*\n\s*-\s*resources\/(\*\*|notebook\/\*\*)/)
  })

  it('ships micromamba as a per-platform extraResource to Contents/Resources', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    // Staged per-platform binaries copied to the resources root under the name micromamba(.exe).
    expect(yml).toContain('resources/bin/mac/${arch}/micromamba')
    expect(yml).toContain('resources/bin/win/${arch}/micromamba.exe')
    expect(yml).toContain('resources/bin/linux/${arch}/micromamba')
    expect(yml).toContain('to: micromamba')
  })

  it('macOS entitlements disable library validation for conda dylibs', () => {
    const plist = readFileSync(join(repoRoot, 'build/entitlements.mac.plist'), 'utf8')
    expect(plist).toContain('com.apple.security.cs.disable-library-validation')
    expect(plist).toContain('com.apple.security.cs.allow-dyld-environment-variables')
    expect(plist).toContain('com.apple.security.cs.allow-jit')
    expect(plist).toContain('com.apple.security.cs.allow-unsigned-executable-memory')
  })

  it('the ad-hoc signer signs the bundled micromamba binary', () => {
    const hook = readFileSync(join(repoRoot, 'build/adhoc-sign.cjs'), 'utf8')
    expect(hook).toContain('micromamba')
  })
})
