/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Supply equivalent CommonJS builds. Each sample uses a fresh process; OS disk cache is warm.
const [baseline, candidate, repeats = '15'] = process.argv.slice(2)
const count = Number(repeats)
if (!baseline || !candidate || !Number.isSafeInteger(count) || count < 3 || count > 100) {
  throw new Error(
    'Usage: node scripts/performance/profile-native-locales.mjs <baseline.cjs> <candidate.cjs> [3..100 runs]'
  )
}
const sample = `
  const before = process.memoryUsage().heapUsed
  const started = performance.now()
  const { createNativeI18n } = require(process.argv[1])
  const instance = createNativeI18n(process.argv[2])
  const elapsedMs = performance.now() - started
  console.log(JSON.stringify({
    elapsedMs,
    heapDeltaBytes: process.memoryUsage().heapUsed - before,
    translatedLocales: Object.keys(instance.store.data).filter(locale => locale !== 'en').length,
    quit: instance.t('Quit', { context: 'verb' })
  }))
`
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = []
for (const locale of ['en', 'ru']) {
  const runs = { baseline: [], candidate: [] }
  for (let run = 0; run < count; run++) {
    // Alternate ordering to reduce bias from background machine load.
    const order = run % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']
    for (const name of order) {
      const modulePath = resolve(name === 'baseline' ? baseline : candidate)
      const child = spawnSync(process.execPath, ['-e', sample, modulePath, locale], {
        encoding: 'utf8'
      })
      if (child.status !== 0) throw new Error(child.stderr || 'Native locale sample failed')
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1))
      if (result.quit !== (locale === 'en' ? 'Quit' : 'Выйти'))
        throw new Error('Translation regression')
      runs[name].push(result)
    }
  }
  results.push({
    locale,
    runs: count,
    ...Object.fromEntries(
      Object.entries(runs).map(([name, values]) => [
        name,
        {
          medianInitMs: median(values.map((value) => value.elapsedMs)),
          medianHeapDeltaBytes: median(values.map((value) => value.heapDeltaBytes)),
          translatedLocales: values[0].translatedLocales
        }
      ])
    )
  })
}
console.log(
  JSON.stringify(
    {
      methodology:
        'fresh Node processes, import + synchronous init, warm OS cache; not Electron TTI',
      results
    },
    null,
    2
  )
)
