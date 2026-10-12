/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c } from 'tar'
import { load } from 'js-yaml'
import { publicationFiles } from './publish-linux-cli-packages.mjs'
import {
  collectPackages,
  digest,
  lifecycleScript,
  linuxTargets,
  packageIdentity,
  preparePackage,
  rpmSpec,
  validateArchiveEntry
} from './linux-cli-packages.mjs'

const roots: string[] = []
const metadata = {
  version: '0.37.1',
  target: 'linux-x64-gnu',
  sourceSha: 'a'.repeat(40),
  nodeVersion: '22.23.3'
}
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cli package 测试 '))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Linux CLI packages', () => {
  it('limits supplemental publication to four CLI packages and new checksum/provenance files', () => {
    const files = publicationFiles([
      { filename: 'one.deb' },
      { filename: 'two.deb' },
      { filename: 'one.rpm' },
      { filename: 'two.rpm' }
    ])
    expect(files).toEqual([
      'one.deb',
      'two.deb',
      'one.rpm',
      'two.rpm',
      'CLI-PACKAGE-SHA256SUMS.txt',
      'CLI-PACKAGE-PROVENANCE.json'
    ])
    expect(files).not.toContain('SHA256SUMS.txt')
  })
  it('accepts only supported Linux targets and keeps distro architecture identities distinct', () => {
    expect(packageIdentity(metadata)).toMatchObject({ debArch: 'amd64', rpmArch: 'x86_64' })
    expect(packageIdentity({ ...metadata, target: 'linux-arm64-gnu' })).toMatchObject({
      debArch: 'arm64',
      rpmArch: 'aarch64'
    })
    for (const target of ['darwin-arm64', 'linux-x64-musl', '../linux-x64-gnu'])
      expect(() => packageIdentity({ ...metadata, target })).toThrow()
    expect(() => packageIdentity({ ...metadata, version: '0.37.1;echo bad' })).toThrow()
    expect(() => packageIdentity({ ...metadata, sourceSha: 'main' })).toThrow()
  })
  it('rejects traversal, external links, devices and foreign archive directories before extraction', () => {
    const stem = 'open-science-0.37.1-linux-x64-gnu'
    expect(
      validateArchiveEntry(
        `${stem}/backend/lib.so`,
        { type: 'SymbolicLink', linkpath: 'lib.so.1' },
        stem
      )
    ).toBe(true)
    for (const [path, entry] of [
      [`${stem}/../../unowned`, { type: 'File' }],
      [`foreign/file`, { type: 'File' }],
      [`${stem}/link`, { type: 'SymbolicLink', linkpath: '/etc/passwd' }],
      [`${stem}/link`, { type: 'SymbolicLink', linkpath: '../../unowned' }],
      [`${stem}/link`, { type: 'Link', linkpath: 'unowned' }],
      [`${stem}/device`, { type: 'CharacterDevice' }]
    ] as const)
      expect(() => validateArchiveEntry(path, entry, stem)).toThrow()
  })
  it('prepares the original bytes and rejects checksum, target or source-commit substitution', async () => {
    const root = await temporary()
    const stem = `open-science-${metadata.version}-${metadata.target}`
    const source = join(root, stem)
    for (const path of ['backend/out/backend', 'backend/out/web', 'node-runtime'])
      await mkdir(join(source, path), { recursive: true })
    await writeFile(join(source, 'release.json'), JSON.stringify(metadata))
    await writeFile(
      join(source, 'node-runtime/version.json'),
      JSON.stringify({ version: metadata.nodeVersion, platform: 'linux', arch: 'x64' })
    )
    await writeFile(
      join(source, 'backend/package.json'),
      JSON.stringify({ version: metadata.version, os: ['linux'], cpu: ['x64'] })
    )
    const files = [
      'open-science',
      'node-runtime/node',
      'node-runtime/LICENSE',
      'backend/cli.mjs',
      'backend/out/backend/index.cjs',
      'backend/out/web/index.html',
      'backend/LICENSE',
      'backend/.hidden'
    ]
    for (const path of files) await writeFile(join(source, path), `original ${path}\n`)
    const archive = join(root, `${stem}.tar.gz`)
    await c({ file: archive, cwd: root, gzip: true }, [stem])
    const sha = await digest(archive)
    const output = join(root, 'prepared')
    const result = await preparePackage(archive, sha, metadata.sourceSha, metadata.target, output)
    expect(result.sourceArchiveSha256).toBe(sha)
    for (const path of files)
      expect(await digest(join(output, 'payload', path))).toBe(await digest(join(source, path)))
    await expect(
      preparePackage(
        archive,
        'b'.repeat(64),
        metadata.sourceSha,
        metadata.target,
        join(root, 'bad-hash')
      )
    ).rejects.toThrow('checksum')
    await expect(
      preparePackage(archive, sha, 'b'.repeat(40), metadata.target, join(root, 'bad-commit'))
    ).rejects.toThrow('commit')
    await expect(
      preparePackage(archive, sha, metadata.sourceSha, 'linux-arm64-gnu', join(root, 'bad-target'))
    ).rejects.toThrow('filename')
  })
  it('requires four packages with matching source receipts and detects package tampering', async () => {
    const root = await temporary()
    for (const [target, [deb, rpm]] of Object.entries(linuxTargets) as Array<[string, string[]]>) {
      for (const format of ['deb', 'rpm']) {
        const filename =
          format === 'deb'
            ? `open-science-cli_${metadata.version}_${deb}.deb`
            : `open-science-cli-${metadata.version}-1.${rpm}.rpm`
        await writeFile(join(root, filename), `${target}/${format}`)
        await writeFile(
          join(root, `package-${format}-${target}.json`),
          JSON.stringify({
            ...metadata,
            target,
            format,
            filename,
            sha256: await digest(join(root, filename)),
            sourceArchive: `open-science-${metadata.version}-${target}.tar.gz`,
            sourceArchiveSha256: 'c'.repeat(64)
          })
        )
      }
    }
    expect(await collectPackages(root, metadata.version, metadata.sourceSha)).toHaveLength(4)
    expect(
      (await readFile(join(root, 'CLI-PACKAGE-SHA256SUMS.txt'), 'utf8')).trim().split('\n')
    ).toHaveLength(4)
    await expect(collectPackages(root, metadata.version, 'b'.repeat(40))).rejects.toThrow()
    await writeFile(join(root, 'open-science-cli_0.37.1_amd64.deb'), 'changed')
    await expect(collectPackages(root, metadata.version, metadata.sourceSha)).rejects.toThrow(
      'checksum'
    )
  })
  it('retains RPM ELF auto-dependencies and limits exclusions to bundled private libraries/scripts', () => {
    const spec = rpmSpec(metadata, ['libexample.so.1'])
    expect(spec).not.toMatch(/AutoReq(?:Prov)?:\s*(?:no|0)/)
    expect(spec).toContain('%global __requires_exclude ^(libexample\\.so\\.1)')
    expect(spec).toContain('%global __os_install_post %{nil}')
    expect(spec).not.toContain('/usr/local')
    expect(spec).toContain('BuildArch: x86_64')
    expect(spec).toContain('--install')
    expect(spec).toContain("open-science-cli' 90")
  })
})

