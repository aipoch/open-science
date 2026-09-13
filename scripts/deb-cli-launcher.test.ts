import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// Exercise the POSIX wrapper locally as well as on its Linux target.
describe.skipIf(process.platform === 'win32')('Debian CLI launcher', () => {
  it('runs the bundled CLI through Electron Node mode and preserves arguments and exit status', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'deb-cli-')))
    roots.push(root)
    const app = join(root, "Open Science ' 数据")
    const resources = join(app, 'resources')
    const bin = join(root, 'bin')
    await mkdir(resources, { recursive: true })
    await mkdir(bin)
    await copyFile(resolve('build/deb-cli-launcher'), join(resources, 'open-science-cli'))
    await chmod(join(resources, 'open-science-cli'), 0o755)
    const executable = join(app, 'open-science')
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$OPEN_SCIENCE_APP_PATH" "$@"\nexit 23\n',
      { mode: 0o755 }
    )
    const command = join(bin, 'open-science')
    await symlink(join(resources, 'open-science-cli'), command)
    const result = spawnSync(command, ['run', '--prompt', 'spaces; $(never-run) "quoted"', ''], {
      encoding: 'utf8',
      env: { ...process.env, OPEN_SCIENCE_APP_PATH: '/wrong/application', DISPLAY: '' }
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(23)
    expect(result.stderr).toBe('')
    expect(result.stdout.split('\n')).toEqual([
      '1',
      executable,
      join(resources, 'cli/index.mjs'),
      'run',
      '--prompt',
      'spaces; $(never-run) "quoted"',
      '',
      ''
    ])
  })
})

// Preserve electron-builder's platform setup while replacing only command registration.
describe('Debian packaging contract', () => {
  it('keeps the upstream sandbox, MIME and AppArmor setup and installs a separate CLI entry', async () => {
    const { readFile } = await import('node:fs/promises')
    const { load } = await import('js-yaml')
    const config = load(await readFile('electron-builder.yml', 'utf8')) as {
      deb: { afterInstall: string; afterRemove: string }
      linux: { executableName?: string; extraResources: { from: string; to: string }[] }
    }
    expect(config.deb.afterInstall).toBe('build/deb-after-install.tpl')
    expect(config.deb.afterRemove).toBe('build/deb-after-remove.tpl')
    expect(config.linux.executableName).toBeUndefined()
    expect(config.linux.extraResources).toContainEqual({
      from: 'build/deb-cli-launcher',
      to: 'open-science-cli'
    })
    for (const [filename, marker] of [
      ['after-install.tpl', '# Check if user namespaces'],
      ['after-remove.tpl', 'APPARMOR_PROFILE_DEST=']
    ]) {
      const upstream = await readFile(
        `node_modules/app-builder-lib/templates/linux/${filename}`,
        'utf8'
      )
      const owned = await readFile(`build/deb-${filename}`, 'utf8')
      expect(owned.slice(owned.indexOf(marker)).trim()).toBe(
        upstream.slice(upstream.indexOf(marker)).trim()
      )
    }
  })
})

