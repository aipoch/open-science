import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

// Exercise the real npm development recipe. Only the external compiler and unrelated builds are
// fixtures: a stale helper must be replaced before the backend can use it.
it.skipIf(process.platform !== 'win32').each(['stale', 'missing', 'compiler-failure'] as const)(
  'prepares the Windows Notebook host before the dev backend (%s)',
  (scenario) => {
    const root = resolve('.')
    const fixture = mkdtempSync(join(tmpdir(), 'os-dev-host-'))
    const vendor = 'packages/notebook-network-sandbox/vendor'
    const helper = `${vendor}/windows/${process.arch}/notebook-appcontainer-host.exe`
    const put = (path: string, content: string): void => {
      mkdirSync(dirname(join(fixture, path)), { recursive: true })
      writeFileSync(join(fixture, path), content)
    }
    try {
      const original = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      put(
        'package.json',
        JSON.stringify({
          type: 'module',
          scripts: {
            ...original.scripts,
            'build:packages:dev': 'node -e ""',
            'build:backend-native': 'node -e ""'
          }
        })
      )
      for (const file of ['windows/build.mjs', 'build-common.mjs']) {
        put(`${vendor}/${file}`, readFileSync(join(root, vendor, file), 'utf8'))
      }
      // Copy build entry scripts verbatim when present, so the fixture follows the current recipe.
      for (const file of ['scripts/build-notebook-host.mjs']) {
        try {
          put(file, readFileSync(join(root, file), 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      put(`${vendor}/windows-src/Cargo.toml`, '[package]\nname="fixture"\nversion="0.0.0"\n')
      if (scenario !== 'missing') put(helper, 'obsolete AppContainer host')
      put(
        'scripts/build-backend.mjs',
        `
      import assert from 'node:assert/strict';
      import {readFileSync,writeFileSync} from 'node:fs';
      writeFileSync('backend-started', 'started');
      assert.equal(readFileSync(${JSON.stringify(helper)}, 'utf8'), 'current AppContainer host',
        'dev must not start with an obsolete Notebook AppContainer host');
    `
      )
      // Pi is unrelated to the Windows host ordering exercised by this fixture.
      put('scripts/build-pi-acp.mjs', '')
      // Node renamed to cargo.exe is a portable external-compiler fixture. It executes the file
      // named "build", accepting the actual Cargo arguments supplied by the production build script.
      mkdirSync(join(fixture, 'bin'))
      copyFileSync(process.execPath, join(fixture, 'bin/cargo.exe'))
      put(
        'build',
        `
      import {mkdirSync,writeFileSync} from 'node:fs';
      import {dirname,join} from 'node:path';
      if (process.env.FIXTURE_COMPILER_FAILURE === '1') {
        console.error('fixture compiler failed');
        process.exit(17);
      }
      const args=process.argv.slice(2);
      const source=dirname(args[args.indexOf('--manifest-path')+1]);
      const target=args[args.indexOf('--target')+1];
      const output=join(source,'target',target,'release','notebook-appcontainer-host.exe');
      mkdirSync(dirname(output),{recursive:true});
      writeFileSync(output,'current AppContainer host');
    `
      )
      const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      const result = spawnSync(process.execPath, [npm, 'run', 'build:backend:dev'], {
        cwd: fixture,
        env: {
          ...process.env,
          FIXTURE_COMPILER_FAILURE: scenario === 'compiler-failure' ? '1' : '0',
          PATH: [join(fixture, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter)
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000
      })
      expect(result.error, result.stderr).toBeUndefined()
      if (scenario === 'compiler-failure') {
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('fixture compiler failed')
        expect(existsSync(join(fixture, 'backend-started'))).toBe(false)
        expect(readFileSync(join(fixture, helper), 'utf8')).toBe('obsolete AppContainer host')
        return
      }
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(readFileSync(join(fixture, helper), 'utf8')).toBe('current AppContainer host')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  },
  45_000
)

it.skipIf(process.platform === 'win32')(
  'does not require the Windows compiler on other hosts',
  () => {
    const result = spawnSync(process.execPath, ['scripts/build-notebook-host.mjs'], {
      env: { ...process.env, PATH: '' },
      encoding: 'utf8',
      timeout: 10_000
    })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  }
)
