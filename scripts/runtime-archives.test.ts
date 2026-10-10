import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { runtimeTargets, currentRuntimeTarget } from '../packages/open-science/runtime-package.mjs'
import {
  archiveFilename,
  archiveLauncher,
  archiveStem,
  archiveTar,
  collectRuntimeArchives,
  packRuntimeArchive,
  sha256
} from './runtime-archives.mjs'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const sha = 'a'.repeat(40)
async function fixture(): Promise<{
  root: string
  source: string
  nodeSource: string
  output: string
  target: ReturnType<typeof currentRuntimeTarget>
  sourceSha: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'runtime archive 测试 '))
  roots.push(root)
  const target = currentRuntimeTarget()
  const source = join(root, 'backend')
  const nodeSource = join(root, 'node-runtime')
  const output = join(root, 'archives')
  for (const folder of [
    source,
    nodeSource,
    output,
    join(root, 'build'),
    join(source, 'out/backend'),
    join(source, 'out/web')
  ])
    await mkdir(folder, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  await writeFile(
    join(root, 'build/node-runtime.json'),
    JSON.stringify({ version: process.versions.node })
  )
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ version: '1.2.3', os: [target.os], cpu: [target.cpu] })
  )
  for (const file of [
    'cli.mjs',
    'out/backend/index.cjs',
    'out/web/index.html',
    'LICENSE',
    '.hidden'
  ])
    await writeFile(join(source, file), file)
  await writeFile(
    join(nodeSource, 'version.json'),
    JSON.stringify({ version: process.versions.node, platform: target.os, arch: target.cpu })
  )
  await writeFile(join(nodeSource, 'LICENSE'), 'node license')
  if (process.platform === 'win32') await copyFile(process.execPath, join(nodeSource, 'node.exe'))
  else {
    // Homebrew Node uses sibling dylibs; the unit fixture tests launcher forwarding only.
    // The installed-artifact test separately executes the actual pinned bundled Node.
    const quoted = "'" + process.execPath.replaceAll("'", "'\"'\"'") + "'"
    await writeFile(join(nodeSource, 'node'), `#!/bin/sh\nexec ${quoted} "$@"\n`)
  }
  await chmod(join(nodeSource, process.platform === 'win32' ? 'node.exe' : 'node'), 0o755)
  return { root, source, nodeSource, output, target, sourceSha: sha }
}
describe('standalone runtime archives', () => {
  it('roundtrips the launcher, hidden files, arguments, cwd and exit status', async () => {
    const options = await fixture()
    await writeFile(
      join(options.source, 'cli.mjs'),
      'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exit(17)'
    )
    const report = await packRuntimeArchive(options)
    expect(report.sha256).toBe(await sha256(join(options.output, report.filename)))
    const extracted = join(options.root, 'installed with spaces')
    await mkdir(extracted)
    execFileSync(archiveTar, ['-xf', join(options.output, report.filename), '-C', extracted])
    const installed = join(extracted, archiveStem('1.2.3', options.target))
    expect(await readFile(join(installed, 'backend/.hidden'), 'utf8')).toBe('.hidden')
    expect(await readFile(join(installed, 'backend/cli.mjs'), 'utf8')).toBe(
      await readFile(join(options.source, 'cli.mjs'), 'utf8')
    )
    const launcher = join(
      installed,
      process.platform === 'win32' ? 'open-science.cmd' : 'open-science'
    )
    const args = ['--prompt', 'hello world', '中文']
    let failure: { status?: number; stdout?: Buffer } | undefined
    try {
      if (process.platform === 'win32')
        execFileSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `""${launcher}" --prompt "hello world" 中文"`],
          { cwd: options.root, windowsVerbatimArguments: true }
        )
      else {
        expect((await stat(launcher)).mode & 0o111).not.toBe(0)
        const link = join(options.root, 'linked-cli')
        await symlink(launcher, link)
        execFileSync(link, args, { cwd: options.root })
      }
    } catch (error) {
      failure = error as typeof failure
    }
    expect(failure?.status, String(failure)).toBe(17)
    const result = JSON.parse(String(failure?.stdout))
    expect(result.args).toEqual(args)
    // macOS resolves /var to /private/var for process.cwd().
    expect(await stat(result.cwd)).toEqual(await stat(options.root))
  }, 30_000)
  it('rejects stale backend and mismatched Node before creating a deliverable', async () => {
    const options = await fixture()
    const manifest = join(options.source, 'package.json')
    const original = JSON.parse(await readFile(manifest, 'utf8'))
    await writeFile(manifest, JSON.stringify({ ...original, version: '1.2.2' }))
    await expect(packRuntimeArchive(options)).rejects.toThrow('Stale backend')
    await writeFile(manifest, JSON.stringify({ ...original, cpu: ['other'] }))
    await expect(packRuntimeArchive(options)).rejects.toThrow('Wrong backend architecture')
    await writeFile(manifest, JSON.stringify(original))
    await writeFile(
      join(options.nodeSource, 'version.json'),
      JSON.stringify({ version: process.versions.node, platform: options.target.os, arch: 'other' })
    )
    await expect(packRuntimeArchive(options)).rejects.toThrow('Wrong Node architecture')
  })
  it('keeps cmd argument forwarding and exit status without delayed expansion', () => {
    expect(archiveLauncher('win32')).toContain('DisableDelayedExpansion')
    expect(archiveLauncher('win32')).toContain('"%~dp0backend\\cli.mjs" %*')
    expect(archiveLauncher('win32')).toContain('exit /b %errorlevel%')
  })
  it('requires all five archives and rejects wrong SHA, corruption and falsified embedded metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-set-'))
    roots.push(root)
    for (const target of runtimeTargets) {
      const stem = archiveStem('1.2.3', target)
      const metadata = {
        version: '1.2.3',
        target: target.id,
        sourceSha: sha,
        nodeVersion: '22.23.3'
      }
      const filename = archiveFilename('1.2.3', target)
      if (target.os === 'win32')
        await writeFile(
          join(root, filename),
          zipSync({ [`${stem}/release.json`]: strToU8(JSON.stringify(metadata)) })
        )
      else {
        await mkdir(join(root, stem))
        await writeFile(join(root, stem, 'release.json'), JSON.stringify(metadata))
        execFileSync(archiveTar, ['-czf', join(root, filename), '-C', root, stem])
      }
      await writeFile(
        join(root, `${target.id}.json`),
        JSON.stringify({ ...metadata, filename, sha256: await sha256(join(root, filename)) })
      )
    }
    expect(await collectRuntimeArchives(root, '1.2.3', sha)).toHaveLength(5)
    await expect(collectRuntimeArchives(root, '1.2.3', 'b'.repeat(40))).rejects.toThrow(
      'source commit'
    )
    const target = runtimeTargets[0]
    const reportPath = join(root, `${target.id}.json`)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    await writeFile(reportPath, JSON.stringify({ ...report, nodeVersion: '0.0.0' }))
    await expect(collectRuntimeArchives(root, '1.2.3', sha)).rejects.toThrow('metadata mismatch')
    await writeFile(reportPath, JSON.stringify(report))
    await writeFile(join(root, report.filename), 'corrupt')
    await expect(collectRuntimeArchives(root, '1.2.3', sha)).rejects.toThrow('checksum mismatch')
    await rm(reportPath)
    await expect(collectRuntimeArchives(root, '1.2.3', sha)).rejects.toThrow('ENOENT')
  })
})
