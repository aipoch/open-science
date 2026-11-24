/* eslint-disable @typescript-eslint/explicit-function-return-type -- Task-specific experiment runner. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const service = 'src/main/literature/synthesis.ts'
const sources = 'src/main/literature/synthesis-sources.ts'
const store = 'src/main/literature/synthesis-store.ts'
const workspace = 'src/renderer/src/pages/literature/synthesis/LiteratureSynthesisWorkspace.tsx'
const pdf = 'src/renderer/src/pages/workspace/previews/renderers/PdfPreview.tsx'
const contract = 'src/shared/literature-synthesis.ts'
const referenceSearch = 'src/renderer/src/pages/literature/synthesis/SynthesisReferenceSearch.tsx'
const variants = [
  { name: 'baseline', control: true },
  {
    name: 'stale-draft-guard-in-retry',
    file: workspace,
    from: 'if (!dirtyRef.current)',
    to: 'if (!dirty)',
    witness: 'rejects an older append retry after the user edits the current draft',
    additionalWitnesses: ['rejects an older export retry after the user edits the current draft'],
    witnessError: 'Unable to find role'
  },
  {
    name: 'parallel-initial-list-and-candidates',
    file: workspace,
    from: 'void loadNotes()\n        .then(() => {\n          if (alive.current) beginCandidates()\n        })',
    to: 'beginCandidates()\n      void loadNotes()',
    witness: 'waits for the initial list before creating',
    additionalWitnesses: ['keeps initial list failures in the notes view']
  },
  {
    name: 'restore-arbitrary-author-character-cap',
    file: contract,
    from: 'authors: z.string(),\n    year:',
    to: 'authors: z.string().max(20000),\n    year:',
    witness: 'preserves a large collaboration author list within the existing byte budgets',
    witnessError: 'Too big: expected string to have <=20000 characters'
  },
  {
    name: 'retain-search-state-after-candidate-cancel',
    file: workspace,
    replacements: [
      {
        from: '                        <SynthesisReferenceSearch\n                          itemIds={candidateState.itemIds}\n                          disabled={busy}\n                          onAdd={addReference}\n                        />',
        to: ''
      },
      {
        from: "            {mode === 'candidates' && candidateState ? (",
        to: "            <div hidden={mode !== 'candidates'}><SynthesisReferenceSearch itemIds={candidateState?.itemIds ?? []} disabled={busy} onAdd={addReference} /></div>\n            {mode === 'candidates' && candidateState ? ("
      }
    ],
    witness: 'discards an earlier reference search after canceling'
  },
  {
    name: 'without-export-revision-check',
    file: service,
    from: "request.action === 'export' && note.revision !== request.expectedRevision",
    to: 'false',
    witness: 'rejects exporting a revision the current viewer has not reviewed',
    witnessError: 'instead of rejecting'
  },
  {
    name: 'restore-unrelated-markdown-character-cap',
    file: contract,
    from: 'markdown: z.string().max(MAX_SYNTHESIS_NOTE_BYTES * 6)',
    to: 'markdown: z.string().max(8_000_000)',
    witness: 'exports a legal near-limit note after entity escaping expands its content'
  },
  {
    name: 'comment-control',
    control: true,
    file: store,
    from: '/** One bounded, atomic application-owned file.',
    to: '/** Negative control: one bounded, atomic application-owned file.'
  },
  {
    name: 'without-revision-check',
    file: service,
    from: '!existing || existing.revision !== request.expectedRevision',
    to: '!existing',
    witness: 'concurrent revisions cannot overwrite'
  },
  {
    name: 'without-store-queue',
    file: store,
    from: 'const previous = operations.get(path) ?? Promise.resolve()',
    to: 'const previous = Promise.resolve()',
    witness: 'concurrent revisions cannot overwrite'
  },
  {
    name: 'without-mutation-replay',
    file: service,
    from: 'if (!request.requestId) return undefined',
    to: 'return undefined',
    witness: 'replays a committed create after response loss',
    additionalWitnesses: ['replays a no-op append independently of the last real write receipt'],
    witnessError: 'A selected annotation is unavailable.'
  },
  {
    name: 'live-source-instead-of-snapshot',
    file: service,
    from: 'return { ...block, sourceStatus } as const',
    to: 'return { ...block, sourceStatus, snapshot: current ?? block.snapshot } as const',
    witness: 'keeps immutable snapshot when the source is edited or deleted',
    additionalWitnesses: [
      'keeps shared annotation aliases navigable',
      'checks only the requested excerpt source and keeps its durable snapshot'
    ]
  },
  {
    name: 'without-source-check-isolation',
    file: service,
    from: "return { ...block, sourceStatus: 'unverified' } as const",
    to: "throw new Error('Source check aborted stored note access.')",
    witness: 'reads and exports durable snapshots when source status cannot be checked',
    additionalWitnesses: [
      'checks only the requested excerpt source and keeps its durable snapshot'
    ],
    witnessError: 'Source check aborted stored note access.'
  },
  {
    name: 'without-single-page-reader-admission',
    file: pdf,
    from: 'currentState.document.numPages === 1 &&\n    !props.pdfBookmarkSource',
    to: 'currentState.document.numPages === 1',
    witness: 'reveals a project annotation from its document provider'
  },
  {
    name: 'without-annotation-alias-resolution',
    file: sources,
    from: '!annotation ||',
    to: '!annotation || annotation.id !== selection.annotationId ||',
    witness: 'keeps shared annotation aliases navigable'
  },
  {
    name: 'without-noop-append-guard',
    file: service,
    from: "request.action === 'append' && appendedSnapshots.length === 0",
    to: 'false',
    witness: 'keeps canonical duplicate appends without a request identity entirely unchanged',
    additionalWitnesses: ['replays a no-op append independently of the last real write receipt']
  },
  {
    name: 'without-noop-append-replay',
    file: service,
    from: 'note.lastNoopAppend?.id === request.requestId',
    to: 'false',
    witness: 'replays a no-op append independently of the last real write receipt',
    witnessError: 'A selected annotation is unavailable.'
  },
  {
    name: 'without-canonical-append-deduplication',
    file: service,
    from: '[canonicalIds.get(block.snapshot.annotationId) ?? block.snapshot.annotationId]',
    to: '[block.snapshot.annotationId]',
    witness: 'keeps shared annotation aliases navigable',
    additionalWitnesses: ['canonicalizes and deduplicates aliases when creating excerpts']
  },
  {
    name: 'without-current-selection-identity',
    file: service,
    from: 'snapshot.annotationId !== excerpt.annotationId ||',
    to: '',
    witness: 'keeps shared annotation aliases navigable',
    witnessError: 'instead of rejecting'
  },
  {
    name: 'without-current-escape-ref',
    file: workspace,
    from: 'event.preventDefault()\n            if (blockDrag.current) {\n              clearBlockDrag()\n              return\n            }\n            escapeClose.current?.()',
    to: 'if (blockDrag.current) {\n              event.preventDefault()\n              clearBlockDrag()\n              return\n            }\n            if (busy || preview) event.preventDefault()',
    witness: 'uses the current dirty guard',
    witnessError: 'Unable to find role'
  },
  {
    name: 'without-export-inflight-revision-check',
    file: service,
    from: "      if (request.action === 'export') {\n        const latestRevision = await this.store.run((notes) => ({\n          result: notes.find((value) => value.id === request.noteId)?.revision\n        }))\n        if (latestRevision !== note.revision)\n          throw new Error('Synthesis note changed. Reopen it before exporting.')\n      }\n",
    to: '',
    witness: 'rejects an update that lands while export source enrichment is in flight',
    witnessError: 'promise resolved'
  },
  {
    name: 'without-create-alias-deduplication',
    file: service,
    from: '    const uniqueSnapshots = deduplicateSnapshots(snapshots, canonicalIds)\n',
    to: '    const uniqueSnapshots = snapshots\n',
    witness: 'canonicalizes and deduplicates aliases when creating excerpts',
    additionalWitnesses: ['keeps shared annotation aliases navigable'],
    witnessError: 'unavailable'
  },
  {
    name: 'without-candidate-stale-row-guard',
    file: sources,
    from: '      if (binding && version) {',
    to: '      if (true) {',
    witness: 'skips a candidate whose binding disappeared during pagination',
    additionalWitnesses: ['budgets an escaped stale-row cursor before advancing past it'],
    witnessError: 'promise rejected'
  },
  {
    name: 'restore-candidate-page-offset',
    file: sources,
    replacements: [
      {
        from: '        cursor\n          ? Prisma.sql`AND (annotation.createdAt > ${new Date(cursor.createdAt)}\n            OR (annotation.createdAt = ${new Date(cursor.createdAt)} AND annotation.id > ${cursor.id}))`\n          : Prisma.empty',
        to: '        Prisma.empty'
      },
      {
        from: '      LIMIT ${limit + 1}',
        to: '      LIMIT ${limit + 1} OFFSET ${cursor ? limit : 0}'
      }
    ],
    witness: 'continues tied timestamps after earlier rows and the cursor annotation are deleted',
    additionalWitnesses: ['bounds candidate response bytes without dropping the continuation']
  },
  {
    name: 'without-candidate-cursor-tiebreaker',
    file: sources,
    from: '            OR (annotation.createdAt = ${new Date(cursor.createdAt)} AND annotation.id > ${cursor.id}))`',
    to: '            )`',
    witness: 'continues tied timestamps after earlier rows and the cursor annotation are deleted',
    additionalWitnesses: [
      'paginates existing annotations and reads bibliography plus existing tags',
      'bounds candidate response bytes without dropping the continuation'
    ]
  },
  {
    name: 'advance-past-candidate-that-exceeds-page-bytes',
    file: sources,
    from: '        return { candidates, nextCursor }',
    to: '        return { candidates, nextCursor: rowCursor }',
    witness: 'bounds candidate response bytes without dropping the continuation',
    additionalWitnesses: ['budgets an escaped stale-row cursor before advancing past it']
  },
  {
    name: 'without-delete-replay-identity',
    file: contract,
    from: "z.object({ action: z.literal('delete'), requestId: id.optional(), ...noteIdentity }).strict()",
    to: "z.object({ action: z.literal('delete'), ...noteIdentity }).strict()",
    witness: 'retries a deleted note idempotently after the first response is lost',
    witnessError: 'promise rejected'
  },
  {
    name: 'without-durable-delete-receipt',
    file: store,
    from: 'deletedMutations: next.deletedMutations ?? deletedMutations',
    to: 'deletedMutations',
    witness: 'retries a deleted note idempotently after the first response is lost',
    additionalWitnesses: ['persists a receipt when the notes array itself is unchanged'],
    witnessError: 'promise rejected'
  },
  {
    name: 'without-receipt-only-store-write',
    file: store,
    from: 'if (next.notes || next.deletedMutations) {',
    to: 'if (next.notes) {',
    witness: 'persists a receipt when the notes array itself is unchanged',
    witnessError: '[]'
  }
]
const files = [service, sources, store, workspace, pdf, contract, referenceSearch]
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const tests = [
  'src/main/literature/synthesis.test.ts',
  'src/main/literature/synthesis-sharing.test.ts',
  'src/main/literature/synthesis-sources.test.ts',
  'src/renderer/src/pages/literature/synthesis/LiteratureSynthesisWorkspace.test.tsx',
  'src/renderer/src/pages/workspace/previews/renderers/PdfPreview.test.tsx'
]
const names = [
  'concurrent revisions cannot overwrite',
  'replays a committed create after response loss',
  'keeps canonical duplicate appends without a request identity entirely unchanged',
  'replays a no-op append independently of the last real write receipt',
  'keeps immutable snapshot when the source is edited or deleted',
  'reveals a project annotation from its document provider',
  'uses the current dirty guard',
  'reads and exports durable snapshots when source status cannot be checked',
  'checks only the requested excerpt source and keeps its durable snapshot',
  'keeps shared annotation aliases navigable',
  'rejects an older append retry after the user edits the current draft',
  'rejects an older export retry after the user edits the current draft',
  'rejects exporting a revision the current viewer has not reviewed',
  'exports a legal near-limit note after entity escaping expands its content',
  'waits for the initial list before creating',
  'keeps initial list failures in the notes view',
  'preserves a large collaboration author list within the existing byte budgets',
  'discards an earlier reference search after canceling',
  'rejects an update that lands while export source enrichment is in flight',
  'canonicalizes and deduplicates aliases when creating excerpts',
  'skips a candidate whose binding disappeared during pagination',
  'paginates existing annotations and reads bibliography plus existing tags',
  'continues tied timestamps after earlier rows and the cursor annotation are deleted',
  'bounds candidate response bytes without dropping the continuation',
  'accepts a near-limit candidate with a short cursor without lowering the single-candidate cap',
  'budgets an escaped stale-row cursor before advancing past it',
  'retries a deleted note idempotently after the first response is lost',
  'persists a receipt when the notes array itself is unchanged'
].join('|')
export function applySynthesisAblation(code, variant) {
  const replacements = variant.replacements ?? [variant]
  if (!replacements.length) throw new Error('Ablation must change a mechanism')
  for (const replacement of replacements) {
    if (!replacement.from || code.split(replacement.from).length !== 2)
      throw new Error('Nonunique or missing source anchor: ' + variant.name)
    code = code.replace(replacement.from, replacement.to)
  }
  return code
}
export class SynthesisAblationReporter {
  constructor(path) {
    this.path = path
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    writeFileSync(
      this.path,
      JSON.stringify({
        finished: true,
        reason,
        unhandledErrors: unhandledErrors.map(({ name, message }) => ({ name, message })),
        suiteErrors: testModules.flatMap((module) =>
          [module, ...module.children.allSuites()].flatMap((suite) =>
            suite.errors().map(({ name, message }) => ({ name, message }))
          )
        )
      })
    )
  }
}

export function inspectSynthesisAblationReport({
  report,
  observation,
  run,
  variant,
  expectedFiles,
  expectedTests,
  transformHit = true
}) {
  const suites = report.testResults ?? []
  const assertions = suites
    .flatMap((suite) => suite.assertionResults ?? [])
    .filter((a) => a.status === 'passed' || a.status === 'failed')
  const failures = assertions.filter((a) => a.status === 'failed')
  const selected = assertions.map((a) => a.fullName).sort()
  const sortedExpectedTests = expectedTests ? [...expectedTests].sort() : undefined
  const sameSelection =
    selected.length > 0 &&
    (!sortedExpectedTests ||
      (selected.length === sortedExpectedTests.length &&
        selected.every((name, index) => name === sortedExpectedTests[index])))
  const diagnostics = [
    run.stdout ?? '',
    run.stderr ?? '',
    ...suites.map((suite) => suite.message ?? ''),
    ...failures.flatMap((a) => a.failureMessages ?? [])
  ].join('\n')
  const clean =
    !run.error &&
    !run.signal &&
    observation?.finished === true &&
    observation.reason === (variant.control ? 'passed' : 'failed') &&
    Array.isArray(observation.unhandledErrors) &&
    observation.unhandledErrors.length === 0 &&
    Array.isArray(observation.suiteErrors) &&
    observation.suiteErrors.length === 0 &&
    failures.every((a) =>
      [variant.witness, ...(variant.additionalWitnesses ?? [])].some(
        (name) => name && a.fullName.includes(name)
      )
    ) &&
    !/Unhandled Error|Unhandled Rejection|Uncaught Exception|Failed to load|timed out/i.test(
      diagnostics
    ) &&
    suites.length === expectedFiles.length &&
    suites.every(
      (suite) =>
        expectedFiles.includes(suite.name) &&
        !suite.message &&
        suite.assertionResults?.length &&
        (suite.status === 'passed' || suite.status === 'failed')
    ) &&
    new Set(suites.map((suite) => suite.name)).size === expectedFiles.length
  const witness = failures.some(
    (a) =>
      a.fullName.includes(variant.witness ?? '') &&
      a.failureMessages?.some(
        (message) =>
          message.includes('AssertionError:') ||
          (variant.witnessError && message.includes(variant.witnessError))
      )
  )
  const valid =
    clean &&
    sameSelection &&
    transformHit &&
    (variant.control
      ? run.status === 0 && failures.length === 0 && report.success === true
      : run.status === 1 && report.success === false && witness)
  return { valid, selected, failures }
}

function main() {
  const before = Object.fromEntries(files.map((file) => [file, hash(file)]))
  const testHashes = Object.fromEntries(tests.map((file) => [file, hash(file)]))
  for (const variant of variants) {
    if (variant.file) applySynthesisAblation(readFileSync(variant.file, 'utf8'), variant)
  }
  const root = resolve('.scratch/synthesis-ablation')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    resolve(root, 'config.ts'),
    "import { readFileSync, writeFileSync } from 'node:fs'\nimport { resolve } from 'node:path'\nimport { defineConfig } from 'vitest/config'\nimport base from '../../vitest.config'\nimport { SynthesisAblationReporter, applySynthesisAblation } from '../../scripts/literature-synthesis-ablation.mjs'\n\nconst variant = JSON.parse(readFileSync(process.env.SYNTHESIS_ABLATION_VARIANT!, 'utf8'))\nexport default defineConfig({\n  ...base,\n  plugins: [{\n    name: 'synthesis-single-mechanism-ablation',\n    enforce: 'pre',\n    transform(code, id) {\n      if (!variant.file || id.split('?')[0] !== resolve(variant.file)) return\n      const transformed = applySynthesisAblation(code, variant)\n      writeFileSync(process.env.SYNTHESIS_ABLATION_HIT!, id)\n      return { code: transformed, map: null }\n    }\n  }],\n  test: {\n    ...base.test,\n    maxWorkers: 1,\n    reporters: ['json', new SynthesisAblationReporter(process.env.SYNTHESIS_ABLATION_OBSERVATION!)],\n    projects: [{ extends: true, test: { name: 'synthesis-ablation' } }]\n  }\n})\n"
  )
  let baselineNames
  const results = []
  for (const variant of variants) {
    const spec = resolve(root, variant.name + '.variant.json')
    const reportPath = resolve(root, variant.name + '.json')
    const hitPath = resolve(root, variant.name + '.hit')
    const logPath = resolve(root, variant.name + '.log')
    const observationPath = resolve(root, variant.name + '.observation.json')
    rmSync(reportPath, { force: true })
    rmSync(hitPath, { force: true })
    rmSync(observationPath, { force: true })
    writeFileSync(spec, JSON.stringify(variant))
    const run = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        ...tests,
        '-t',
        names,
        '--config',
        '.scratch/synthesis-ablation/config.ts',
        '--outputFile',
        reportPath
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          SYNTHESIS_ABLATION_VARIANT: spec,
          SYNTHESIS_ABLATION_HIT: hitPath,
          SYNTHESIS_ABLATION_OBSERVATION: observationPath
        }
      }
    )
    writeFileSync(logPath, (run.stdout ?? '') + (run.stderr ?? ''))
    if (run.error || run.signal || !existsSync(reportPath) || !existsSync(observationPath))
      throw new Error(`Infrastructure failure: ${variant.name}; see ${logPath}`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const observation = JSON.parse(readFileSync(observationPath, 'utf8'))
    const { valid, selected, failures } = inspectSynthesisAblationReport({
      report,
      observation,
      run,
      variant,
      expectedFiles: tests.map((file) => resolve(file)),
      expectedTests: baselineNames,
      transformHit: !variant.file || existsSync(hitPath)
    })
    if (variant.name === 'baseline' && valid) baselineNames = selected
    const result = {
      name: variant.name,
      valid,
      exit: run.status,
      selected: selected.length,
      failures: failures.map((a) => ({ test: a.fullName, messages: a.failureMessages })),
      logPath,
      observationPath,
      observation
    }
    results.push(result)
    writeFileSync(
      resolve(root, 'report.json'),
      JSON.stringify({ sourceHashes: before, testHashes, results }, null, 2)
    )
    console.log(
      JSON.stringify({
        name: variant.name,
        valid,
        selected: selected.length,
        failures: failures.map((a) => a.fullName)
      })
    )
    if (!valid) throw new Error(`Inconclusive ablation: ${variant.name}; see ${logPath}`)
  }
  if (
    files.some((file) => hash(file) !== before[file]) ||
    tests.some((file) => hash(file) !== testHashes[file])
  )
    throw new Error('Source or test files changed during ablation')
  console.log('All ablations had clean semantic witnesses; production sources were never modified.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
