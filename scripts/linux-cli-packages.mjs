/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeTargets } from '../packages/open-science/runtime-package.mjs'

export const packageRoot = '/opt/open-science-cli'
export const linuxTargets = Object.fromEntries(
  runtimeTargets
    .filter((target) => target.os === 'linux')
    .map(({ id, cpu }) => [id, cpu === 'x64' ? ['amd64', 'x86_64'] : ['arm64', 'aarch64']])
)
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
export async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export function packageIdentity(metadata) {
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/)
  assert.match(metadata.sourceSha, /^[a-f0-9]{40}$/)
  assert.match(metadata.nodeVersion, /^\d+\.\d+\.\d+$/)
  assert.ok(Object.hasOwn(linuxTargets, metadata.target), 'Unsupported Linux target')
  const [debArch, rpmArch] = linuxTargets[metadata.target]
  return { ...metadata, debArch, rpmArch }
}
export function validateArchiveEntry(path, entry, stem) {
  assert.ok(path === stem || path.startsWith(`${stem}/`), 'Archive entry outside release directory')
  assert.ok(!path.split('/').includes('..') && !/[\\\n\r]/.test(path), 'Unsafe archive entry')
  assert.ok(
    ['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type),
    'Unsupported archive entry type'
  )
  if (entry.linkpath) {
    assert.ok(
      !posix.isAbsolute(entry.linkpath) && !/[\\\n\r]/.test(entry.linkpath),
      'Unsafe archive link'
    )
    const target =
      entry.type === 'Link'
        ? posix.normalize(entry.linkpath)
        : posix.resolve('/', posix.dirname(path), entry.linkpath).slice(1)
    assert.ok(
      target === stem || target.startsWith(`${stem}/`),
      'Archive link outside release directory'
    )
  }
  return true
}
export async function preparePackage(archive, expectedDigest, expectedSha, target, destination) {
  assert.match(expectedDigest, /^[a-f0-9]{64}$/)
  assert.match(expectedSha, /^[a-f0-9]{40}$/)
  assert.ok(Object.hasOwn(linuxTargets, target), 'Unsupported Linux target')
  assert.equal(await digest(archive), expectedDigest, 'Source archive checksum mismatch')
  const match = /^open-science-(\d+\.\d+\.\d+)-(linux-(?:x64|arm64)-gnu)\.tar\.gz$/.exec(
    posix.basename(archive)
  )
  assert.ok(match && match[2] === target, 'Source archive filename mismatch')
  const stem = `open-science-${match[1]}-${target}`
  const { t, x } = await import('tar')
  // Inspect every link before extraction, including entries appearing after a link.
  const entries = []
  await t({
    file: archive,
    strict: true,
    onReadEntry: (entry) =>
      entries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath })
  })
  for (const entry of entries) validateArchiveEntry(entry.path, entry, stem)
  await mkdir(destination, { recursive: true })
  const extraction = join(destination, 'extracted')
  await mkdir(extraction, { recursive: false })
  try {
    await x({
      file: archive,
      cwd: extraction,
      strict: true,
      preserveOwner: false,
      filter: (path, entry) => validateArchiveEntry(path, entry, stem)
    })
    const source = join(extraction, stem)
    const metadata = packageIdentity(
      JSON.parse(await readFile(join(source, 'release.json'), 'utf8'))
    )
    assert.equal(metadata.version, match[1], 'Source archive version mismatch')
    assert.equal(metadata.sourceSha, expectedSha, 'Source archive commit mismatch')
    assert.equal(metadata.target, target, 'Source archive target mismatch')
    const node = JSON.parse(await readFile(join(source, 'node-runtime/version.json'), 'utf8'))
    assert.equal(node.version, metadata.nodeVersion)
    assert.equal(node.platform, 'linux')
    assert.equal(node.arch, target === 'linux-x64-gnu' ? 'x64' : 'arm64')
    const backend = JSON.parse(await readFile(join(source, 'backend/package.json'), 'utf8'))
    assert.equal(backend.version, metadata.version)
    assert.deepEqual(backend.os, ['linux'])
    assert.deepEqual(backend.cpu, [node.arch])
    for (const path of [
      'open-science',
      'node-runtime/node',
      'node-runtime/LICENSE',
      'backend/cli.mjs',
      'backend/out/backend/index.cjs',
      'backend/out/web/index.html',
      'backend/LICENSE'
    ])
      assert.ok((await stat(join(source, path))).isFile(), `Missing payload: ${path}`)
    await cp(source, join(destination, 'payload'), {
      recursive: true,
      errorOnExist: true,
      force: false
    })
    const provenance = {
      ...metadata,
      sourceArchive: posix.basename(archive),
      sourceArchiveSha256: expectedDigest
    }
    await writeFile(join(destination, 'source.json'), JSON.stringify(provenance, null, 2) + '\n', {
      flag: 'wx'
    })
    return provenance
  } finally {
    await rm(extraction, { recursive: true, force: true })
  }
}

