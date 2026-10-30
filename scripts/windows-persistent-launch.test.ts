import { execFileSync, spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
function find(directory: string, name: string): string | undefined {
  if (!existsSync(directory)) return undefined
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name)
    if (entry.isFile() && entry.name === name) return candidate
    if (entry.isDirectory()) {
      const result = find(candidate, name)
      if (result) return result
    }
  }
  return undefined
}
const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder/Cache')
const compiler = process.platform === 'win32' ? find(cache, 'makensis.exe') : undefined
const plugin = process.platform === 'win32' ? find(cache, 'StdUtils.dll') : undefined

describe.skipIf(!compiler || !plugin)('ordinary persistent NSIS launch entry', () => {
  it.each(['missing', 'corrupt'])(
    'recovers a missing fixture executable with a %s cache from its original shortcut',
    async (cacheState) => {
      const root = mkdtempSync(join(tmpdir(), 'persistent-launch-'))
      const install = join(root, 'application space İ 科学'),
        profile = join(root, 'profile'),
        shortcut = join(root, 'Science.lnk')
      const otherInstall = join(root, 'other installation')
      mkdirSync(otherInstall)
      writeFileSync(join(otherInstall, 'sentinel.txt'), 'other installation')
      mkdirSync(install)
      mkdirSync(profile)
      const helper = join(root, 'out/windows-installer/ia32/windows-installation-processes.exe')
      require('../build/compile-windows-installation-processes.cjs')(helper)
      const run = (file: string, args: string[]): string =>
        execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 })
      const recovery = run(helper, ['recovery-directory', install, process.env.APPDATA!])
      const operation = randomUUID(),
        operationRoot = join(dirname(dirname(recovery)), operation)
      const replacementOperation = randomUUID(),
        replacementRoot = join(dirname(operationRoot), replacementOperation)
      const pending = join(recovery, 'update.ini'),
        ready = join(profile, 'ready')
      let payload = Buffer.alloc(0)
      const pendingPayloads: ServerResponse[] = []
      const requests: string[] = []
      const server = createServer((request, response) => {
        requests.push(request.url!)
        if (request.url === '/download') {
          response.writeHead(302, {
            Location: `http://localhost:${(server.address() as { port: number }).port}/payload`
          })
          response.end()
        } else if (request.url === '/payload') {
          pendingPayloads.push(response)
        } else {
          response.writeHead(404)
          response.end()
        }
      })
      server.listen(0)
      await once(server, 'listening')
      const installerUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/download`
      const releaseOtherWriter = join(otherInstall, 'release-writer')
      let otherWriter: ChildProcess | undefined
      const started = join(profile, 'started'),
        allowReady = join(profile, 'allow-ready'),
        joined = join(profile, 'joined'),
        installations = join(profile, 'installations')
      writeFileSync(join(profile, 'saved-notebook.txt'), 'durable fixture data')
      const hash = (path: string, algorithm: string): string =>
        createHash(algorithm).update(readFileSync(path)).digest('hex')
      const ini = (path: string, contents: string): void =>
        writeFileSync(path, '\uFEFF' + contents, 'utf16le')
      function build(version: string): string {
        const appSource = join(root, `app-${version}.cs`),
          app = join(root, `app-${version}.exe`),
          setup = join(root, `setup-${version}.exe`)
        writeFileSync(
          appSource,
          version === '1'
            ? `using System.IO;class P{static void Main(){File.Delete(@"${pending}");File.WriteAllText(@"${ready}","${version}");}}`
            : `using System;using System.IO;using System.Threading;class P{static void Main(){bool first;using(var m=new Mutex(true,"${operation}-app",out first)){if(!first){File.WriteAllText(@"${joined}",String.Join("|",Environment.GetCommandLineArgs()));return;}File.WriteAllText(@"${started}","started");while(!File.Exists(@"${allowReady}"))Thread.Sleep(20);File.WriteAllText(@"${join(operationRoot, 'ready.receipt')}","${operation}\\r\\nready\\r\\n");File.Delete(@"${pending}");File.WriteAllText(@"${ready}","2");}}}`
        )
        run(join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'), [
          '/nologo',
          `/out:${app}`,
          appSource
        ])
        const source = join(root, `setup-${version}.nsi`)
        writeFileSync(
          source,
          '\uFEFF' +
            [
              'Unicode true',
              'RequestExecutionLevel user',
              'SilentInstall silent',
              `OutFile "${setup}"`,
              `InstallDir "${version === '1' ? install : otherInstall}"`,
              `!addincludedir "${resolve('node_modules/app-builder-lib/templates/nsis/include')}"`,
              `!addplugindir "${dirname(plugin!).replace('x86-ansi', 'x86-unicode')}"`,
              '!include LogicLib.nsh',
              '!include FileFunc.nsh',
              '!include StdUtils.nsh',
              `!define PROJECT_DIR "${root}"`,
              '!define APP_EXECUTABLE_FILENAME "Open-Science.exe"',
              '!define APP_DESCRIPTION "Fixture"',
              `!define APP_GUID "${operation}"`,
              '!define isUpdated "1 == 1"',
              'Var newStartMenuLink',
              'Var newDesktopLink',
              'Var launchLink',
              'Var installMode',
              '!macro quitFailedUpdate',
              'SetErrorLevel 2',
              'Quit',
              '!macroend',
              `!include "${resolve('build/windows-app-running.nsh')}"`,
              `!include "${resolve('build/windows-installation-launch.nsh')}"`,
              '!insertmacro definePersistentLaunchFunctions',
              'Function .onInit',
              '!insertmacro preInit',
              `System::Call 'kernel32::CreateMutex(p0, i1, t"${operation}")?e'`,
              'Pop $0',
              '${If} $0 == 183',
              'Quit',
              '${EndIf}',
              'FunctionEnd',
              'Section',
              'SetOutPath "$INSTDIR"',
              `File /oname=Open-Science.exe "${app}"`,
              `StrCpy $newStartMenuLink "${shortcut}"`,
              `CreateShortCut "${shortcut}" "$INSTDIR\\Open-Science.exe"`,
              'StrCpy $installMode "CurrentUser"',
              'Call installPersistentLaunch',
              ...(version === '2'
                ? [
                    `FileOpen $R0 "${join(operationRoot, 'installed.receipt')}" w`,
                    `FileWrite $R0 "${operation}$\\r$\\ninstalled$\\r$\\n"`,
                    'FileClose $R0',
                    `FileOpen $R0 "${installations}" a`,
                    'FileWrite $R0 "installed$\\r$\\n"',
                    'FileClose $R0'
                  ]
                : []),
              'Exec \'"$launchLink"\'',
              'SectionEnd'
            ].join('\n')
        )
        run(compiler!, ['/V2', source])
        return setup
      }
      try {
        const first = build('1'),
          target = build('2')
        payload = readFileSync(target)
        run(first, ['/S'])
        await expect
          .poll(() => (existsSync(ready) ? readFileSync(ready, 'utf8') : ''), { timeout: 10000 })
          .toBe('1')
        const launch = readFileSync(join(recovery, 'launch.ini'), 'utf16le')
        expect(launch).toContain(`applicationPath=${join(install, 'Open-Science.exe')}`)
        const originalEntry = /launcherPath=(.+)\r/.exec(launch)![1]
        expect(existsSync(originalEntry)).toBe(true)
        mkdirSync(operationRoot)
        const installer = join(operationRoot, 'installer.exe'),
          request = join(operationRoot, 'bound-request.json')
        writeFileSync(installer, readFileSync(target))
        writeFileSync(
          request,
          JSON.stringify({
            operationId: operation,
            applicationPath: join(install, 'Open-Science.exe'),
            installerPath: installer,
            installerUrl,
            installerSha256: hash(target, 'sha256'),
            targetVersion: '2'
          })
        )
        ini(
          pending,
          `[update]\r\noperationId=${operation}\r\napplicationPath=${join(install, 'Open-Science.exe')}\r\ninstallerPath=${installer}\r\ninstallerUrl=${installerUrl}\r\ninstallerSha256=${hash(target, 'sha256')}\r\nsha512Hex=${hash(target, 'sha512')}\r\nrequestPath=${request}\r\nrequestSha256=${hash(request, 'sha256')}\r\n`
        )
        const pendingBytes = readFileSync(pending)
        if (cacheState === 'missing') unlinkSync(installer)
        else writeFileSync(installer, 'corrupt cache')
        await expect
          .poll(() => spawnSync(helper, ['check', install], { windowsHide: true }).status, {
            timeout: 10000
          })
          .toBe(0)
        const executable = resolve(install, 'Open-Science.exe')
        expect(executable.startsWith(resolve(root) + sep)).toBe(true)
        unlinkSync(executable)
        unlinkSync(ready)
        const writerSource = join(otherInstall, 'writer.cs'),
          writerExe = join(otherInstall, 'writer.exe')
        writeFileSync(
          writerSource,
          `using System;using System.IO;using System.Threading;class W{static void Main(string[] a){using(var m=new Mutex(true,a.Length>0?a[0]:"${operation}")){Console.WriteLine("ready");while(!File.Exists(@"${releaseOtherWriter}"))Thread.Sleep(20);}}}`
        )
        run(join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'), [
          '/nologo',
          `/out:${writerExe}`,
          writerSource
        ])
        otherWriter = spawn(writerExe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        await once(otherWriter.stdout!, 'data')
        run(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${shortcut.replaceAll("'", "''")}' -WindowStyle Hidden`
        ])
        await expect
          .poll(() => JSON.parse(run(helper, ['query', recovery])).processes.length, {
            timeout: 10000
          })
          .toBeGreaterThan(0)
        // Hold the other installation's writer at a test-controlled barrier. This launch must
        // remain an observer; releasing that writer must continue this same launch automatically.
        await new Promise((resolve) => setTimeout(resolve, 1000))
        expect(JSON.parse(run(helper, ['query', recovery])).processes.length).toBeGreaterThan(0)
        expect(existsSync(installations)).toBe(false)
        expect(requests).toEqual([])
        const writerClosed = once(otherWriter, 'close')
        writeFileSync(releaseOtherWriter, 'release')
        await writerClosed
        await expect.poll(() => pendingPayloads.length, { timeout: 10000 }).toBe(1)
        // A second ordinary entry arrives while the original download is paused. The retained
        // operation mutex must prevent concurrent writes to the same repair package.
        run(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${shortcut.replaceAll("'", "''")}' -WindowStyle Hidden`
        ])
        await expect
          .poll(() => JSON.parse(run(helper, ['query', recovery])).processes.length, {
            timeout: 10000
          })
          .toBeGreaterThanOrEqual(2)
        expect(requests).toEqual(['/download', '/payload'])
        for (const response of pendingPayloads) {
          response.writeHead(200, { 'Content-Length': payload.length })
          response.end(payload)
        }
        await expect.poll(() => existsSync(started), { timeout: 15000 }).toBe(true)
        await expect
          .poll(() => JSON.parse(run(helper, ['writer-active', operation])).active, {
            timeout: 10000
          })
          .toBe(false)
        expect(existsSync(ready)).toBe(false)
        expect(existsSync(pending)).toBe(true)
        expect(requests).toEqual(['/download', '/payload'])
        expect(hash(installer, 'sha512')).toBe(hash(target, 'sha512'))
        unlinkSync(installer)
        // The target is live but deliberately has not acknowledged ready; another normal launch
        // must join it with the same operation/profile instead of entering a second installer.
        run(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${shortcut.replaceAll("'", "''")}' -WindowStyle Hidden`
        ])
        await expect.poll(() => existsSync(joined), { timeout: 10000 }).toBe(true)
        expect(readFileSync(joined, 'utf8')).toContain(
          `--open-science-update-operation=${operation}`
        )
        expect(readFileSync(installations, 'utf8')).toBe('installed\r\n')
        writeFileSync(allowReady, 'allow')
        await expect
          .poll(() => (existsSync(ready) ? readFileSync(ready, 'utf8') : ''), { timeout: 15000 })
          .toBe('2')
        expect(readFileSync(join(profile, 'saved-notebook.txt'), 'utf8')).toBe(
          'durable fixture data'
        )
        expect(readFileSync(join(recovery, 'launch.ini'), 'utf16le')).not.toContain(originalEntry)
        expect(existsSync(pending)).toBe(false)
        expect(readFileSync(join(otherInstall, 'sentinel.txt'), 'utf8')).toBe('other installation')
        expect(existsSync(join(otherInstall, 'Open-Science.exe'))).toBe(false)
        await expect
          .poll(() => spawnSync(helper, ['check', root], { windowsHide: true }).status, {
            timeout: 10000
          })
          .toBe(0)
        // Simulate ready's best-effort index deletion failing after terminal package cleanup.
        writeFileSync(pending, pendingBytes)
        unlinkSync(ready)
        run(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${shortcut.replaceAll("'", "''")}' -WindowStyle Hidden`
        ])
        await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true)
        expect(requests).toEqual(['/download', '/payload'])
        expect(readFileSync(installations, 'utf8')).toBe('installed\r\n')
        await expect
          .poll(() => spawnSync(helper, ['check', root], { windowsHide: true }).status, {
            timeout: 10000
          })
          .toBe(0)
        // Hold the per-operation mutex while the ordinary entry observes the old index. Ready
        // may remove it, or the next admission may replace it, before that entry obtains the lock.
        writeFileSync(pending, pendingBytes)
        unlinkSync(ready)
        unlinkSync(releaseOtherWriter)
        otherWriter = spawn(writerExe, [`OpenScienceRecovery-${operation}`], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        await once(otherWriter.stdout!, 'data')
        run(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${shortcut.replaceAll("'", "''")}' -WindowStyle Hidden`
        ])
        await expect
          .poll(() => JSON.parse(run(helper, ['query', recovery])).processes.length, {
            timeout: 10000
          })
          .toBeGreaterThan(0)
        await new Promise((resolve) => setTimeout(resolve, 1000))
        expect(existsSync(ready)).toBe(false)
        if (cacheState === 'missing') {
          unlinkSync(pending)
        } else {
          mkdirSync(replacementRoot)
          const replacementRequest = join(replacementRoot, 'bound-request.json')
          writeFileSync(
            replacementRequest,
            JSON.stringify({
              ...JSON.parse(readFileSync(request, 'utf8')),
              operationId: replacementOperation,
              installerPath: join(replacementRoot, 'installer.exe')
            })
          )
          for (const stage of ['installed', 'ready'])
            writeFileSync(
              join(replacementRoot, `${stage}.receipt`),
              `${replacementOperation}\r\n${stage}\r\n`
            )
          writeFileSync(
            pending,
            pendingBytes
              .toString('utf16le')
              .replaceAll(operation, replacementOperation)
              .replace(hash(request, 'sha256'), hash(replacementRequest, 'sha256')),
            'utf16le'
          )
        }
        const recoveryReleased = once(otherWriter, 'close')
        writeFileSync(releaseOtherWriter, 'release')
        await recoveryReleased
        await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true)
        expect(requests).toEqual(['/download', '/payload'])
        expect(readFileSync(installations, 'utf8')).toBe('installed\r\n')
      } finally {
        server.closeAllConnections()
        server.close()
        if (otherWriter && otherWriter.exitCode === null && otherWriter.signalCode === null) {
          const closed = once(otherWriter, 'close')
          writeFileSync(releaseOtherWriter, 'release')
          await closed
        }
        writeFileSync(allowReady, 'allow')
        await expect
          .poll(() => spawnSync(helper, ['check', root], { windowsHide: true }).status, {
            timeout: 10000
          })
          .toBe(0)
        // Only this random fixture's content-addressed recovery and operation directories.
        expect(
          recovery.endsWith(
            createHash('sha256')
              .update(install.replace(/[A-Z]/g, (letter) => letter.toLowerCase()))
              .digest('hex')
          )
        ).toBe(true)
        expect(operationRoot.endsWith(operation)).toBe(true)
        run(helper, ['close', recovery, '', '0'])
        rmSync(recovery, { recursive: true, force: true })
        rmSync(operationRoot, { recursive: true, force: true })
        expect(replacementRoot.endsWith(replacementOperation)).toBe(true)
        rmSync(replacementRoot, { recursive: true, force: true })
        rmSync(root, { recursive: true, force: true })
      }
    },
    60000
  )
})
