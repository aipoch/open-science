import { execFileSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
if (!process.argv.includes('--assets-only')) {
  rmSync(join(root, 'dist'), { recursive: true, force: true })
  execFileSync(process.execPath, [join(root, 'tsc.cjs'), '-p', join(root, 'tsconfig.json')], {
    cwd: root,
    stdio: 'inherit'
  })
}
// Keep the public modules and declarations intact; only the private tokenizer needs bundling.
await build({
  absWorkingDir: root,
  entryPoints: ['src/protocols/messages/tokens.ts'],
  outfile: 'dist/protocols/messages/tokens.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'inline'
})
copyFileSync(join(root, 'THIRD-PARTY-NOTICES'), join(root, 'dist/tokenizer-LICENSE.txt'))