describe.skipIf(process.platform === 'win32')('package lifecycle boundaries', () => {
  async function fixture(): Promise<{
    root: string
    proc: string
    bin: string
    state: string
    links: string
    invoke: (action: string, argument?: string) => string
  }> {
    const base = await temporary()
    const paths = {
      root: join(base, 'payload'),
      proc: join(base, 'proc'),
      bin: join(base, 'bin'),
      state: join(base, 'state'),
      links: join(base, 'links')
    }
    for (const directory of [...Object.values(paths), join(paths.proc, 'self')])
      await mkdir(directory, { recursive: true })
    const log = join(base, 'alternatives.log')
    for (const manager of ['alternatives', 'update-alternatives']) {
      const file = join(paths.bin, manager)
      await writeFile(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`)
      await chmod(file, 0o755)
    }
    const invoke = (action: string, argument = 'configure'): string =>
      execFileSync('sh', ['-c', lifecycleScript('deb', action, paths), 'hook', argument], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${paths.bin}:${process.env.PATH}` },
        stdio: 'pipe'
      })
    return { ...paths, invoke }
  }
  it('blocks an exact running package executable without touching unrelated processes', async () => {
    const f = await fixture()
    await mkdir(join(f.proc, '123'))
    await symlink('/unrelated/node', join(f.proc, '123/exe'))
    expect(() => f.invoke('preremove', 'remove')).not.toThrow()
    await mkdir(join(f.proc, '456'))
    await symlink(`${f.root}/node-runtime/node`, join(f.proc, '456/exe'))
    expect(() => f.invoke('preinstall', 'upgrade')).toThrow()
    expect(() => f.invoke('preremove', 'remove')).toThrow()
    expect(await readFile(join(f.proc, '123/exe'), 'utf8').catch(() => 'preserved')).toBe(
      'preserved'
    )
  })
  it('refuses unmanaged commands and unregistered alternatives links; preserves registered manual choices', async () => {
    const f = await fixture()
    const command = join(f.bin, 'open-science')
    await writeFile(command, 'user-managed')
    expect(() => f.invoke('install')).toThrow()
    expect(await readFile(command, 'utf8')).toBe('user-managed')
    await rm(command)
    await symlink(join(f.links, 'open-science'), command)
    const other = join(f.root, 'desktop')
    await symlink(other, join(f.links, 'open-science'))
    expect(() => f.invoke('install')).toThrow()
    await writeFile(join(f.state, 'open-science'), `manual\n${command}\n\n${other}\n100\n`)
    expect(() => f.invoke('install')).not.toThrow()
    expect(() => f.invoke('remove', 'upgrade')).not.toThrow()
    expect(() => f.invoke('remove', 'remove')).not.toThrow()
    expect(await readFile(join(f.state, 'open-science'), 'utf8')).toContain('manual')
  })
})

