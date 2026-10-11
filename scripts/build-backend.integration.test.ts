import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { createBackendBuilder } from './build-backend.mjs'

it('rebuilds raw resources, worker edits and newly discovered workers without Electron imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-backend-build-'))
  const put = async (file: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }
  const builder = await createBackendBuilder({ root, development: true })
  try {
    await put('package.json', JSON.stringify({ dependencies: {} }))
    await put(
      'src/shared/i18n/locales/de.json',
      JSON.stringify({ common: { a: 'a' }, native: {}, renderer: { hidden: 'hidden' } })
    )
    await put('src/main/message.txt', 'before')
    const entry =
      'import text from "./message.txt?raw"; import worker from "./worker\'s-雪?nodeWorker"; console.log(text); worker().once("message", console.log); export { worker }'
    await put('src/main/node-entry.ts', entry)
    await put(
      "src/main/worker's-雪.ts",
      'import { parentPort } from "node:worker_threads"; parentPort.postMessage("worker-before")'
    )
    expect(await builder.rebuild()).toBe(1)
    const run = (): string =>
      execFileSync(process.execPath, [join(root, 'out/backend/index.cjs')], {
        encoding: 'utf8'
      }).trim()
    expect(run()).toBe('before\nworker-before')
    await put('src/main/message.txt', 'after')
    await put(
      "src/main/worker's-雪.ts",
      'import { parentPort } from "node:worker_threads"; parentPort.postMessage("worker-after")'
    )
    expect(await builder.rebuild()).toBe(1)
    expect(run()).toBe('after\nworker-after')
    const worker = (await readdir(join(root, 'out/backend'))).find(
      (name) => name.startsWith('worker-') && name.endsWith('.cjs')
    )!
    expect(worker).toMatch(/^worker-[a-f0-9]{64}\.cjs$/)
    expect(await readFile(join(root, 'out/backend', worker), 'utf8')).toContain('worker-after')
    await put('src/main/second.ts', 'console.log("second-worker")')
    await put(
      'src/main/node-entry.ts',
      `${entry}; import second from "./second?nodeWorker"; export { second }`
    )
    expect(await builder.rebuild()).toBe(2)
    await put('src/main/node-entry.ts', 'console.log("no-workers")')
    expect(await builder.rebuild()).toBe(0)
    await put(
      'src/shared/i18n/locales/de.json',
      JSON.stringify({ common: { a: 'updated' }, native: {}, renderer: {} })
    )
    await builder.rebuild()
    expect(
      JSON.parse(await readFile(join(root, 'out/backend/native-locales/de.json'), 'utf8'))
    ).toEqual({ common: { a: 'updated' }, native: {} })
    await put('src/main/node-entry.ts', 'import "electron"')
    await expect(builder.rebuild()).rejects.toThrow(/Electron|electron/)
    await put('src/main/node-entry.ts', 'console.log("recovered")')
    await builder.rebuild()
    expect(run()).toBe('recovered')
  } finally {
    await builder.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
