import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  WSL_SETUP_GUIDE_MAX_BYTES,
  loadWslSetupGuide,
  resolveWslSetupGuideCandidates
} from './wsl-setup-guide'

describe('WSL setup guide', () => {
  it('loads the checked-in versioned guide without depending on the working directory', async () => {
    const guide = await loadWslSetupGuide(resolveWslSetupGuideCandidates(undefined))

    expect(guide).toMatchObject({ id: 'wsl2-setup', version: '1', status: 'available' })
    expect(guide.markdown).toContain('wsl_setup_diagnostics({})')
  })

  it('explains the Windows prerequisite before recommending mirrored networking changes', async () => {
    const guide = await loadWslSetupGuide(resolveWslSetupGuideCandidates(undefined))

    expect(guide.status).toBe('available')
    expect(guide.markdown).toContain('Windows 11 22H2')
    expect(guide.markdown).toContain('windows.build')
    expect(guide.markdown).toContain(
      'On older Windows, direct the user to **Switch to PowerShell**'
    )
    expect(guide.markdown!.indexOf('Windows 11 22H2')).toBeLessThan(
      guide.markdown!.indexOf('setting `networkingMode=mirrored`')
    )
  })

  it('diagnoses a missing guide and a strict version mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wsl-guide-'))
    const wrong = join(root, 'wrong.md')
    await writeFile(wrong, '<!-- wsl-setup-guide-version: 2 -->\n# Wrong version\n')

    await expect(loadWslSetupGuide([join(root, 'missing.md')])).resolves.toMatchObject({
      status: 'missing'
    })
    await expect(loadWslSetupGuide([wrong])).resolves.toMatchObject({
      status: 'version-mismatch'
    })
  })

  it('rejects an oversized guide before loading it into the setup prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wsl-guide-'))
    const oversized = join(root, 'oversized.md')
    await writeFile(
      oversized,
      '<!-- wsl-setup-guide-version: 1 -->\n' + 'x'.repeat(WSL_SETUP_GUIDE_MAX_BYTES)
    )

    await expect(loadWslSetupGuide([oversized])).resolves.toMatchObject({
      status: 'version-mismatch'
    })
  })
})

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()
