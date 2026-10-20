import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

let script = resolve('build/windows-install-publication.ps1')
let helper: string
beforeAll(() => {
  if (process.platform !== 'win32') return
  const root = fixture().root
  helper = join(root, 'windows-install-publication.dll')
  createRequire(import.meta.url)('../build/compile-windows-install-publication.cjs')(
    resolve('build/windows-install-publication.cs'),
    helper
  )
  const source = readFileSync(script)
  script = join(root, 'windows-install-publication.ps1')
  writeFileSync(script, source)
}, 30_000)
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
)

// Node 24.14's native cpSync directory path corrupts Unicode on this Windows host. Individual
// fs calls preserve it. This only prepares fixtures; the native test executes NSIS CopyFiles.
function copyFixture(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) copyFixture(join(source, entry.name), join(target, entry.name))
    else writeFileSync(join(target, entry.name), readFileSync(join(source, entry.name)))
  }
}

function fixture(): { root: string; install: string; payload: string; state: string } {
  const parent = resolve('tmp/install-publication-tests')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'case-'))
  const install = join(root, 'installed app 中文')
  const payload = join(root, 'payload')
  mkdirSync(install)
  mkdirSync(join(payload, 'resources', 'backend'), { recursive: true })
  mkdirSync(join(payload, 'locales'))
  writeFileSync(join(payload, 'app.exe'), 'synthetic executable')
  writeFileSync(join(payload, 'resources', 'backend', 'index.js'), 'synthetic backend')
  writeFileSync(join(payload, 'locales', 'en.pak'), 'synthetic locale')
  return { root, install, payload, state: join(root, 'state.json') }
}

function action(
  f: ReturnType<typeof fixture>,
  operation: string,
  env = process.env
): SpawnSyncReturns<string> {
  const result = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Action',
      operation,
      '-InstallPath',
      f.install,
      '-StatePath',
      f.state
    ],
    {
      encoding: 'utf16le',
      windowsHide: true,
      env,
      timeout: 60_000
    }
  )
  writeFileSync(
    join(f.root, `${operation}-${Date.now()}.json`),
    JSON.stringify({
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message
    })
  )
  expect(result.error).toBeUndefined()
  return result
}

function setFixtureAcl(path: string, nonPropagating = false): void {
  const script = `$path='${path.replaceAll("'", "''")}'; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); ${nonPropagating ? "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadAndExecute','ContainerInherit,ObjectInherit','NoPropagateInherit','Allow'));" : ''} [IO.Directory]::SetAccessControl($path,$acl)`
  const result = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}

