import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

import {
  absolutePhysicalPath,
  hiddenByFilesystemLayout,
  normalizeFilesystemLayout
} from '../runtime/src/platform/filesystem-layout.js'
import { macosLaunch, seatbeltProfile } from '../runtime/src/platform/macos-isolation.js'
import { linuxLaunch } from '../runtime/src/platform/linux-isolation.js'
import { ViolationLog } from '../runtime/src/gateway/violation-log.js'

const linuxIt = it.skipIf(process.platform === 'win32')

describe('Notebook filesystem policy', () => {
  it('relaxes folder isolation only when explicitly disabled and preserves explicit denies and network isolation', () => {
    const root = mkdtempSync(join(tmpdir(), 'open-science-folder-policy-'))
    try {
      const denied = join(root, 'secret')
      const protectedFile = join(root, 'runtime')
      writeFileSync(denied, 'private')
      writeFileSync(protectedFile, 'runtime')
      const filesystem = {
        privateRoot: root,
        readOnlyRoots: [],
        readWriteRoots: [],
        deniedReadRoots: [denied],
        deniedWriteRoots: [protectedFile]
      }
      for (const restrictFolders of [undefined, true, false]) {
        const layout = normalizeFilesystemLayout({ ...filesystem, restrictFolders })
        expect(hiddenByFilesystemLayout(layout, join(root, 'ordinary'))).toBe(
          restrictFolders !== false
        )
        expect(hiddenByFilesystemLayout(layout, denied)).toBe(true)
        const profile = seatbeltProfile({
          command: 'true',
          shell: '/bin/sh',
          gatewayPort: 3128,
          gatewayCredentials: { username: 'command', password: 'secret' },
          env: {},
          filesystem: { ...filesystem, restrictFolders }
        })
        expect(profile).toContain('(deny network*)')
        expect(profile).toContain(
          `(deny file-read* (subpath ${JSON.stringify(absolutePhysicalPath(denied))}))`
        )
        expect(profile).toContain(
          `(deny file-write* (subpath ${JSON.stringify(absolutePhysicalPath(protectedFile))}))`
        )
        expect(profile.includes('(require-not (subpath')).toBe(restrictFolders !== false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves symlinks before parent traversal, including missing leaves', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'os-physical-path-')))
    try {
      mkdirSync(join(root, 'real', 'deep'), { recursive: true })
      symlinkSync(join(root, 'real', 'deep'), join(root, 'alias'), 'junction')
      writeFileSync(join(root, 'real', 'secret'), 'physical')
      writeFileSync(join(root, 'secret'), 'lexical')
      const spelling = `${root}${sep}alias${sep}..${sep}secret`
      expect(absolutePhysicalPath(spelling)).toBe(realpathSync.native(spelling))
      const missing = `${root}${sep}alias${sep}..${sep}new${sep}leaf`
      expect(absolutePhysicalPath(missing)).toBe(
        join(realpathSync.native(`${root}${sep}alias${sep}..`), 'new', 'leaf')
      )
      const missingDot = `${root}${sep}missing${sep}.${sep}leaf`
      expect(absolutePhysicalPath(missingDot)).toBe(join(root, 'missing', 'leaf'))
      expect(absolutePhysicalPath(`${root}${sep}missing${sep}.`)).toBe(join(root, 'missing'))
      expect(
        normalizeFilesystemLayout({
          readOnlyRoots: [],
          readWriteRoots: [missingDot],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }).readWriteRoots
      ).toEqual([join(root, 'missing', 'leaf')])
      const missingTraversal = `${root}${sep}missing${sep}..${sep}leaf`
      if (process.platform === 'win32')
        expect(absolutePhysicalPath(missingTraversal)).toBe(join(root, 'leaf'))
      else expect(() => absolutePhysicalPath(missingTraversal)).toThrow()
      expect(() => absolutePhysicalPath(join(root, 'secret', 'leaf'))).toThrow()
      symlinkSync(join(root, 'absent'), join(root, 'dangling'), 'junction')
      expect(() => absolutePhysicalPath(join(root, 'dangling', 'leaf'))).toThrow()
      expect(() => absolutePhysicalPath(`${root}${sep}dangling${sep}.${sep}leaf`)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'darwin').each([true, false])(
    'keeps protected ancestors in place with folder restrictions %s',
    (restrictFolders) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'os-deny-ancestor-')))
      try {
        mkdirSync(join(root, 'parent'))
        writeFileSync(join(root, 'parent', 'secret'), 'fixture')
        const wrapped = macosLaunch({
          command: [
            'touch ordinary && mv ordinary renamed || exit 10',
            'if cat parent/secret >/dev/null 2>&1; then exit 11; fi',
            'if mv parent moved; then exit 12; fi',
            'if ln -s parent missing; then exit 13; fi',
            'touch parent/sibling || exit 14',
            'exit 0'
          ].join('; '),
          shell: '/bin/bash',
          gatewayPort: 3128,
          gatewayCredentials: { username: 'fixture', password: 'fixture' },
          env: { PATH: '/usr/bin:/bin' },
          filesystem: {
            restrictFolders,
            privateRoot: root,
            readOnlyRoots: [],
            readWriteRoots: [root],
            deniedReadRoots: [join(root, 'parent', 'secret'), join(root, 'missing', 'secret')],
            deniedWriteRoots: []
          }
        })
        const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
          cwd: root,
          env: wrapped.env,
          encoding: 'utf8',
          timeout: 5000
        })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(join(root, 'renamed'))).toBe(true)
        expect(existsSync(join(root, 'parent', 'sibling'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('deduplicates nested roots without widening them', () => {
    const root = mkdtempSync(join(tmpdir(), 'open-science-fs-'))
    const nested = join(root, 'nested')
    mkdirSync(nested)

    expect(
      normalizeFilesystemLayout({
        privateRoot: root,
        readOnlyRoots: [root, nested],
        readWriteRoots: [nested],
        deniedReadRoots: [],
        deniedWriteRoots: []
      })
    ).toMatchObject({
      readOnlyRoots: [absolutePhysicalPath(root)],
      readWriteRoots: [absolutePhysicalPath(nested)]
    })
  })

  it('places private-read denial, explicit grants, and write denial in one Seatbelt profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'open-science-seatbelt-'))
    const workspace = join(root, 'workspace')
    const protectedFile = join(root, 'settings.json')
    mkdirSync(workspace)
    writeFileSync(protectedFile, '{}')

    const profile = seatbeltProfile({
      command: 'python loop.py',
      gatewayPort: 3128,
      gatewayCredentials: { username: 'command', password: 'secret' },
      shell: '/bin/sh',
      env: { PATH: '/usr/bin:/bin' },
      localRpcSocketPath: '/tmp/open-science-notebook.sock',
      filesystem: {
        privateRoot: root,
        readOnlyRoots: ['/bin'],
        readWriteRoots: [workspace],
        deniedReadRoots: [protectedFile],
        deniedWriteRoots: [protectedFile]
      }
    })

    expect(profile).toContain('(deny file-read*')
    expect(profile).toContain('(allow file-read-metadata (vnode-type DIRECTORY))')
    expect(profile).toContain('(deny file-write*')
    expect(profile).toContain('(require-not (subpath')
    expect(profile).toContain(JSON.stringify(absolutePhysicalPath(protectedFile)))
    expect(profile).toContain(JSON.stringify(absolutePhysicalPath(tmpdir())))
    expect(profile).toContain(JSON.stringify(absolutePhysicalPath('/private/tmp')))
    expect(profile).toContain(
      `(allow network-outbound (literal ${JSON.stringify(
        absolutePhysicalPath('/tmp/open-science-notebook.sock')
      )}))`
    )
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:3128"))')
    expect(profile).not.toContain('(deny system-socket')
  })

  const expectMacosShellLaunch = (shell: string, extraFlags: readonly string[]): void => {
    const root = mkdtempSync(join(tmpdir(), 'open-science-shell-rc-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)

    try {
      const launch = macosLaunch({
        command: '/usr/bin/curl --silent http://example.com/',
        gatewayPort: 4312,
        gatewayCredentials: { username: 'command', password: 'secret' },
        shell,
        env: { PATH: '/usr/bin:/bin' },
        filesystem: {
          privateRoot: root,
          readOnlyRoots: ['/bin', '/usr/bin'],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })

      expect(launch.argv).toEqual([
        '/usr/bin/sandbox-exec',
        '-p',
        expect.any(String),
        shell,
        ...extraFlags,
        '-c',
        '/usr/bin/curl --silent http://example.com/'
      ])
      expect(launch.env.HTTP_PROXY).toContain('command:secret@localhost:4312')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it.skipIf(process.platform === 'win32')(
    'launches bash without reading profile or rc files',
    () => {
      expectMacosShellLaunch('/bin/bash', ['--noprofile', '--norc'])
    }
  )

  it.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))(
    'launches zsh without reading profile or rc files',
    () => {
      expectMacosShellLaunch('/bin/zsh', ['-d', '-f'])
    }
  )

  it('turns native permission failures into an actionable structured violation', () => {
    const log = new ViolationLog()
    expect(log.attach('command', 'cat: /private/data.csv: Permission denied')).toContain(
      'OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: /private/data.csv'
    )
    expect(log.attach('read-only', 'bash: /private/output.csv: Read-only file system')).toContain(
      'OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: /private/output.csv'
    )
    expect(log.attach('command', 'ordinary process failure')).toBe('ordinary process failure')
  })

  it('does not mislabel non-filesystem permission errors as folder grants', () => {
    const log = new ViolationLog()
    for (const error of ['socket: Operation not permitted', 'Permission denied (publickey).']) {
      expect(log.attach('command', error)).toBe(error)
    }
    const result = log.attach('command', 'bash: /data/output.csv: Read-only file system')
    expect(result).toContain('native permissions, read-only mounts, or the sandbox')
    expect(result).toContain('writable project path')
    expect(result).toContain('request_network_access cannot grant filesystem access')
  })

  it('identifies JSON-escaped filesystem errors redirected to stdout without rewriting output', () => {
    const log = new ViolationLog()
    const path = String.raw`C:\Users\fixture\.config\sample-tool\access-token.txt`
    const stdout = `Access is denied.\n${JSON.stringify(
      {
        ok: false,
        message: `EPERM: operation not permitted, open '${path}'`
      },
      null,
      2
    )}\n`
    const result = log.attach('redirected', '', undefined, stdout)
    expect(result).toContain(`OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${path} `)
    expect(result).toContain('grant that specific folder and access mode in the Files view')
    expect(result).not.toContain('"ok"')
    expect(
      log.attach('ordinary-json', '', undefined, '{"message":"socket: Operation not permitted"}')
    ).toBe('')
  })

  it.each([
    '/fixture/My  Folder/settings.json',
    String.raw`C:\fixture\My Folder\settings.json`,
    String.raw`\\fixture-server\share\My Folder\settings.json`
  ])('preserves exact quoted paths in stderr, stdout, and JSON: %s', (path) => {
    const message = `EPERM: operation not permitted, open '${path}'`
    for (const [stderr, stdout] of [
      [message, ''],
      ['', message],
      ['', JSON.stringify({ error: message })]
    ]) {
      const diagnostic = new ViolationLog().attach('fixture', stderr, undefined, stdout)
      expect(diagnostic).toContain(`OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${path} Filesystem`)
      expect(diagnostic.startsWith(stderr)).toBe(true)
    }
  })

  it.each([
    "cat: '/fixture/" + 'a'.repeat(1001) + "': Permission denied",
    "cat: '/fixture/a\tb/settings.json': Permission denied",
    'cat: /fixture/My Folder/settings.json: Permission denied'
  ])('does not propose a truncated or normalized folder path: %s', (stderr) => {
    expect(new ViolationLog().attach('fixture', stderr)).toBe(stderr)
  })

  it('bounds diagnostic work for unterminated escaped quotes in captured output', () => {
    const root = mkdtempSync(join(tmpdir(), 'os-diagnostic-budget-'))
    try {
      const bundle = join(root, 'violation-log.cjs')
      buildSync({
        entryPoints: [
          fileURLToPath(new URL('../runtime/src/gateway/violation-log.ts', import.meta.url))
        ],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle
      })
      const probe = join(root, 'probe.cjs')
      writeFileSync(
        probe,
        `
        const { ViolationLog } = require(${JSON.stringify(bundle)});
        const output = '"' + '\\\\"'.repeat(128 * 1024);
        const log = new ViolationLog();
        for (const prefix of ['', 'no such file or directory: ', 'operation not permitted: ']) {
          if (log.attach('fixture', '', undefined, prefix + output) !== '') process.exit(1);
        }
        const error = JSON.stringify({ message: "EPERM: operation not permitted, open '/private/fixture/token.txt'" });
        if (!log.attach('fixture', '', undefined, output + '\\n' + error).includes('OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: /private/fixture/token.txt')) process.exit(2);
      `
      )
      // A separate process makes the regression fail without hanging the test runner's event loop.
      const result = spawnSync(process.execPath, [probe], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true
      })
      expect(result.error, result.stderr).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves hidden-path diagnostics when JSON Unicode escapes encode the error phrase', () => {
    const output = String.raw`{"message":"\u006eo such file or directory: /private/fixture/input.txt"}`
    expect(new ViolationLog().attach('fixture', '', () => true, output)).toContain(
      'OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: /private/fixture/input.txt'
    )
  })

  it('includes approval recovery in stderr even when curl discards the proxy body', () => {
    const log = new ViolationLog()
    log.record('command', 'deny network-outbound trialsearch.who.int:443 (not approved)')
    const result = log.attach('command', 'curl: (56) CONNECT tunnel failed, response 403')
    expect(result).toContain('request_network_access tool')
    expect(result).toContain('exact hostname (without scheme or port), reason, and runtime')
    expect(result).toContain('exact failed command')
    expect(result).toContain('This opens a user approval card')
    expect(result).toContain('If denied, stop')
    expect(result).not.toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
    expect(log.attach('command', '')).toBe('')
  })

  it('separates policy failures from missing approvals in tool-visible stderr', () => {
    for (const reason of [
      'host did not resolve',
      'destination resolves to a non-public network address',
      'host is blocked by policy'
    ]) {
      const log = new ViolationLog()
      log.record('command', `deny network-outbound example.org:443 (${reason})`)
      const result = log.attach('command', 'curl: (56) CONNECT tunnel failed, response 403')
      expect(result).toContain('OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      expect(result).toContain(reason)
      expect(result).toContain('cannot be unlocked by request_network_access')
      expect(result).not.toContain('OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED')
    }
  })

  it('distinguishes Linux-hidden paths from ordinary missing files', () => {
    const privateRoot = mkdtempSync(join(tmpdir(), 'open-science-hidden-'))
    const workspace = join(privateRoot, 'workspace')
    mkdirSync(workspace)
    const hiddenPath = join(privateRoot, 'secrets.txt')
    const ordinaryMissingPath = join(workspace, 'missing.txt')
    const layout = normalizeFilesystemLayout({
      privateRoot,
      readOnlyRoots: ['/usr/bin'],
      readWriteRoots: [workspace],
      deniedReadRoots: [],
      deniedWriteRoots: []
    })
    const hidden = (path: string): boolean => hiddenByFilesystemLayout(layout, path)
    const log = new ViolationLog()

    expect(
      log.attach('hidden', `/bin/cat: ${hiddenPath}: No such file or directory`, hidden)
    ).toContain(`OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${hiddenPath}`)
    expect(
      log.attach(
        'ordinary-missing',
        `/bin/cat: ${ordinaryMissingPath}: No such file or directory`,
        hidden
      )
    ).not.toContain('OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED')
  })

  it('preserves diagnostics and recorded violations when a diagnostic path cannot resolve', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'os-diagnostic-path-')))
    try {
      writeFileSync(join(root, 'file'), 'fixture')
      symlinkSync(join(root, 'absent'), join(root, 'dangling'), 'junction')
      const layout = normalizeFilesystemLayout({
        privateRoot: root,
        readOnlyRoots: [],
        readWriteRoots: [],
        deniedReadRoots: [],
        deniedWriteRoots: []
      })
      const paths = [join(root, 'file', 'leaf'), join(root, 'dangling', 'leaf')]
      if (process.platform !== 'win32') paths.push(`${root}${sep}missing${sep}..${sep}leaf`)
      const hidden = (path: string): boolean => hiddenByFilesystemLayout(layout, path)
      const log = new ViolationLog()
      for (const path of paths) {
        expect(() => absolutePhysicalPath(path)).toThrow()
        expect(hidden(path)).toBe(false)
        const stderr = `cat: '${path}': No such file or directory`
        expect(log.attach('plain', stderr, hidden)).toBe(stderr)
        log.record('recorded', 'deny network-outbound example.org:443 (not approved)')
        const annotated = log.attach('recorded', stderr, hidden)
        expect(annotated).toContain(stderr)
        expect(annotated).toContain('deny network-outbound example.org:443 (not approved)')
        expect(annotated).not.toContain('OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  linuxIt.each([true, false])(
    'projects Linux folder restriction %s while retaining denied roots',
    async (restrictFolders) => {
      const privateRoot = mkdtempSync(join(tmpdir(), 'open-science-linux-mount-'))
      const readOnlyRoot = mkdtempSync(join(tmpdir(), 'open-science-linux-input-'))
      const bin = join(privateRoot, 'bin')
      const workspace = join(privateRoot, 'workspace')
      const missingProtected = join(privateRoot, 'missing-protected')
      const missingWriteOnly = join(privateRoot, 'missing-write-only')
      mkdirSync(bin)
      mkdirSync(workspace)
      for (const executable of ['bwrap', 'sh']) {
        const path = join(bin, executable)
        writeFileSync(path, '#!/bin/sh\nexit 0\n')
        chmodSync(path, 0o755)
      }

      const launch = await linuxLaunch({
        command: 'true',
        shell: 'sh',
        cwd: workspace,
        gatewayPort: 9,
        gatewayCredentials: { username: 'command', password: 'secret' },
        env: { PATH: bin },
        inheritedFileDescriptorCount: 1,
        filesystem: {
          restrictFolders,
          privateRoot,
          readOnlyRoots: [readOnlyRoot],
          readWriteRoots: [workspace],
          deniedReadRoots: [missingProtected],
          deniedWriteRoots: [bin, missingProtected, missingWriteOnly]
        }
      })

      try {
        const physicalRoot = realpathSync(privateRoot)
        const physicalReadOnlyRoot = realpathSync(readOnlyRoot)
        const physicalWorkspace = realpathSync(workspace)
        const remountIndex = launch.argv.findIndex(
          (value, index) => value === '--remount-ro' && launch.argv[index + 1] === physicalRoot
        )
        const writableIndex = launch.argv.findIndex(
          (value, index) =>
            value === '--bind' &&
            launch.argv[index + 1] === physicalWorkspace &&
            launch.argv[index + 2] === physicalWorkspace
        )
        const readOnlyIndex = launch.argv.findIndex(
          (value, index) =>
            value === '--ro-bind' &&
            launch.argv[index + 1] === physicalReadOnlyRoot &&
            launch.argv[index + 2] === physicalReadOnlyRoot
        )

        if (!restrictFolders) {
          const args = launch.argv.join(' ')
          expect(args).toContain('--bind / /')
          expect(args).toContain('--unshare-all')
          expect(
            launch.argv.some(
              (value, index) => value === '--tmpfs' && launch.argv[index + 1] === physicalRoot
            )
          ).toBe(false)
          expect(args).toContain(`--ro-bind ${realpathSync(bin)} ${realpathSync(bin)}`)
          for (const missing of [missingProtected, missingWriteOnly].map(absolutePhysicalPath)) {
            expect(args).toContain(`--tmpfs ${missing} --remount-ro ${missing}`)
            expect(args).not.toContain(`--ro-bind ${missing} ${missing}`)
          }
          return
        }
        expect(remountIndex).toBeGreaterThan(0)
        expect(writableIndex).toBeGreaterThan(remountIndex)
        if (process.platform === 'linux') expect(readOnlyIndex).toBeGreaterThan(0)
        expect(launch.argv).not.toContain('--preserve-fds')
        expect(launch.argv.slice(-2)).toEqual(['1', ''])
        for (const temporaryRoot of ['/tmp', '/var/tmp']) {
          const tmpfsIndex = launch.argv.findIndex(
            (value, index) => value === '--tmpfs' && launch.argv[index + 1] === temporaryRoot
          )
          const temporaryRemountIndex = launch.argv.findIndex(
            (value, index) => value === '--remount-ro' && launch.argv[index + 1] === temporaryRoot
          )
          expect(tmpfsIndex).toBeGreaterThan(0)
          if (
            process.platform === 'linux' &&
            physicalReadOnlyRoot.startsWith(`${temporaryRoot}/`)
          ) {
            expect(readOnlyIndex).toBeGreaterThan(tmpfsIndex)
            expect(temporaryRemountIndex).toBeGreaterThan(readOnlyIndex)
          }
          expect(temporaryRemountIndex).toBeGreaterThan(writableIndex)
        }
      } finally {
        await launch.release()
        rmSync(privateRoot, { force: true, recursive: true })
        rmSync(readOnlyRoot, { force: true, recursive: true })
      }
    }
  )

  it('reports each recorded violation once for persistent kernels', () => {
    const log = new ViolationLog()
    log.record('command', 'deny network-outbound data.example.org:443')
    expect(log.attach('command', '')).toContain('data.example.org:443')
    expect(log.attach('command', '')).toBe('')
  })

  it('keeps network approval denials actionable when the client hides the response body', () => {
    const log = new ViolationLog()
    log.record('command', 'deny network-outbound example.org:443 (not approved)')

    expect(log.attach('command', 'curl: (22) The requested URL returned error: 403')).toContain(
      'OPEN_SCIENCE_NETWORK_DOMAIN_BLOCKED'
    )
  })
})
