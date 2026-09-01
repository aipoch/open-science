import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      readOnlyRoots: [realpathSync(root)],
      readWriteRoots: [realpathSync(nested)]
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

  linuxIt('keeps hidden Linux mounts read-only while restoring workspace writes', async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), 'open-science-linux-mount-'))
    const bin = join(privateRoot, 'bin')
    const workspace = join(privateRoot, 'workspace')
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
        privateRoot,
        readOnlyRoots: [],
        readWriteRoots: [workspace],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })

    try {
      const physicalRoot = realpathSync(privateRoot)
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

      expect(remountIndex).toBeGreaterThan(0)
      expect(writableIndex).toBeGreaterThan(remountIndex)
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
        expect(temporaryRemountIndex).toBeGreaterThan(writableIndex)
      }
    } finally {
      await launch.release()
      rmSync(privateRoot, { force: true, recursive: true })
    }
  })

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