export function lifecycleScript(
  format,
  action,
  {
    root = packageRoot,
    proc = '/proc',
    bin = '/usr/bin',
    state = format === 'deb' ? '/var/lib/dpkg/alternatives' : '/var/lib/alternatives',
    links = '/etc/alternatives'
  } = {}
) {
  for (const path of [root, proc, bin, state, links]) assert.match(path, /^\/[^\0\r\n']+$/)
  assert.ok(['deb', 'rpm'].includes(format))
  assert.ok(['preinstall', 'install', 'preremove', 'remove'].includes(action))
  const manager = format === 'deb' ? 'update-alternatives' : 'alternatives'
  const upgrade = format === 'deb' ? '' : '[ "${1:-0}" -eq 0 ] || exit 0\n'
  const removeGuard =
    format === 'deb' ? 'case "${1:-}" in remove|purge) ;; *) exit 0 ;; esac\n' : upgrade
  const guard = `
check_links() {
  if [ -e '${bin}/open-science' ] || [ -L '${bin}/open-science' ]; then
    [ -L '${bin}/open-science' ] && [ "$(readlink '${bin}/open-science')" = '${links}/open-science' ] || {
      echo 'Refusing to replace an unmanaged open-science command.' >&2; exit 1;
    }
  fi
  if [ -e '${state}/open-science' ]; then
    [ "$(sed -n '2p' '${state}/open-science')" = '${bin}/open-science' ] || {
      echo 'Refusing to repurpose another alternatives group.' >&2; exit 1;
    }
  fi
  if [ -e '${links}/open-science' ] || [ -L '${links}/open-science' ]; then
    [ -L '${links}/open-science' ] && [ -f '${state}/open-science' ] &&
      grep -Fxq -- "$(readlink '${links}/open-science')" '${state}/open-science' || {
      echo 'Refusing to modify an unregistered alternatives target.' >&2; exit 1;
    }
  fi
}
check_stopped() {
  [ -d '${proc}/self' ] || { echo 'Cannot verify running processes; stop all profiles and retry on Linux.' >&2; exit 1; }
  for executable in '${proc}'/[0-9]*/exe; do
    target=$(readlink "$executable" 2>/dev/null) || continue
    case "$target" in '${root}/'* )
      echo 'Stop all profiles started by open-science-cli before upgrading or removing this package.' >&2
      exit 1 ;;
    esac
  done
}
`
  let body
  if (action === 'preinstall') {
    const ownership =
      format === 'deb'
        ? `dpkg-query -S '${bin}/open-science-cli' 2>/dev/null | grep -Fxq 'open-science-cli: ${bin}/open-science-cli'`
        : `[ "$(rpm -qf --qf '%{NAME}' '${bin}/open-science-cli' 2>/dev/null)" = 'open-science-cli' ]`
    body = `check_stopped\ncheck_links\nif [ -e '${bin}/open-science-cli' ] || [ -L '${bin}/open-science-cli' ]; then\n  ${ownership} || { echo 'Refusing to adopt an unowned open-science-cli command.' >&2; exit 1; }\nfi\n`
  } else if (action === 'install')
    body = `check_links\n${manager} --install '${bin}/open-science' open-science '${bin}/open-science-cli' 90\n`
  else if (action === 'preremove')
    body = `${format === 'rpm' ? upgrade : ''}check_stopped\ncheck_links\n`
  else
    body = `${removeGuard}check_links\n${manager} --remove open-science '${bin}/open-science-cli'\n`
  return `#!/bin/sh\nset -eu\n${guard}${body}`
}

async function elfFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await elfFiles(path)))
    else if (entry.isFile()) {
      const handle = await open(path, 'r')
      const header = Buffer.alloc(4)
      try {
        await handle.read(header, 0, 4, 0)
      } finally {
        await handle.close()
      }
      if (header.toString('hex') === '7f454c46') files.push(path)
    }
  }
  return files
}
export function rpmSpec(metadata, bundledSonames) {
  const identity = packageIdentity(metadata)
  const escaped = bundledSonames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return `# Preserve the already certified runtime; never strip or rewrite its binaries.
%global __os_install_post %{nil}
%global debug_package %{nil}
%global __provides_exclude_from ^/opt/open-science-cli/.*$
# Bundled JavaScript uses the private Node launcher, not a distribution Node interpreter.
%global __requires_exclude_from ^/opt/open-science-cli/.*\\.(js|mjs|cjs)$
${escaped.length ? `%global __requires_exclude ^(${escaped.join('|')})(\\(.*\\))?$\n` : ''}Name: open-science-cli
Version: ${identity.version}
Release: 1
Summary: Open-Science standalone CLI and local Web runtime
License: Apache-2.0
URL: https://github.com/aipoch/open-science
BuildArch: ${identity.rpmArch}
Requires: libsecret, dbus, systemd, bubblewrap, coreutils, grep, sed
Requires(pre): alternatives
Requires(post): alternatives
Requires(preun): alternatives
Requires(postun): alternatives

%description
Open-Science CLI, backend, Web UI and a private Node runtime. No Electron or
system Node is required. User data is preserved on removal. Stop all package
profiles before upgrading or removing; unlock the OS credential vault to run.

%install
mkdir -p %{buildroot}
cp -a %{_sourcedir}/tree/. %{buildroot}/

%pre -p /bin/sh
${lifecycleScript('rpm', 'preinstall').replaceAll('%', '%%')}
%post -p /bin/sh
${lifecycleScript('rpm', 'install').replaceAll('%', '%%')}
%preun -p /bin/sh
${lifecycleScript('rpm', 'preremove').replaceAll('%', '%%')}
%postun -p /bin/sh
${lifecycleScript('rpm', 'remove').replaceAll('%', '%%')}

%files
%dir /opt/open-science-cli
/opt/open-science-cli/*
/usr/bin/open-science-cli
/usr/share/doc/open-science-cli
`
}
export async function buildPackage(format, prepared, output) {
  assert.equal(process.platform, 'linux', 'Build Linux packages on Linux')
  assert.ok(['deb', 'rpm'].includes(format), 'Unsupported package format')
  const provenance = JSON.parse(await readFile(join(prepared, 'source.json'), 'utf8'))
  const identity = packageIdentity(provenance)
  assert.equal(
    process.arch,
    identity.target === 'linux-x64-gnu' ? 'x64' : 'arm64',
    'Build on the native target'
  )
  const embedded = JSON.parse(await readFile(join(prepared, 'payload/release.json'), 'utf8'))
  for (const key of ['version', 'target', 'sourceSha', 'nodeVersion'])
    assert.equal(embedded[key], identity[key])
  await mkdir(output, { recursive: true })
  const work = join(output, `.build-${format}-${identity.target}`)
  await mkdir(work, { recursive: false })
  const tree = join(work, 'tree')
  try {
    await cp(join(prepared, 'payload'), join(tree, packageRoot), { recursive: true })
    await mkdir(join(tree, 'usr/bin'), { recursive: true })
    const { symlink } = await import('node:fs/promises')
    await symlink(`${packageRoot}/open-science`, join(tree, 'usr/bin/open-science-cli'))
    const docs = join(tree, 'usr/share/doc/open-science-cli')
    await mkdir(docs, { recursive: true })
    await cp(join(prepared, 'source.json'), join(docs, 'source.json'))
    await cp(join(tree, packageRoot, 'backend/LICENSE'), join(docs, 'copyright'))
    await writeFile(
      join(docs, 'README'),
      'Stop all open-science-cli profiles before upgrading or removing.\nRemoval and purge preserve research data and credentials.\nUse an unlocked OS vault; Python/R and user namespaces need separate setup.\nhttps://github.com/aipoch/open-science/blob/v' +
        identity.version +
        '/docs/standalone-runtime.md\n'
    )
    const elfs = await elfFiles(join(tree, packageRoot))
    assert.ok(elfs.length, 'No native payload')
    let filename
    if (format === 'deb') {
      const debian = join(tree, 'DEBIAN')
      await mkdir(debian)
      // dpkg-shlibdeps emits actual library/ABI version constraints. Private libraries
      // have no distro shlibs record; their resolution is additionally checked at install.
      const source = join(work, 'debian')
      await mkdir(source)
      await writeFile(
        join(source, 'control'),
        'Source: open-science-cli\nSection: science\nPriority: optional\nMaintainer: aipoch\n\nPackage: open-science-cli\nArchitecture: any\nDescription: Open-Science standalone runtime\n'
      )
      const libraries = [...new Set(elfs.map(dirname))]
      const dependencyOutput = run(
        'dpkg-shlibdeps',
        [
          '-O',
          '--ignore-missing-info',
          ...libraries.map((path) => `-l${path}`),
          ...elfs.map((path) => `-e${path}`)
        ],
        { cwd: work }
      )
      const detected = dependencyOutput.match(/^shlibs:Depends=(.*)$/m)?.[1]
      assert.ok(detected?.includes('libc6'), 'Missing ELF dependency evidence')
      await writeFile(
        join(debian, 'control'),
        `Package: open-science-cli\nVersion: ${identity.version}\nArchitecture: ${identity.debArch}\nSection: science\nPriority: optional\nMaintainer: aipoch\nHomepage: https://github.com/aipoch/open-science\nDepends: ${detected}, libsecret-1-0, libdbus-1-3, dbus, systemd, bubblewrap, coreutils, grep, sed\nDescription: Open-Science standalone CLI and local Web runtime\n Includes a private Node runtime, backend and Web UI without Electron.\n Stop all package profiles before upgrading or removing. Research data and\n credentials are preserved. OS vault and Python/R setup remain user managed.\n`
      )
      for (const [name, action] of [
        ['preinst', 'preinstall'],
        ['postinst', 'install'],
        ['prerm', 'preremove'],
        ['postrm', 'remove']
      ]) {
        await writeFile(join(debian, name), lifecycleScript(format, action))
        await chmod(join(debian, name), 0o755)
      }
      filename = `open-science-cli_${identity.version}_${identity.debArch}.deb`
      run('dpkg-deb', ['--root-owner-group', '--build', tree, join(output, filename)], {
        stdio: 'inherit'
      })
      await writeFile(join(output, `dependencies-${identity.target}.txt`), dependencyOutput)
    } else {
      const sonames = new Set()
      for (const file of elfs) {
        for (const match of run('readelf', ['-d', file]).matchAll(/\(SONAME\).*\[([^\]]+)\]/g))
          sonames.add(match[1])
      }
      const top = join(work, 'rpm')
      for (const folder of ['BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS'])
        await mkdir(join(top, folder), { recursive: true })
      await cp(tree, join(top, 'SOURCES/tree'), { recursive: true })
      const spec = join(top, 'SPECS/open-science-cli.spec')
      await writeFile(spec, rpmSpec(identity, [...sonames].sort()))
      run('rpmbuild', ['-bb', '--define', `_topdir ${top}`, spec], { stdio: 'inherit' })
      const rpms = (await readdir(join(top, 'RPMS', identity.rpmArch))).filter((path) =>
        path.endsWith('.rpm')
      )
      assert.equal(rpms.length, 1)
      filename = rpms[0]
      await cp(join(top, 'RPMS', identity.rpmArch, filename), join(output, filename))
      await writeFile(
        join(output, `dependencies-rpm-${identity.target}.txt`),
        run('rpm', ['-qp', '--requires', join(output, filename)])
      )
    }
    const report = { ...provenance, format, filename, sha256: await digest(join(output, filename)) }
    await writeFile(
      join(output, `package-${format}-${identity.target}.json`),
      JSON.stringify(report, null, 2) + '\n'
    )
    return report
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
export async function collectPackages(directory, expectedVersion, expectedSha) {
  const reports = []
  for (const target of Object.keys(linuxTargets))
    for (const format of ['deb', 'rpm']) {
      const report = JSON.parse(
        await readFile(join(directory, `package-${format}-${target}.json`), 'utf8')
      )
      const identity = packageIdentity(report)
      assert.equal(identity.version, expectedVersion)
      assert.equal(identity.sourceSha, expectedSha)
      assert.equal(report.target, target)
      assert.equal(report.format, format)
      const filename =
        format === 'deb'
          ? `open-science-cli_${identity.version}_${identity.debArch}.deb`
          : `open-science-cli-${identity.version}-1.${identity.rpmArch}.rpm`
      assert.equal(report.filename, filename)
      assert.equal(
        report.sha256,
        await digest(join(directory, filename)),
        'Package checksum mismatch'
      )
      assert.match(report.sourceArchiveSha256, /^[a-f0-9]{64}$/)
      assert.equal(report.sourceArchive, `open-science-${identity.version}-${target}.tar.gz`)
      const sibling = reports.find((item) => item.target === target)
      if (sibling)
        assert.equal(
          report.sourceArchiveSha256,
          sibling.sourceArchiveSha256,
          'Package source mismatch'
        )
      reports.push(report)
    }
  await writeFile(
    join(directory, 'CLI-PACKAGE-SHA256SUMS.txt'),
    reports.map((report) => `${report.sha256}  ${report.filename}\n`).join('')
  )
  await writeFile(
    join(directory, 'CLI-PACKAGE-PROVENANCE.json'),
    JSON.stringify(
      { version: expectedVersion, sourceSha: expectedSha, packages: reports },
      null,
      2
    ) + '\n'
  )
  return reports
}
async function main() {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === 'prepare')
    console.log(await preparePackage(args[0], args[1], args[2], args[3], resolve(args[4])))
  else if (mode === 'verify') console.log(await collectPackages(resolve(args[0]), args[1], args[2]))
  else console.log(await buildPackage(mode, resolve(args[0]), resolve(args[1])))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
