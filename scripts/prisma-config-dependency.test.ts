import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

// Resolve through the real consumer, so a vulnerable nested copy cannot be hidden
// by a fixed root dependency. Native Node also exercises Prisma's dynamic imports.
const require = createRequire(import.meta.url)
const prismaRequire = createRequire(require.resolve('prisma/package.json'))
const configPath = prismaRequire.resolve('@prisma/config')
const prelude = `
  const assert = require('node:assert/strict');
  const { createRequire } = require('node:module');
  const configRequire = createRequire(${JSON.stringify(configPath)});
  const { deepmerge, deepmergeInto } = configRequire('deepmerge-ts');
`
let fixture: string | undefined

function runNode(source: string): void {
  const result = spawnSync(process.execPath, ['-e', prelude + source], {
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
}

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

describe('Prisma config dependency compatibility', () => {
  it('handles recursive records without stack exhaustion (CVE-2026-40345)', () => {
    runNode(`
      const left = { left: true };
      left.self = left;
      const right = { right: true };
      right.self = right;
      const merged = deepmerge(left, right);
      assert.equal(merged.left, true);
      assert.equal(merged.right, true);
      assert.equal(merged.self, merged);
      const target = {};
      target.self = target;
      deepmergeInto(target, right);
      assert.equal(target.right, true);
      assert.equal(target.self, target);
    `)
  })

  it('preserves plain config merge values and leaves inputs unchanged', () => {
    runNode(`
      const left = {
        schema: 'old.prisma',
        migrations: { path: 'migrations', seed: 'node seed.mjs' },
        tables: { external: ['existing'] }
      };
      const right = {
        schema: 'schema.prisma',
        migrations: { seed: 'node next.mjs' },
        tables: { external: ['next'] }
      };
      const before = JSON.stringify([left, right]);
      assert.deepEqual(deepmerge(left, right), {
        schema: 'schema.prisma',
        migrations: { path: 'migrations', seed: 'node next.mjs' },
        tables: { external: ['existing', 'next'] }
      });
      assert.equal(JSON.stringify([left, right]), before);
    `)
  })

  it.each(['cjs', 'mts'])(
    'loads a real %s config and preserves missing-config behavior',
    (extension) => {
      fixture = mkdtempSync(join(tmpdir(), 'prisma-config-compatibility-'))
      const configFile = join(fixture, `prisma.config.${extension}`)
      writeFileSync(
        configFile,
        `${extension === 'cjs' ? 'module.exports =' : 'export default'} {
        schema: './prisma/schema.prisma',
        migrations: { path: './prisma/migrations', seed: 'node seed.mjs' }
      }`
      )
      runNode(`
      const { join } = require('node:path');
      const { loadConfigFromFile } = require(${JSON.stringify(configPath)});
      const root = ${JSON.stringify(fixture)};
      (async () => {
        const loaded = await loadConfigFromFile({
          configRoot: root, configFile: ${JSON.stringify(configFile)}
        });
        assert.equal(loaded.error, undefined);
        assert.equal(loaded.resolvedPath, ${JSON.stringify(configFile)});
        assert.equal(loaded.config.schema, join(root, 'prisma', 'schema.prisma'));
        assert.equal(loaded.config.migrations.path, join(root, 'prisma', 'migrations'));
        assert.equal(loaded.config.migrations.seed, 'node seed.mjs');
        const absent = await loadConfigFromFile({ configRoot: join(root, 'absent') });
        assert.equal(absent.error, undefined);
        assert.equal(absent.resolvedPath, null);
        const missing = await loadConfigFromFile({
          configRoot: root, configFile: join(root, 'missing.config.ts')
        });
        assert.equal(missing.error._tag, 'ConfigFileNotFound');
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `)
    }
  )
})