describe('Linux package workflow publication boundary', () => {
  const workflow = async (name: string): Promise<Record<string, any>> =>
    load(
      await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    ) as Record<string, any>
  it('uses the real reusable packaging workflow without publishing in the manual dry-run', async () => {
    const dispatch = await workflow('publish-npm.yml')
    expect(dispatch.on.workflow_dispatch.inputs.distribution.options).toContain('linux-packages')
    expect(dispatch.jobs['linux-packages'].uses).toBe('./.github/workflows/linux-cli-packages.yml')
    const flow = await workflow('linux-cli-packages.yml')
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    const content = JSON.stringify(flow)
    expect(content).not.toContain('--omit=dev')
    expect(content).toContain('gh attestation verify')
    expect(content).toContain('test-linux-cli-package.mjs deb')
    expect(content).toContain('test-linux-cli-package.mjs rpm')
    expect(content).not.toMatch(/gh release (?:upload|create|edit)|contents.:.write|--nodeps/)
  })
  it('gates future publication on all packages and includes rpm checksums/attestations', async () => {
    const flow = await workflow('release.yml')
    expect(flow.jobs['linux-cli-packages'].needs).toBe('cli-artifacts')
    expect(flow.jobs.publish.needs).toContain('linux-cli-packages')
    const steps = flow.jobs.publish.steps
    const gate = steps.findIndex(
      (step: { name: string }) => step.name === 'Verify Linux CLI package set'
    )
    const publish = steps.findIndex(
      (step: { name: string }) => step.name === 'Publish GitHub Release'
    )
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(publish)
    expect(
      steps.find((step: { name: string }) => step.name === 'Generate checksums').run
    ).toContain('*.rpm')
    expect(
      steps.find((step: { name: string }) => step.name === 'Attest build provenance').with[
        'subject-path'
      ]
    ).toContain('artifacts/*.rpm')
    expect(steps[publish].with.files).toContain('artifacts/CLI-PACKAGE-PROVENANCE.json')
  })
})
