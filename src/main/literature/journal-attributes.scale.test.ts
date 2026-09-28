import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { JournalAttributes } from './journal-attributes'
import type { JournalField, JournalImportRow } from '../../shared/journal-attributes'
import type { JournalSheet } from '../../renderer/src/pages/literature/journal-import-file'

// Opt-in scale acceptance; every name, header and value is independently invented.
// JOURNAL_SCALE_PROFILE=rows|wide|text|history|xlsx JOURNAL_SCALE_REPORT=/absolute/report.json
const profiles = {
  rows: { count: 100_000, fields: 2, text: 8, datasets: 1 },
  wide: { count: 20_000, fields: 64, text: 8, datasets: 1 },
  text: { count: 10_000, fields: 2, text: 1800, datasets: 1 },
  history: { count: 25_000, fields: 8, text: 8, datasets: 6 },
  xlsx: { count: 20_000, fields: 8, text: 8, datasets: 1 }
}
const profileName = process.env.JOURNAL_SCALE_PROFILE as keyof typeof profiles | undefined
it.runIf(Boolean(profileName))(
  'measures bounded file parsing, imports, cold queries and main-loop latency',
  async () => {
    if (!profileName || !profiles[profileName]) throw new Error('Unknown journal scale profile')
    const profile = profiles[profileName]
    const root = await mkdtemp(join(tmpdir(), 'journal-scale-'))
    const client = createProjectDbClient(root)
    let service = new JournalAttributes(async () => client)
    const phases: Record<
      string,
      { milliseconds: number; mainLoopMaxMs: number; heapMiB: number; rssMiB: number }
    > = {}
    let sampledPeakRss = process.memoryUsage().rss
    let lastPulse = performance.now()
    let timerDelay = 0
    const sampler = globalThis.setInterval(() => {
      sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss)
      const now = performance.now()
      timerDelay = Math.max(timerDelay, now - lastPulse - 10)
      lastPulse = now
    }, 10)
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    const measure = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      await setTimeout(20)
      histogram.reset()
      timerDelay = 0
      lastPulse = performance.now()
      const started = performance.now()
      const result = await run()
      const milliseconds = performance.now() - started
      sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss)
      await setTimeout(20)
      phases[name] = {
        milliseconds,
        mainLoopMaxMs: Math.max(histogram.max / 1e6, timerDelay),
        heapMiB: process.memoryUsage().heapUsed / 2 ** 20,
        rssMiB: process.memoryUsage().rss / 2 ** 20
      }
      return result
    }
    try {
      await migrateApplicationDatabase(client)
      const fields: JournalField[] = Array.from({ length: profile.fields }, (_, i) => ({
        id: `measure-${i}`,
        label: `Synthetic measure ${i}`,
        kind: i === 0 ? 'number' : 'text',
        colors: {},
        visible: true
      }))
      let csv = [
        'Periodical,' + fields.map(({ label }) => label).join(','),
        ...Array.from({ length: profile.count }, (_, i) =>
          [
            `Imaginary Scale Review ${i}`,
            ...fields.map((_, field) =>
              field === 0
                ? String(i)
                : 'Synthetic '.repeat(Math.ceil(profile.text / 10)).slice(0, profile.text)
            )
          ].join(',')
        )
      ].join('\n')
      let fileBytes = new TextEncoder().encode(csv)
      const fileName = profileName === 'xlsx' ? 'synthetic.xlsx' : 'synthetic.csv'
      if (profileName === 'xlsx') {
        const spreadsheet = await import('styled-exceljs')
        const workbook = spreadsheet.utils.book_new()
        spreadsheet.utils.book_append_sheet(
          workbook,
          spreadsheet.utils.aoa_to_sheet(csv.split('\n').map((line) => line.split(','))),
          'Imaginary periodicals'
        )
        fileBytes = new Uint8Array(spreadsheet.write(workbook, { type: 'array', bookType: 'xlsx' }))
      }
      const fileSize = fileBytes.byteLength
      csv = ''
      const parserPath = join(root, 'parser.mjs')
      await build({
        stdin: {
          contents: `import { parentPort, workerData } from 'node:worker_threads'; import { readJournalFile } from ${JSON.stringify(resolve('src/renderer/src/pages/literature/journal-import-file.ts'))}; parentPort.postMessage(await readJournalFile(workerData.bytes, workerData.name));`,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        outfile: parserPath,
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
        banner: {
          js: "import { createRequire as makeJournalBenchmarkRequire } from 'node:module'; const require = makeJournalBenchmarkRequire(import.meta.url);"
        }
      })
      let sheet: JournalSheet | undefined = await measure(
        'workerFileParseAndTransfer',
        async () => {
          const worker = new Worker(parserPath, {
            workerData: { bytes: fileBytes.buffer, name: fileName },
            transferList: [fileBytes.buffer]
          })
          try {
            return await new Promise<JournalSheet>((resolve, reject) => {
              worker.once('message', resolve)
              worker.once('error', reject)
              worker.once('exit', (code) => {
                if (code) reject(new Error(`Parser exit ${code}`))
              })
            })
          } finally {
            await worker.terminate()
          }
        }
      )
      expect(sheet.rows).toHaveLength(profile.count + 1)
      let latestId = ''
      for (let dataset = 0; dataset < profile.datasets; dataset++) {
        const { token } = await service.run({
          action: 'begin',
          definition: {
            source: `Synthetic source ${Math.floor(dataset / 3)}`,
            year: 2030 + (dataset % 3),
            fields
          },
          policy: 'fill'
        })
        await measure(`append-${dataset}`, async () => {
          for (let offset = 0; offset < profile.count; offset += 100) {
            const rows: JournalImportRow[] = sheet!.rows
              .slice(offset + 1, offset + 101)
              .map((cells, i) => ({
                row: offset + i + 2,
                name: cells[0],
                aliases: [],
                issns: [],
                values: Object.fromEntries(fields.map((field, i) => [field.id, cells[i + 1]]))
              }))
            await service.run({ action: 'append', token: token!, offset, rows })
            await setImmediate() // Model independent IPC deliveries rather than an unbroken microtask chain.
          }
        })
        const preview = await measure(`preview-${dataset}`, () =>
          service.run({ action: 'preview', token: token!, offset: 0 })
        )
        expect(preview.ready).toBe(profile.count)
        const saved = await measure(`commit-${dataset}`, () =>
          service.run({
            action: 'commit',
            token: token!,
            digest: preview.digest!,
            skipProblems: false
          })
        )
        latestId = saved.datasets!.find(
          ({ source, year }) =>
            source === `Synthetic source ${Math.floor(dataset / 3)}` &&
            year === 2030 + (dataset % 3)
        )!.id
      }
      sheet = undefined
      await service.dispose()
      service = new JournalAttributes(async () => client)
      await measure('catalog8Clients', () =>
        Promise.all(Array.from({ length: 8 }, () => service.run({ action: 'list' })))
      )
      const identities = Array.from({ length: 200 }, (_, i) => ({
        name: `Imaginary Scale Review ${i}`,
        aliases: [],
        issns: []
      }))
      expect(
        (
          await measure('coldResolve8Clients200Each', () =>
            Promise.all(
              Array.from({ length: 8 }, () => service.run({ action: 'resolve', identities }))
            )
          )
        ).every((result) => result.matches?.every(({ status }) => status === 'matched'))
      ).toBe(true)
      await measure('warmResolve200', () => service.run({ action: 'resolve', identities }))
      const entries = {
        action: 'entries' as const,
        datasetId: latestId,
        offset: 0,
        query: '',
        sortField: fields[0].id,
        descending: true
      }
      const first = await measure('entriesSort', () => service.run(entries))
      expect(first.entries?.[0].values[fields[0].id]).toBe(String(profile.count - 1))
      await measure('entriesPage', () => service.run({ ...entries, offset: 50 }))
      const found = await measure('entriesSearch', () =>
        service.run({ ...entries, query: 'Review 123' })
      )
      expect(found.total).toBeGreaterThan(0)
      if (profileName === 'rows') {
        await client.$executeRaw`INSERT INTO "LiteratureItem" (id, "itemType", title, "containerTitle", "createdAt", "updatedAt") SELECT 'alignment-' || id, 'journalArticle', name, name, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Journal"`
        service.referencesChanged()
        const aligned = await measure('alignment100kIncrementalWarmJournalIndex', async () => {
          let token: string | undefined
          let processed = 0
          while (true) {
            const step = (await service.run({ action: 'audit-step', token })).scan!
            expect(step.processed - processed).toBeLessThanOrEqual(500)
            processed = step.processed
            token = step.token
            if (step.done) break
          }
          expect(processed).toBe(profile.count)
          return service.run({ action: 'audit', token, status: 'matched', offset: 0 })
        })
        expect(aligned.alignment?.counts.matched).toBe(profile.count)
        expect(aligned.alignment?.rows).toHaveLength(50)
        const referenceRows = await client.$queryRaw<
          { id: string; containerTitle: string }[]
        >`SELECT id, "containerTitle" FROM "LiteratureItem" ORDER BY id LIMIT 200`
        const resolved = await measure('resolve200LocalReferences', () =>
          service.run({
            action: 'resolve',
            identities: referenceRows.map((item) => ({
              itemId: item.id,
              name: item.containerTitle,
              aliases: [],
              issns: []
            }))
          })
        )
        expect(resolved.matches?.every(({ status }) => status === 'matched')).toBe(true)

        await measure('alignmentPage', () =>
          service.run({
            action: 'audit',
            token: aligned.alignment!.token,
            status: 'matched',
            offset: 50
          })
        )
      }
      if (process.env.JOURNAL_SCALE_REPORT)
        await writeFile(
          process.env.JOURNAL_SCALE_REPORT,
          JSON.stringify(
            {
              profile: profileName,
              ...profile,
              fileMiB: fileSize / 2 ** 20,
              sampledPeakRssMiB: sampledPeakRss / 2 ** 20,
              phases
            },
            null,
            2
          )
        )
    } finally {
      globalThis.clearInterval(sampler)
      histogram.disable()
      await service.dispose()
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  },
  240_000
)