describe.skipIf(process.platform !== 'win32')('real Windows payload publication', () => {
  it('prepares and cleans up with a Unicode temporary profile', () => {
    const f = fixture()
    const temporary = join(f.root, 'profile 数据 with spaces', 'Temp')
    mkdirSync(temporary, { recursive: true })
    const env = { ...process.env, TEMP: temporary, TMP: temporary }
    f.state = join(temporary, 'state.json')
    const prepared = action(f, 'prepare', env)
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0)
    expect(prepared.stdout).toBe(JSON.parse(readFileSync(f.state, 'utf8')).stage)
    expect(action(f, 'cleanup', env).status).toBe(0)
  }, 30_000)

  it.skipIf(process.env.OPEN_SCIENCE_INSTALL_PUBLICATION_NATIVE !== '1')(
    'moves eligible directories and rejects changed ACLs under an ordinary user',
    async () => {
      const f = fixture()
      setFixtureAcl(f.install)

      expect(action(f, 'prepare').status).toBe(0)
      const state = JSON.parse(readFileSync(f.state, 'utf8'))
      expect(state.useMove).toBe(true)
      copyFixture(f.payload, state.stage)

      expect(action(f, 'publish').status).toBe(0)
      expect(existsSync(join(state.stage, 'resources'))).toBe(false)
      expect(readFileSync(join(f.install, 'resources/backend/index.js'), 'utf8')).toBe(
        'synthetic backend'
      )
      copyFixture(state.stage, f.install)

      expect(action(f, 'cleanup').status).toBe(0)

      const other = fixture()
      setFixtureAcl(other.install)
      expect(action(other, 'prepare').status).toBe(0)
      setFixtureAcl(other.install, true)
      expect(action(other, 'publish').status).toBe(20)
      expect(action(other, 'cleanup').status).toBe(0)
    },
    60_000
  )

  it('keeps non-propagating ACLs on the copy path without changing those ACLs', () => {
    const f = fixture()
    setFixtureAcl(f.install, true)
    expect(action(f, 'prepare').status).toBe(0)
    const state = JSON.parse(readFileSync(f.state, 'utf8'))
    expect(state.useMove).toBe(false)
    expect(action(f, 'cleanup').status).toBe(0)
  }, 30_000)

  it.skipIf(process.env.OPEN_SCIENCE_INSTALL_PUBLICATION_NATIVE !== '1')(
    'retries the remaining directory after a locked second directory fails publication',
    async () => {
      const f = fixture()
      setFixtureAcl(f.install)

      expect(action(f, 'prepare').status).toBe(0)
      const state = JSON.parse(readFileSync(f.state, 'utf8'))
      expect(state.useMove).toBe(true)
      copyFixture(f.payload, state.stage)

      const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
      const command = `$stream=[IO.File]::Open(${quote(join(state.stage, 'locales/en.pak'))},'Open','Read','Read'); try { & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(script)} -Action publish -InstallPath ${quote(f.install)} -StatePath ${quote(f.state)}; $code=$LASTEXITCODE } finally { $stream.Dispose() }; exit $code`
      const failed = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64')
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
      )
      expect(failed.error).toBeUndefined()
      expect(failed.status).toBe(20)
      expect(existsSync(join(f.install, 'resources/backend/index.js'))).toBe(true)
      expect(existsSync(join(state.stage, 'locales/en.pak'))).toBe(true)

      expect(action(f, 'publish').status).toBe(0)
      copyFixture(state.stage, f.install)

      expect(action(f, 'cleanup').status).toBe(0)
    },
    60_000
  )
  it('publishes files and removes only its own staging', async () => {
    const f = fixture()

    expect(action(f, 'prepare').status).toBe(0)
    const { stage } = JSON.parse(readFileSync(f.state, 'utf8'))
    const unrelated = join(f.install, '.open-science-install-00000000000000000000000000000000')
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, 'untouched'), 'another run')
    copyFixture(f.payload, stage)

    expect(action(f, 'publish').status).toBe(0)
    copyFixture(stage, f.install)

    expect(action(f, 'cleanup').status).toBe(0)
    expect(existsSync(stage)).toBe(false)
    expect(existsSync(f.state)).toBe(false)
    expect(readFileSync(join(unrelated, 'untouched'), 'utf8')).toBe('another run')
  }, 60_000)

  it('refuses cleanup when the staging directory identity has been replaced', async () => {
    const f = fixture()
    expect(action(f, 'prepare').status).toBe(0)
    const state = JSON.parse(readFileSync(f.state, 'utf8'))
    state.stageIdentity = 'wrong identity'
    writeFileSync(f.state, JSON.stringify(state))
    writeFileSync(join(state.stage, 'preserve.txt'), 'preserve on uncertainty')
    expect(action(f, 'cleanup').status).toBe(20)
    expect(readFileSync(join(state.stage, 'preserve.txt'), 'utf8')).toBe('preserve on uncertainty')
  }, 60_000)

  it('rejects a junction in staging without deleting its target', async () => {
    const f = fixture()
    expect(action(f, 'prepare').status).toBe(0)
    const { stage } = JSON.parse(readFileSync(f.state, 'utf8'))
    const junction = join(stage, 'external')
    symlinkSync(f.payload, junction, 'junction')

    expect(action(f, 'publish').status).toBe(20)
    expect(action(f, 'cleanup').status).toBe(20)
    expect(readFileSync(join(f.payload, 'app.exe'), 'utf8')).toBe('synthetic executable')
    // Remove only the fixture-created link. Production deliberately preserves an unsafe tree.
    unlinkSync(junction)
    expect(action(f, 'cleanup').status).toBe(0)
  }, 60_000)

  it('keeps an interrupted run separate from a later successful publication', async () => {
    const f = fixture()
    expect(action(f, 'prepare').status).toBe(0)
    const interrupted = JSON.parse(readFileSync(f.state, 'utf8'))
    writeFileSync(join(interrupted.stage, 'partial.bin'), 'incomplete extraction')
    mkdirSync(join(f.root, 'next-installer'))
    const next = { ...f, state: join(f.root, 'next-installer/state.json') }
    expect(action(next, 'prepare').status).toBe(0)
    const current = JSON.parse(readFileSync(next.state, 'utf8'))
    expect(current.stage).not.toBe(interrupted.stage)

    copyFixture(f.payload, current.stage)

    expect(action(next, 'publish').status).toBe(0)
    copyFixture(current.stage, f.install)

    expect(action(next, 'cleanup').status).toBe(0)
    expect(readFileSync(join(interrupted.stage, 'partial.bin'), 'utf8')).toBe(
      'incomplete extraction'
    )
    // The original owner can clean up; the new run must never infer ownership from a prefix.
    expect(action(f, 'cleanup').status).toBe(0)
  }, 60_000)
})

