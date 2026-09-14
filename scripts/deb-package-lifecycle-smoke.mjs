/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Run on a disposable Linux certification runner before installing the real application.
// Use the built package's actual FPM control scripts, not merely the source templates.
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const command = '/usr/bin/open-science'
const appRoot = '/opt/Open Science'
const legacyTarget = `${appRoot}/open-science`
const cliTarget = `${appRoot}/resources/open-science-cli`

const main = async (deb) => {
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    throw new Error('Debian lifecycle certification requires root on a disposable Linux runner.')
  }
  // Never use this harness to replace an already installed application or user command.
  const status = (() => {
    try {
      return run('dpkg-query', ['-W', '-f=${db:Status-Status}', 'open-science']).trim()
    } catch {
      return 'not-installed'
    }
  })()
  if (status === 'installed') {
    throw new Error('Run Debian lifecycle certification before installing Open Science.')
  }
  for (const path of [command, appRoot]) {
    if (
      await lstat(path).then(
        () => true,
        () => false
      )
    ) {
      throw new Error(`Refusing to replace an existing certification target: ${path}`)
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'deb-lifecycle-'))
  try {
    const control = join(root, 'actual-control')
    run('dpkg-deb', ['--control', deb, control])
    const generated = {}
    for (const name of ['postinst', 'postrm'])
      generated[name] = await readFile(join(control, name), 'utf8')
    if (!generated.postinst.includes(cliTarget) || !generated.postrm.includes(cliTarget)) {
      throw new Error('The built Debian control scripts did not include the CLI lifecycle hooks.')
    }
    const fixture = async (version, legacy) => {
      const tree = join(root, version)
      await mkdir(join(tree, 'DEBIAN'), { recursive: true })
      await mkdir(join(tree, 'opt/Open Science/resources'), { recursive: true })
      await writeFile(
        join(tree, 'DEBIAN/control'),
        `Package: open-science\nVersion: ${version}\nArchitecture: all\nMaintainer: AIPOCH\nDescription: Debian CLI lifecycle certification fixture\n`
      )
      for (const name of ['postinst', 'postrm']) {
        const text = legacy
          ? (
              await readFile(
                resolve(
                  `node_modules/app-builder-lib/templates/linux/${name === 'postinst' ? 'after-install' : 'after-remove'}.tpl`
                ),
                'utf8'
              )
            )
              .replaceAll('${executable}', 'open-science')
              .replaceAll('${sanitizedProductName}', 'Open Science')
          : generated[name]
        const path = join(tree, 'DEBIAN', name)
        await writeFile(path, text)
        await chmod(path, 0o755)
      }
      for (const file of ['open-science', 'resources/open-science-cli', 'chrome-sandbox']) {
        await writeFile(join(tree, 'opt/Open Science', file), '#!/bin/sh\nexit 0\n', {
          mode: 0o755
        })
      }
      const output = join(root, `${version}.deb`)
      run('dpkg-deb', ['--build', '--root-owner-group', tree, output])
      return output
    }
    const oldPackage = await fixture('0.0.1', true)
    const newPackage = await fixture('0.0.2', false)
    for (const mode of ['auto', 'manual']) {
      run('dpkg', ['--install', oldPackage])
      if ((await realpath(command)) !== legacyTarget)
        throw new Error('Legacy fixture did not expose Electron.')
      if (mode === 'manual') run('update-alternatives', ['--set', 'open-science', legacyTarget])
      run('dpkg', ['--install', newPackage])
      if ((await realpath(command)) !== cliTarget)
        throw new Error(`Debian ${mode} upgrade did not expose the CLI.`)
      run('dpkg', ['--install', newPackage])
      if ((await realpath(command)) !== cliTarget) throw new Error('Debian reinstall lost the CLI.')
      run('dpkg', ['--remove', 'open-science'])
      if (
        await realpath(command).then(
          () => true,
          () => false
        )
      )
        throw new Error('Debian removal left a live command.')
      run('dpkg', ['--purge', 'open-science'])
      console.log(
        `Debian generated hooks: ${mode} legacy upgrade, reinstall, remove and purge passed.`
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
