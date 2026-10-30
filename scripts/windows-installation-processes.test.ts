import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { windowsInstallationRecoveryDirectory } from '../src/main/update/windows-update-handoff'

const require = createRequire(import.meta.url)

describe.skipIf(process.platform !== 'win32')(
  'independent Windows installation process adapter',
  () => {
    let fixture: string, helper: string
    const children: ChildProcess[] = []
    beforeAll(() => {
      fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'installation-processes-')))
      helper = join(fixture, 'inspection.exe')
      require('../build/compile-windows-installation-processes.cjs')(helper)
    })
    afterAll(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        // Only retained handles of fixture children, never PID/name-based machine cleanup.
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        child.kill()
        await closed
      }
      rmSync(fixture, { recursive: true, force: true })
    })
    async function launch(
      directory: string,
      launchPath = (path: string): string => path
    ): Promise<ChildProcess> {
      mkdirSync(directory)
      const executable = join(directory, 'same-name.exe')
      copyFileSync(process.execPath, executable)
      const child = spawn(
        launchPath(executable),
        ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      children.push(child)
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.stdout!.once('data', () => resolve())
      })
      return child
    }
    function run(...args: string[]): string {
      return execFileSync(helper, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    }
    it('resolves a Win32 image mapping failure through the same object in the native namespace', async () => {
      const source = readFileSync(
        join(__dirname, '../build/windows-installation-processes.cs'),
        'utf8'
      )
      const query = 'QueryFullProcessImageName(handle, 0, image, ref size)'
      expect(source.split(query)).toHaveLength(2)
      // Simulate only the failed Win32 mapping. Native queries, file identities, Restart Manager,
      // process handles and termination remain real, including an unrelated same-name sentinel.
      const fixtureSource = source
        .replace(query, 'MappingFailure(handle, image, ref size)')
        .replace(
          'static int Main(string[] args) {',
          `[DllImport("kernel32.dll", SetLastError = true)] static extern void SetLastError(uint code);
         [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetShortPathName(string path, StringBuilder result, uint size);
         static bool MappingFailure(IntPtr handle, StringBuilder image, ref uint size) {
           if (!QueryFullProcessImageName(handle, 0, image, ref size)) return false;
           SetLastError(31); return false;
         }
         static int Main(string[] args) {
           if (args[0] == "short-path") {
             var path = new StringBuilder(32768);
             if (GetShortPathName(args[1], path, (uint)path.Capacity) == 0) return 2;
             Console.Write(path.ToString()); return 0;
           }`
        )
      const sourcePath = join(fixture, 'mapping-failure.cs')
      const executable = join(fixture, 'mapping-failure.exe')
      writeFileSync(sourcePath, fixtureSource)
      execFileSync(
        join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        [
          '/nologo',
          '/target:exe',
          '/reference:System.Web.Extensions.dll',
          `/out:${executable}`,
          sourcePath
        ],
        { windowsHide: true, timeout: 30_000 }
      )
      const target = join(fixture, 'native-mapping-target')
      const child = await launch(target, (path) => {
        const short = execFileSync(executable, ['short-path', path], {
          encoding: 'utf8',
          windowsHide: true
        })
        expect(short).toContain('~')
        return short
      })
      const sentinel = await launch(join(fixture, 'native-mapping-other'))
      const queryResult = JSON.parse(
        execFileSync(executable, ['query', target], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000
        })
      )
      expect(queryResult.processes.map((row: { ProcessId: number }) => row.ProcessId)).toEqual([
        child.pid
      ])
      const unknownSourcePath = join(fixture, 'unknown-image.cs')
      const unknownExecutable = join(fixture, 'unknown-image.exe')
      writeFileSync(
        unknownSourcePath,
        fixtureSource.replace(
          'QueryFullProcessImageName(handle, 1, image, ref size)',
          'MappingFailure(handle, image, ref size)'
        )
      )
      execFileSync(
        join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        [
          '/nologo',
          '/target:exe',
          '/reference:System.Web.Extensions.dll',
          `/out:${unknownExecutable}`,
          unknownSourcePath
        ],
        { windowsHide: true, timeout: 30_000 }
      )
      const unknown = spawnSync(unknownExecutable, ['close', target, '', '0'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000
      })
      expect(unknown.status).toBe(2)
      expect(unknown.stderr).toContain('stage=process-image-native;')
      expect(child.exitCode).toBeNull()
      expect(sentinel.exitCode).toBeNull()
      const closed = JSON.parse(
        execFileSync(executable, ['close', target, '', '0'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000
        })
      )
      expect(closed.forced).toEqual([child.pid])
      expect(sentinel.exitCode).toBeNull()
    })
    it('uses the same recovery identity as Node for Unicode installation paths', async () => {
      const installation = join(fixture, 'İ 科学')
      mkdirSync(installation)
      expect(run('recovery-directory', installation, fixture)).toBe(
        await windowsInstallationRecoveryDirectory(fixture, join(installation, 'app.exe'))
      )
    })
    it('finds real installation executables and closes only that installation through retained handles', async () => {
      const target = join(fixture, 'target'),
        other = join(fixture, 'target-other')
      const child = await launch(target),
        sentinel = await launch(other)
      const scan = JSON.parse(run('query', target))
      expect(scan.processes.map((row: { ProcessId: number }) => row.ProcessId)).toContain(child.pid)
      expect(scan.processes.map((row: { ProcessId: number }) => row.ProcessId)).not.toContain(
        sentinel.pid
      )
      const result = JSON.parse(run('close', target, '', '50'))
      expect(result.forced).toContain(child.pid)
      expect(sentinel.exitCode).toBeNull()
      expect(JSON.parse(run('query', target))).toEqual({ resourcePids: [], processes: [] })
      expect(spawnSync(helper, ['check', other], { windowsHide: true }).status).toBe(3)
    })
    it('honors exact exclusions without blessing all descendants or similarly named processes', async () => {
      const root = join(fixture, 'excluded')
      const child = await launch(root)
      expect(JSON.parse(run('close', root, String(child.pid), '0'))).toEqual({
        graceful: [],
        forced: []
      })
      expect(spawnSync(helper, ['check', root], { windowsHide: true }).status).toBe(3)
      expect(child.exitCode).toBeNull()
    })
    it('does not initiate termination after the absolute close deadline', async () => {
      const root = join(fixture, 'expired-close')
      const child = await launch(root)
      const result = spawnSync(helper, ['close', root, '', '30000', String(Date.now() - 1)], {
        windowsHide: true,
        encoding: 'utf8'
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('stage=close-deadline;')
      expect(spawnSync(helper, ['check', root], { windowsHide: true }).status).toBe(3)
      expect(child.exitCode).toBeNull()
    })
    it('binds recovery URLs to the original request before allowing any download', () => {
      const root = join(fixture, 'request-binding')
      mkdirSync(root)
      const requestPath = join(root, 'bound-request.json'),
        iniPath = join(root, 'update.ini')
      const request = {
        operationId: randomUUID(),
        applicationPath: join(root, 'app.exe'),
        installerPath: join(root, 'installer.exe'),
        installerUrl: 'https://example.test/original.exe',
        installerSha256: 'a'.repeat(64)
      }
      const json = JSON.stringify(request)
      writeFileSync(requestPath, json)
      const writeIni = (overrides: Partial<typeof request> = {}): void => {
        writeFileSync(
          iniPath,
          '\uFEFF[update]\r\n' +
            Object.entries({
              ...request,
              ...overrides,
              requestSha256: createHash('sha256').update(json).digest('hex')
            })
              .map(([key, value]) => `${key}=${value}\r\n`)
              .join(''),
          'utf16le'
        )
      }
      writeIni()
      expect(run('recovery-request', requestPath, iniPath)).toBe('')
      writeIni({ installerUrl: 'https://other.test/unbound.exe' })
      expect(
        spawnSync(helper, ['recovery-request', requestPath, iniPath], { windowsHide: true }).status
      ).toBe(2)
      writeIni()
      writeFileSync(requestPath, json + ' ')
      expect(
        spawnSync(helper, ['recovery-request', requestPath, iniPath], { windowsHide: true }).status
      ).toBe(2)
    })
    it('reserves force and reap inside the original deadline even when grace asks for longer', async () => {
      const root = join(fixture, 'bounded-close')
      const child = await launch(root)
      const started = Date.now()
      const result = JSON.parse(run('close', root, '', '30000', String(started + 1500)))
      expect(result.forced).toContain(child.pid)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(spawnSync(helper, ['check', root], { windowsHide: true }).status).toBe(0)
    })
    it('reports actual foreign file users but never terminates them', async () => {
      const root = join(fixture, 'file-use')
      mkdirSync(root)
      const locked = join(root, 'resource.txt')
      writeFileSync(locked, 'fixture resource')
      const source = join(fixture, 'file-user.cs'),
        executable = join(fixture, 'file-user.exe')
      writeFileSync(
        source,
        'using System;using System.IO;using System.Threading;class P{static void Main(string[] a){using(var f=new FileStream(a[0],FileMode.Open,FileAccess.Read,FileShare.Read)){Console.WriteLine("ready");Thread.Sleep(30000);}}}'
      )
      execFileSync(
        join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        ['/nologo', `/out:${executable}`, source],
        { windowsHide: true }
      )
      const child = spawn(executable, [locked], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.push(child)
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.stdout!.once('data', () => resolve())
      })
      expect(JSON.parse(run('query', root)).resourcePids).toContain(child.pid)
      expect(JSON.parse(run('close', root, '', '0'))).toEqual({ graceful: [], forced: [] })
      expect(spawnSync(helper, ['check', root], { windowsHide: true }).status).toBe(3)
      expect(child.exitCode).toBeNull()
      // A native API result can be a bare system label (Registry on Windows CI), not
      // an executable path. Inject that result only for this retained fixture object;
      // the real file lock and Restart Manager must still prevent installation.
      const labelSource = join(fixture, 'native-label.cs')
      const labelHelper = join(fixture, 'native-label.exe')
      writeFileSync(
        labelSource,
        readFileSync(join(__dirname, '../build/windows-installation-processes.cs'), 'utf8')
          .replace(
            'QueryFullProcessImageName(handle, 0, image, ref size)',
            'FixtureImage(handle, 0, image, ref size)'
          )
          .replace(
            'QueryFullProcessImageName(handle, 1, image, ref size)',
            'FixtureImage(handle, 1, image, ref size)'
          )
          .replace(
            'static int Main(string[] args) {',
            `
            [DllImport("kernel32.dll", SetLastError = true)] static extern void SetLastError(uint code);
            [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr handle);
            static bool FixtureImage(IntPtr handle, uint flags, StringBuilder image, ref uint size) {
              if (GetProcessId(handle) != ${child.pid}) return QueryFullProcessImageName(handle, flags, image, ref size);
              if (flags == 0) { SetLastError(31); return false; }
              string label = Environment.GetEnvironmentVariable("TEST_NATIVE_IMAGE") ?? "";
              image.Clear(); image.Append(label); size = (uint)label.Length; return true;
            }
            static int Main(string[] args) {`
          )
      )
      execFileSync(
        join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        ['/nologo', '/reference:System.Web.Extensions.dll', `/out:${labelHelper}`, labelSource],
        { windowsHide: true }
      )
      const labelRun = (label: string, ...args: string[]): ReturnType<typeof spawnSync> =>
        spawnSync(labelHelper, args, {
          env: { ...process.env, TEST_NATIVE_IMAGE: label },
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15_000
        })
      const empty = join(fixture, 'no-resource-use')
      mkdirSync(empty)
      for (const label of ['Registry', 'Memory Compression']) {
        const query = labelRun(label, 'query', root)
        expect(query.status, String(query.stderr)).toBe(0)
        expect(JSON.parse(String(query.stdout))).toEqual({
          resourcePids: [child.pid],
          processes: []
        })
        expect(labelRun(label, 'check', root).status).toBe(3)
        expect(JSON.parse(String(labelRun(label, 'close', root, '', '0').stdout))).toEqual({
          graceful: [],
          forced: []
        })
        expect(JSON.parse(String(labelRun(label, 'query', root).stdout)).resourcePids).toContain(
          child.pid
        )
        expect(labelRun(label, 'check', empty).status).toBe(0)
        expect(child.exitCode).toBeNull()
      }
      for (const label of [
        '',
        'relative\\file.exe',
        '/usr/bin/example',
        'C:example.exe',
        'bad\nlabel'
      ]) {
        const unknown = labelRun(label, 'check', empty)
        expect(unknown.status).toBe(2)
        expect(String(unknown.stderr)).toContain('stage=process-image-native-path;')
      }
    })
    it('excludes its own temporary inspection process only after the caller has waited for exit', () => {
      expect(JSON.parse(run('query', resolve(fixture))).processes).not.toContainEqual(
        expect.objectContaining({ ExecutablePath: helper })
      )
    })
    it('distinguishes an active installer mutex from a missing or exited writer', async () => {
      const name = randomUUID()
      expect(JSON.parse(run('writer-active', name))).toEqual({ active: false })
      const source = join(fixture, 'writer.cs'),
        executable = join(fixture, 'writer.exe')
      writeFileSync(
        source,
        'using System;using System.Threading;class P{static void Main(string[] a){using(var m=new Mutex(true,a[0])){Console.WriteLine("ready");Thread.Sleep(30000);}}}'
      )
      execFileSync(
        join(process.env.SystemRoot!, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
        ['/nologo', `/out:${executable}`, source],
        { windowsHide: true }
      )
      const writer = spawn(executable, [name], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.push(writer)
      await new Promise<void>((resolve, reject) => {
        writer.once('error', reject)
        writer.stdout!.once('data', () => resolve())
      })
      expect(JSON.parse(run('writer-active', name))).toEqual({ active: true })
      const closed = new Promise<void>((resolve) => writer.once('close', () => resolve()))
      writer.kill()
      await closed
      expect(JSON.parse(run('writer-active', name))).toEqual({ active: false })
      expect(JSON.parse(run('writer-active', name))).toEqual({ active: false })
    })
  }
)
