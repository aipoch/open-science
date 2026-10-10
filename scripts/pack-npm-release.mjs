/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentRuntimeTarget } from '../packages/open-science/runtime-package.mjs'

export async function packTarball(directory, output, npmCli = process.env.npm_execpath) {
  // Bundled dependency file inventories exceed execFileSync's default stdout buffer.
  const reportPath = join(output, `.pack-${randomUUID()}.json`)
  const report = await open(reportPath, 'wx', 0o600)
  try {
    execFileSync(
      process.execPath,
      [npmCli, 'pack', directory, '--json', '--pack-destination', output],
      { stdio: ['ignore', report.fd, 'inherit'] }
    )
    return JSON.parse(await readFile(reportPath, 'utf8'))[0]
  } finally {
    await report.close()
    await rm(reportPath, { force: true })
  }
}
async function main() {
  const root = resolve(import.meta.dirname, '..')
  const target = currentRuntimeTarget()
  const output = join(root, 'out/npm-artifacts')
  await mkdir(output, { recursive: true })
  const packages = []
  for (const folder of ['main', target.id]) {
    const directory = join(root, 'out/npm-release', folder)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    const packed = await packTarball(directory, output)
    const bytes = await readFile(join(output, packed.filename))
    packages.push({
      manifest,
      filename: packed.filename,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    })
  }
  await writeFile(
    join(output, `${target.id}.json`),
    JSON.stringify(
      {
        target: target.id,
        sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8'
        }).trim(),
        packages
      },
      null,
      2
    ) + '\n'
  )
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
