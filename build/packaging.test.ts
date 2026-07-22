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

describe('NSIS installer include (build/installer.nsh)', () => {
  const include = readFileSync(join(repoRoot, 'build/installer.nsh'), 'utf8')

  it('overrides the failed-uninstall handling for both registry passes', () => {
    // electron-builder's handleUninstallResult turns ANY non-zero old-uninstaller exit code into
    // a fatal "Failed to uninstall old application files" dialog. The assisted installer
    // (oneClick: false) gets no exit-code normalization (quitSuccess is ONE_CLICK-only), so the
    // code is not trustworthy — the include must install the resilient handler for both the
    // SHELL_CONTEXT and the HKEY_CURRENT_USER passes.
    expect(include).toMatch(/!macro customUnInstallCheck\b/)
    expect(include).toMatch(/!macro customUnInstallCheckCurrentUser\b/)
  })

  it('continues the install when the old version is already gone despite a non-zero exit code', () => {
    // The spurious-exit-2 case: the uninstall completed but a benign trailing error leaked as the
    // process exit code. Detect it by the old executable no longer existing and keep installing.
    expect(include).toContain('${FileExists} "$appExe"')
  })

  it('force-kills install-dir processes and retries the old uninstaller once before failing', () => {
    // The real-lock case: a background child running from the install dir (micromamba
    // provisioning, the CLI in Node mode, an agent child) still holds files. Sweep by install-dir
    // path prefix (PowerShell) and by image name (taskkill fallback), then retry once; only a
    // repeated failure keeps the original fatal dialog + exit code 2.
    expect(include).toContain(`$$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')`)
    expect(include).toContain('taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"')
    expect(include).toContain(
      `ExecWait '"$PLUGINSDIR\\old-uninstaller.exe" /S /KEEP_APP_DATA $0 _?=$INSTDIR' $R0`
    )
    expect(include).toContain('$(uninstallFailed): $R0')
    expect(include).toContain('SetErrorLevel 2')
  })

  it('never references symbols declared only after handleUninstallResult is parsed', () => {
    // makensis treats unknown variables as errors (electron-builder builds with warnings as
    // errors): handleUninstallResult is parsed BEFORE uninstallOldVersion / CHECK_APP_RUNNING
    // declare their globals, so the hook body must stay self-contained. Comment lines are
    // stripped before checking — they may name the variables while explaining this.
    const code = include
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(code).not.toContain('$installationDir')
    expect(code).not.toContain('$uninstallerFileNameTemp')
    expect(code).not.toContain('$PowerShellPath')
    expect(code).not.toContain('$CmdPath')
    expect(code).not.toContain('$IsPowerShellAvailable')
    expect(code).not.toContain('IS_POWERSHELL_AVAILABLE')
    expect(code).not.toContain('KILL_PROCESS')
  })
})
