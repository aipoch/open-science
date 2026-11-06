import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { denyFixturePublication, startOrdinaryShortcut } from './windows-updater-certification.mjs'
import { runProcess, waitFor } from './windows-installer-smoke.mjs'

describe.skipIf(process.platform !== 'win32')('native Windows certification fault controls', () => {
  it('allows old payload deletion while denying replacement and restores the exact original ACL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'certification-publication-'))
    const install = join(root, 'installation')
    await mkdir(install)
    const application = join(install, 'open-science.exe')
    await copyFile(process.execPath, application)
    let fault: Awaited<ReturnType<typeof denyFixturePublication>> | undefined
    const descriptor = async (): Promise<string> =>
      (
        await runProcess(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[IO.Directory]::GetAccessControl($env:CERT_ROOT).Sddl'
          ],
          { env: { ...process.env, CERT_ROOT: install } }
        )
      ).stdout.trim()
    const original = await descriptor()
    try {
      fault = await denyFixturePublication({ installDirectory: install, root })
      await unlink(application)
      await expect(writeFile(application, 'replacement')).rejects.toThrow()
      await fault.restore()
      expect(await descriptor()).toBe(original)
      await writeFile(application, 'replacement after fault release')
      expect(await readFile(application, 'utf8')).toBe('replacement after fault release')
    } finally {
      await fault?.restore()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 60_000)

  it('compiles the linked/restricted-token launcher on the actual Windows framework', async () => {
    await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        String.raw`
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText($env:CERT_SCRIPT)
foreach($match in [regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")) {
  Add-Type -TypeDefinition $match.Groups[1].Value
}
if(-not ('CertificationMediumLaunch' -as [type])) { throw 'Native launcher was not compiled' }
`
      ],
      { env: { ...process.env, CERT_SCRIPT: resolve('scripts/windows-certification-faults.ps1') } }
    )
  }, 30_000)

  it('opens the unchanged ordinary shortcut without adding a recovery argument', async () => {
    const root = await mkdtemp(join(tmpdir(), 'certification-shortcut-'))
    const executable = join(root, 'fixture.exe')
    const script = join(root, 'application.cjs')
    const marker = join(root, 'ordinary-launch')
    const shortcut = join(root, 'original.lnk')
    try {
      await copyFile(process.execPath, executable)
      await writeFile(
        script,
        `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))`
      )
      await runProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($env:CERT_LINK); $link.TargetPath=$env:CERT_EXE; $link.Arguments='\"'+$env:CERT_APP+'\"'; $link.Save()"
        ],
        {
          env: { ...process.env, CERT_LINK: shortcut, CERT_EXE: executable, CERT_APP: script }
        }
      )
      const sha256 = createHash('sha256')
        .update(await readFile(shortcut))
        .digest('hex')
      await expect(startOrdinaryShortcut({ path: shortcut, sha256 })).resolves.toMatchObject({
        ordinaryShortcut: true,
        administrator: false
      })
      await waitFor(
        'the ordinary fixture application',
        async () => (await readFile(marker, 'utf8')) === '[]' || undefined
      )
      await expect(startOrdinaryShortcut({ path: shortcut, sha256: 'changed' })).rejects.toThrow(
        /removed or changed/
      )
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 60_000)
})