const compiler = process.env.OPEN_SCIENCE_MAKENSIS
const sevenZip = process.env.OPEN_SCIENCE_7ZA
describe.skipIf(process.platform !== 'win32' || !compiler || !sevenZip)(
  'native NSIS extraction and publication',
  () => {
    it.each([
      'valid',
      'unicode-profile',
      'copy-fallback',
      'truncated',
      'corrupt',
      'long-path',
      'long-copy-fallback',
      'locked-root',
      'warning',
      'cancelled',
      'launch-failure',
      'fallback-boundary',
      'universal-x64'
    ])(
      'handles %s archives through the production installer macro',
      async (mode) => {
        const f = fixture()
        setFixtureAcl(
          f.install,
          mode === 'copy-fallback' || mode === 'long-copy-fallback' || mode === 'fallback-boundary'
        )
        const boundaryRelative = 'resources/' + 'nested-'.repeat(7) + 'leaf.txt'
        const temporary = join(
          f.root,
          mode === 'unicode-profile' ? 'profile 数据 with spaces/Temp' : 'temp-' + 't'.repeat(45)
        )
        if (mode === 'unicode-profile') mkdirSync(temporary, { recursive: true })
        if (mode === 'fallback-boundary') {
          mkdirSync(temporary)
          mkdirSync(join(f.payload, boundaryRelative, '..'), { recursive: true })
          writeFileSync(join(f.payload, boundaryRelative), 'fallback boundary payload')
        }

        const longRelative = 'resources/' + 'nested-folder-'.repeat(10) + '/leaf.txt'
        if (mode.startsWith('long-')) {
          mkdirSync(join(f.payload, longRelative, '..'), { recursive: true })
          writeFileSync(join(f.payload, longRelative), 'long path payload')
        }
        const archive = join(f.root, 'payload.7z')
        const pack = spawnSync(sevenZip!, ['a', '-t7z', '-m0=lzma2', '-mf=off', archive, '.'], {
          cwd: f.payload,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000
        })
        expect(pack.status, pack.stdout + pack.stderr).toBe(0)
        if (mode === 'truncated') writeFileSync(archive, readFileSync(archive).subarray(0, 40))
        if (mode === 'corrupt') {
          const bytes = readFileSync(archive)
          bytes[40] ^= 0xff
          writeFileSync(archive, bytes)
        }
        const extractorDirectory = join(f.root, 'out/windows-installer/x64')
        mkdirSync(extractorDirectory, { recursive: true })
        const extractor = join(extractorDirectory, '7za.exe')
        writeFileSync(extractor, readFileSync(sevenZip!))
        writeFileSync(
          join(extractorDirectory, 'windows-install-publication.dll'),
          readFileSync(helper)
        )
        if (mode === 'universal-x64') {
          mkdirSync(join(f.root, 'out/windows-installer/arm64'), { recursive: true })
          // Wrong selection must fail to launch instead of accidentally passing on x64.
          writeFileSync(join(f.root, 'out/windows-installer/arm64/7za.exe'), 'not an x64 tool')
          writeFileSync(
            join(f.root, 'out/windows-installer/arm64/windows-install-publication.dll'),
            'wrong helper'
          )
        }
        if (mode === 'launch-failure') writeFileSync(extractor, 'not an executable')
        if (mode === 'warning' || mode === 'cancelled') {
          const decoderSource = join(f.root, 'decoder.nsi')
          writeFileSync(
            decoderSource,
            [
              'Unicode true',
              'RequestExecutionLevel user',
              'SilentInstall silent',
              'OutFile "' + extractor + '"',
              'Section',
              'SetErrorLevel ' + (mode === 'warning' ? 1 : 255),
              'SectionEnd'
            ].join('\n')
          )
          const decoder = spawnSync(compiler!, ['/V2', decoderSource], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000
          })
          expect(decoder.status, decoder.stdout + decoder.stderr).toBe(0)
        }
        const source = join(f.root, 'fixture.nsi')
        const exe = join(f.root, 'fixture.exe')
        writeFileSync(
          source,
          '\ufeff' +
            [
              'Unicode true',
              'RequestExecutionLevel user',
              'SilentInstall silent',
              `OutFile "${exe}"`,
              '!include LogicLib.nsh',
              `!define PROJECT_DIR "${f.root}"`,
              `!define APP_64 "${archive}"`,
              ...(mode === 'universal-x64' ? [`!define APP_ARM64 "${archive}"`] : []),
              `!define BUILD_RESOURCES_DIR "${resolve('build')}"`,
              '!macro quitFailedUpdate',
              'FileOpen $0 "$EXEDIR\\failure.txt" w',
              'FileWrite $0 "$publicationResult $publicationOutput | stage=$publicationDirectory"',
              'FileClose $0',
              'Call cleanupInstallPublication',
              'SetErrorLevel 2',
              'Quit',
              '!macroend',
              `!include "${resolve('build/windows-install-publication.nsh')}"`,
              `!include "${resolve('node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh')}"`,
              'LangString appCannotBeClosed 1033 "Cannot replace files"',
              'Section',
              'InitPluginsDir',
              'FileOpen $0 "$EXEDIR\\plugin-directory.txt" w',
              'FileWrite $0 "$PLUGINSDIR"',
              'FileClose $0',
              `StrCpy $INSTDIR "${f.install}"`,
              'SetOutPath "$INSTDIR"',
              `!insertmacro extractUsing7za "${archive}"`,
              'FileOpen $0 "$EXEDIR\\success.txt" w',
              'FileWrite $0 "complete"',
              'FileClose $0',
              'SetErrorLevel 0',
              'SectionEnd'
            ].join('\n')
        )
        const compile = spawnSync(compiler!, ['/V2', source], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000
        })
        writeFileSync(join(f.root, 'compile.log'), compile.stdout + compile.stderr)
        expect(compile.status, compile.stdout + compile.stderr).toBe(0)
        const run =
          mode === 'locked-root'
            ? (() => {
                const target = join(f.install, 'app.exe')
                writeFileSync(target, 'occupied original')
                const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
                const hold = `$stream=[IO.File]::Open(${quote(target)},'Open','Read','Read'); try { $p=Start-Process -FilePath ${quote(exe)} -WindowStyle Hidden -PassThru; if (!$p.WaitForExit(50000)) { throw 'Native fixture did not exit' }; $code=$p.ExitCode } finally { $stream.Dispose() }; exit $code`
                return spawnSync(
                  powershell,
                  [
                    '-NoProfile',
                    '-NonInteractive',
                    '-EncodedCommand',
                    Buffer.from(hold, 'utf16le').toString('base64')
                  ],
                  { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
                )
              })()
            : spawnSync(exe, [], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 60_000,
                ...(['fallback-boundary', 'unicode-profile'].includes(mode)
                  ? { env: { ...process.env, TEMP: temporary, TMP: temporary } }
                  : {})
              })
        writeFileSync(
          join(f.root, 'run.json'),
          JSON.stringify({ code: run.status, error: run.error?.message })
        )
        expect(run.error).toBeUndefined()
        const success = [
          'valid',
          'unicode-profile',
          'copy-fallback',
          'long-path',
          'fallback-boundary',
          'universal-x64'
        ].includes(mode)
        expect(
          run.status,
          existsSync(join(f.root, 'failure.txt'))
            ? readFileSync(join(f.root, 'failure.txt'), 'utf8')
            : run.stdout + run.stderr
        ).toBe(success ? 0 : 2)
        expect(existsSync(join(f.root, 'success.txt'))).toBe(success)
        expect(
          readdirSync(f.install).filter((name) => name.startsWith('.open-science-install-'))
        ).toEqual([])
        if (success)
          expect(readFileSync(join(f.install, 'resources/backend/index.js'), 'utf8')).toBe(
            'synthetic backend'
          )
        if (mode === 'long-path')
          expect(readFileSync(join(f.install, longRelative), 'utf8')).toBe('long path payload')
        if (mode === 'fallback-boundary') {
          const pluginDirectory = readFileSync(join(f.root, 'plugin-directory.txt'), 'utf8')
          expect(join(pluginDirectory, '7z-out', boundaryRelative).length).toBeLessThan(260)
          expect(
            join(pluginDirectory, '.open-science-install-' + '0'.repeat(32), boundaryRelative)
              .length
          ).toBeGreaterThan(260)
          expect(readFileSync(join(f.install, boundaryRelative), 'utf8')).toBe(
            'fallback boundary payload'
          )
        }
        if (mode === 'locked-root') {
          expect(readFileSync(join(f.install, 'app.exe'), 'utf8')).toBe('occupied original')
          expect(readFileSync(join(f.install, 'resources/backend/index.js'), 'utf8')).toBe(
            'synthetic backend'
          )
          // A later installer must copy the whole payload, not skip previously moved directories
          // or regard the failed run as ready.
          const retry = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
          expect(retry.error).toBeUndefined()
          expect(retry.status).toBe(0)
          expect(readFileSync(join(f.install, 'app.exe'), 'utf8')).toBe('synthetic executable')
          expect(existsSync(join(f.root, 'success.txt'))).toBe(true)
          expect(
            readdirSync(f.install).filter((name) => name.startsWith('.open-science-install-'))
          ).toEqual([])
        }
      },
      90_000
    )
  }
)
