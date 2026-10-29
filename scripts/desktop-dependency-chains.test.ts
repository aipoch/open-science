import { execFileSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import {
  backendDependencyIncludes,
  createDesktopDependencyFilter
} from './backend-dependencies.mjs'
import {
  assertPrivateDependencyChain,
  stageDesktopDependencyChain
} from './desktop-dependency-chains.mjs'

it('rejects separate consumers of private state while allowing stateless compiler helpers', () => {
  const included = new Set(['tsyringe', '@swc/helpers', 'tslib'])
  expect(() => assertPrivateDependencyChain('tsyringe', included)).toThrow('External consumer')
  expect(() => assertPrivateDependencyChain('@swc/helpers', included)).toThrow('External consumer')
  expect(() => assertPrivateDependencyChain('tslib', included)).not.toThrow()
  expect(() => assertPrivateDependencyChain('other', included)).not.toThrow()
})

it('keeps unknown root versions on the normal copy path', async () => {
  for (const name of ['fontkit', '@peculiar/x509', 'other'])
    expect(
      await stageDesktopDependencyChain({ name, version: '99' }, 'missing', 'unused')
    ).toBeUndefined()
})

it('runs fonts and the actual local CA from isolated consolidated packages and retains unknown closures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-dependency-chains-'))
  const repository = process.cwd()
  const dependencies = await realpath(join(repository, 'node_modules'))
  const require = createRequire(import.meta.url)
  const copied = new Set<string>()
  const copyPackage = async (name: string, from: string, variant: string): Promise<void> => {
    let source = dirname(createRequire(join(from, 'package.json')).resolve(name))
    for (;;) {
      const pkg = await readFile(join(source, 'package.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => ({}))
      if (pkg.name === name) break
      const parent = dirname(source)
      if (parent === source) throw new Error(`Missing package ${name}`)
      source = parent
    }
    const packagePath = relative(dependencies, source)
    if (isAbsolute(packagePath) || packagePath.split(sep).includes('..'))
      throw new Error(`Dependency is outside the installed tree: ${source}`)
    const destination = join(root, variant, 'node_modules', packagePath)
    if (copied.has(destination)) return
    copied.add(destination)
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    const chain =
      variant === 'bundled'
        ? await stageDesktopDependencyChain(pkg, source, destination)
        : undefined
    if (!chain) {
      const includes = createDesktopDependencyFilter(pkg)
      await cp(source, destination, {
        recursive: true,
        filter: async (path) => {
          const file = relative(source, path)
          return (
            backendDependencyIncludes(pkg, file) && includes(file, (await stat(path)).isDirectory())
          )
        }
      })
    }
    for (const dependency of Object.keys(pkg.dependencies ?? {}))
      if (!chain?.has(dependency)) await copyPackage(dependency, source, variant)
  }
  try {
    for (const variant of ['baseline', 'bundled']) {
      await mkdir(join(root, variant), { recursive: true })
      for (const name of ['fontkit', '@peculiar/x509', 'reflect-metadata'])
        await copyPackage(name, repository, variant)
      await build({
        entryPoints: [
          join(repository, 'packages/notebook-network-sandbox/runtime/src/gateway/local-ca.ts')
        ],
        outfile: join(root, variant, 'local-ca.cjs'),
        bundle: true,
        packages: 'external',
        platform: 'node',
        target: 'node22',
        format: 'cjs'
      })
      await writeFile(
        join(root, variant, 'probe.mjs'),
        `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        import { readFileSync } from 'node:fs';
        import { X509Certificate } from 'node:crypto';
        import { createServer, connect } from 'node:tls';
        import { once } from 'node:events';
        import * as fontkit from 'fontkit';
        const require = createRequire(import.meta.url);
        const cjs = require('fontkit');
        const bytes = readFileSync(process.argv[2]);
        const baseline = require(process.argv[3]);
        const summarize = f => { const run = f.layout('Science 科学 123'); return { glyphs: run.glyphs.map(g=>g.id), positions: run.positions.map(p=>({...p})) }; };
        const expected = summarize(baseline.create(bytes));
        for (const font of [fontkit.create(bytes), cjs.create(bytes), fontkit.openSync(process.argv[2]), await fontkit.open(process.argv[2])])
          assert.deepEqual(summarize(font), expected);
        const subset = f => { const s = f.createSubset(); for(const glyph of f.layout('科学 ABC').glyphs) s.includeGlyph(glyph); return s.encode(); };
        assert.deepEqual(subset(cjs.create(bytes)), subset(baseline.create(bytes)));
        const {createLocalCertificateAuthority} = require('./local-ca.cjs');
        const ca = await createLocalCertificateAuthority();
        const other = await createLocalCertificateAuthority();
        const root = new X509Certificate(ca.certificatePem);
        assert.equal(root.ca, true);
        const x509 = await import('@peculiar/x509');
        assert.equal(x509.X509Certificate, require('@peculiar/x509').X509Certificate);
        assert.deepEqual(Object.keys(require('@peculiar/x509')).sort(), JSON.parse(process.argv[4]));
        assert.ok(new x509.X509Certificate(ca.certificatePem) instanceof require('@peculiar/x509').X509Certificate);
        const context = await ca.getSecureContext('example.test');
        assert.equal(await ca.getSecureContext('example.test'), context);
        assert.notEqual(await other.getSecureContext('example.test'), context);
        for(const host of ['*.example.test','127.0.0.1','bad/name']) await assert.rejects(ca.getSecureContext(host));
        const server = createServer({SNICallback:(_host, done)=>done(null,context)}, socket=>socket.end());
        server.on('tlsClientError',()=>{}); server.listen(0,'127.0.0.1'); await once(server,'listening');
        try {
          const client = connect({port:server.address().port,host:'127.0.0.1',servername:'example.test',ca:ca.certificatePem});
          await once(client,'secureConnect'); assert.equal(client.authorized,true);
          assert.equal(client.getPeerCertificate().subjectaltname,'DNS:example.test');
          assert.ok(new X509Certificate(client.getPeerCertificate().raw).verify(root.publicKey)); client.destroy();
          for(const options of [{servername:'wrong.test',ca:ca.certificatePem},{servername:'example.test',ca:other.certificatePem}]) {
            const rejected=connect({port:server.address().port,host:'127.0.0.1',...options});
            await assert.rejects(once(rejected,'secureConnect')); rejected.destroy();
          }
        } finally { server.close(); ca.dispose(); other.dispose(); }
        await assert.rejects(ca.getSecureContext('example.test'), /closed/);
        const pendingCa = await createLocalCertificateAuthority();
        const pending = pendingCa.getSecureContext('pending.test'); pendingCa.dispose(); await assert.rejects(pending);
        console.log('Fonts, subset, exact-host TLS, trust rejection, reflection identity and CA disposal passed');
      `
      )
      const originalX509 = await readFile(require.resolve('@peculiar/x509'), 'utf8')
      const exports = [
        ...new Set(
          [...originalX509.matchAll(/^exports\.([A-Za-z0-9_$]+) =/gm)].map((match) => match[1])
        )
      ].sort()
      expect(
        execFileSync(
          process.execPath,
          [
            join(root, variant, 'probe.mjs'),
            join(repository, 'packages/pdf-translation/resources/NotoSansSC-Regular.otf'),
            join(root, 'baseline/node_modules/fontkit'),
            JSON.stringify(exports)
          ],
          { encoding: 'utf8', timeout: 30_000 }
        )
      ).toContain('CA disposal passed')
    }
    await expect(
      readFile(join(root, 'bundled/node_modules/tsyringe/package.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(root, 'bundled/node_modules/@swc/helpers/package.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const notice = await readFile(
      join(root, 'bundled/node_modules/@peculiar/x509/THIRD-PARTY-NOTICES.txt'),
      'utf8'
    )
    for (const version of [
      'tslib@1.14.1',
      'tslib@2.8.1',
      'tsyringe@4.10.0',
      '@peculiar/asn1-schema@2.9.4'
    ])
      expect(notice).toContain(version)
    for (const name of ['fontkit', '@peculiar/x509']) {
      const source = join(root, 'baseline/node_modules', name)
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
      const dependency = name === 'fontkit' ? '@swc/helpers' : 'tsyringe'
      const file = join(root, 'baseline/node_modules', dependency, 'package.json')
      const pkg = JSON.parse(await readFile(file, 'utf8'))
      pkg.version = '99'
      await writeFile(file, JSON.stringify(pkg))
      const target = join(root, 'unknown', name)
      expect(await stageDesktopDependencyChain(manifest, source, target)).toBeUndefined()
      await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