describe.skipIf(process.platform !== 'linux')('Debian alternatives lifecycle', () => {
  const fixture = async (): Promise<{
    root: string
    alternativeLink: string
    target: string
    legacy: string
    command: string
    run: (args: string[]) => SpawnSyncReturns<string>
    hook: (kind: string, argument: string) => SpawnSyncReturns<string>
  }> => {
    const { readFile } = await import('node:fs/promises')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'deb-alternatives-')))
    roots.push(root)
    const bin = join(root, 'bin')
    const alternatives = join(root, 'etc/alternatives')
    const admin = join(root, 'var/lib/dpkg/alternatives')
    const resources = join(root, 'opt/Open Science/resources')
    for (const dir of [bin, alternatives, admin, resources, join(root, 'usr/bin')]) {
      await mkdir(dir, { recursive: true })
    }
    const legacy = join(root, 'opt/Open Science/open-science')
    const target = join(resources, 'open-science-cli')
    const command = join(root, 'usr/bin/open-science')
    await writeFile(legacy, 'legacy')
    await writeFile(target, 'cli')
    await writeFile(join(root, 'opt/Open Science/chrome-sandbox'), '')
    await writeFile(
      join(bin, 'update-alternatives'),
      `#!/bin/sh\nexec /usr/bin/update-alternatives --altdir '${alternatives}' --admindir '${admin}' "$@"\n`,
      { mode: 0o755 }
    )
    for (const [name, status] of [
      ['apparmor_status', 1],
      ['update-mime-database', 0],
      ['update-desktop-database', 0],
      ['unshare', 0]
    ]) {
      await writeFile(join(bin, String(name)), `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 })
    }
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: 'C' }
    const run = (args: string[]): SpawnSyncReturns<string> =>
      spawnSync(join(bin, 'update-alternatives'), args, { env, encoding: 'utf8' })
    const scripts: Record<string, string> = {}
    for (const kind of ['install', 'remove']) {
      const text = (await readFile(`build/deb-after-${kind}.tpl`, 'utf8'))
        .replaceAll('${executable}', 'open-science')
        .replaceAll('${sanitizedProductName}', 'Open Science')
        .replaceAll('/usr/bin/', `${root}/usr/bin/`)
        .replaceAll('/etc/alternatives/', `${alternatives}/`)
        .replaceAll('/opt/', `${root}/opt/`)
        .replaceAll('/etc/apparmor.d/', `${root}/etc/apparmor.d/`)
      scripts[kind] = join(root, kind)
      await writeFile(scripts[kind], text)
    }
    const hook = (kind: string, argument: string): SpawnSyncReturns<string> =>
      spawnSync('/bin/bash', [scripts[kind], argument], { env, encoding: 'utf8' })
    return {
      root,
      alternativeLink: join(alternatives, 'open-science'),
      target,
      legacy,
      command,
      run,
      hook
    }
  }

  it('supports fresh install, reinstall, upgrade postrm, remove and repeated purge', async () => {
    const f = await fixture()
    for (let i = 0; i < 2; i++) {
      expect(f.hook('install', 'configure').status).toBe(0)
      expect(await realpath(f.command)).toBe(f.target)
    }
    expect(f.hook('remove', 'upgrade').status).toBe(0)
    expect(await realpath(f.command)).toBe(f.target)
    await rm(f.target) // dpkg removes payload before postrm.
    expect(f.hook('remove', 'remove').status).toBe(0)
    await expect(realpath(f.command)).rejects.toThrow()
    expect(f.hook('remove', 'purge').status).toBe(0)
  })

  it.each(['auto', 'manual'])('migrates only the legacy %s alternative', async (mode) => {
    const f = await fixture()
    expect(f.run(['--install', f.command, 'open-science', f.legacy, '100']).status).toBe(0)
    if (mode === 'manual') expect(f.run(['--set', 'open-science', f.legacy]).status).toBe(0)
    expect(f.hook('install', 'configure').status).toBe(0)
    expect(await realpath(f.command)).toBe(f.target)
    const query = f.run(['--query', 'open-science']).stdout
    expect(query).not.toContain(`Alternative: ${f.legacy}\n`)
  })

  it('preserves another manually selected alternative through install and uninstall', async () => {
    const f = await fixture()
    const other = join(f.root, 'another-cli')
    await writeFile(other, 'user choice')
    expect(f.run(['--install', f.command, 'open-science', f.legacy, '100']).status).toBe(0)
    expect(f.run(['--install', f.command, 'open-science', other, '200']).status).toBe(0)
    expect(f.run(['--set', 'open-science', other]).status).toBe(0)
    expect(f.hook('install', 'configure').status).toBe(0)
    expect(await realpath(f.command)).toBe(other)
    expect(f.hook('remove', 'remove').status).toBe(0)
    expect(await realpath(f.command)).toBe(other)
  })

  it('fails closed when an unmanaged symlink replaces the command before uninstall', async () => {
    const f = await fixture()
    expect(f.hook('install', 'configure').status).toBe(0)
    await rm(f.command)
    await symlink(f.legacy, f.command)
    await rm(f.target)
    for (const phase of ['remove', 'purge']) {
      expect(f.hook('remove', phase).status).toBe(1)
      expect(await realpath(f.command)).toBe(f.legacy)
    }
  })

  it('preserves an unregistered replacement of the alternatives link itself', async () => {
    const f = await fixture()
    expect(f.hook('install', 'configure').status).toBe(0)
    const other = join(f.root, 'unregistered-cli')
    await writeFile(other, 'user command')
    await rm(f.alternativeLink)
    await symlink(other, f.alternativeLink)
    expect(f.hook('install', 'configure').status).toBe(1)
    expect(f.hook('remove', 'remove').status).toBe(1)
    expect(await realpath(f.command)).toBe(other)
  })

  it.each(['file', 'symlink'])('refuses to replace an unmanaged %s', async (kind) => {
    const f = await fixture()
    if (kind === 'file') await writeFile(f.command, 'user command')
    else await symlink(f.legacy, f.command)
    const { lstat, readFile, readlink } = await import('node:fs/promises')
    const before = await lstat(f.command)
    expect(f.hook('install', 'configure').status).toBe(1)
    expect((await lstat(f.command)).ino).toBe(before.ino)
    if (kind === 'file') expect(await readFile(f.command, 'utf8')).toBe('user command')
    else expect(await readlink(f.command)).toBe(f.legacy)
  })
})
