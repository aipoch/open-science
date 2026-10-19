import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  copyAcceptanceResume,
  readAcceptanceResume,
  verifyAcceptanceMaterialFiles,
  verifyAcceptanceResumeReservations,
  type AcceptanceResumeExpectation
} from './research-acceptance-resume.test-support'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const budget = 'a'.repeat(64)
async function fixture(): Promise<{
  root: string
  expected: AcceptanceResumeExpectation
  report: {
    status: string
    title: string
    planKey: string
    planScope: string
    sourcePackageSha256: string
    entries: Array<{
      entry: string
      inputPackageSha256: string
      packageSha256: string
      sourceIdentity: string
      notebookRunId: string
      outputCount: number
      operation: {
        status: string
        operationId: string
        notebookRunIds: string[]
        provenance: { promptMessageId: string }
      }
    }>
  }
  receipt: {
    status: string
    trialId: string
    budgetDocumentSha256: string
    usage: { unit: string; state: string; knownUnits: number }
    outputs: Array<{ path: string; sha256: string; sizeBytes: number }>
  }
  writeReport(): Promise<void>
  writeReceipt(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-resume-'))
  roots.push(root)
  await mkdir(join(root, 'author'))
  const source = 'native archive bytes are validated later by native import',
    resultPackage = 'author result archive'
  const result = JSON.stringify({ status: 'completed', validationPassed: true })
  const operation = {
    status: 'completed',
    operationId: 'operation',
    notebookRunIds: ['native-run'],
    provenance: { promptMessageId: 'prompt' }
  }
  const report = {
    status: 'in-progress',
    title: 'Generic research',
    planKey: 'live',
    planScope: 'alternative-conditions',
    sourcePackageSha256: sha(source),
    entries: [
      {
        entry: 'author',
        inputPackageSha256: sha(source),
        packageSha256: sha(resultPackage),
        sourceIdentity: 'source',
        notebookRunId: 'native-run',
        operation,
        outputCount: 2
      }
    ]
  }
  const receipt = {
    status: 'completed',
    trialId: 'baseline',
    budgetDocumentSha256: budget,
    usage: { unit: 'tokens', state: 'complete', knownUnits: 13 },
    outputs: [{ path: 'result.json', sha256: sha(result), sizeBytes: Buffer.byteLength(result) }]
  }
  await Promise.all([
    writeFile(join(root, 'research.science'), source),
    writeFile(join(root, 'author-results.science'), resultPackage),
    writeFile(join(root, 'author-operation.json'), JSON.stringify(operation)),
    writeFile(
      join(root, 'author-notebook-runs.json'),
      JSON.stringify([
        { runId: 'native-run', status: 'completed', exitCode: 0, promptMessageId: 'prompt' }
      ])
    ),
    writeFile(join(root, 'author/result.json'), result)
  ])
  const writeReport = async (): Promise<void> => {
    await writeFile(join(root, 'acceptance-results.json'), JSON.stringify(report))
  }
  const writeReceipt = async (): Promise<void> => {
    await writeFile(join(root, 'author/execution-receipt.json'), JSON.stringify(receipt))
  }
  await writeReport()
  await writeReceipt()
  return {
    root,
    report,
    receipt,
    writeReport,
    writeReceipt,
    expected: {
      title: report.title,
      planKey: report.planKey,
      planScope: report.planScope,
      budgetSha256: budget,
      usageReceiptFilename: 'execution-receipt.json',
      trialIds: { author: 'baseline', external: 'external', ordinary: 'ordinary', fork: 'fork' },
      outputs: [{ filename: 'execution-receipt.json' }, { filename: 'result.json' }],
      assertions: [{ path: 'result.json', pointer: '/validationPassed', equals: true }]
    }
  }
}
it('copies only verified completed prefix snapshots to a new output and leaves the old evidence untouched', async () => {
  const f = await fixture(),
    before = await readFile(join(f.root, 'acceptance-results.json'))
  await writeFile(join(f.root, 'external-failure.json'), 'never a completed entry')
  const snapshot = await readAcceptanceResume(f.root, f.expected)
  const output = await mkdtemp(join(tmpdir(), 'acceptance-resumed-'))
  roots.push(output)
  await copyAcceptanceResume(snapshot, output)
  expect(snapshot.report.entries.map((row) => row.entry)).toEqual(['author'])
  expect(await readFile(join(output, 'author-results.science'))).toEqual(
    await readFile(join(f.root, 'author-results.science'))
  )
  expect(JSON.parse(await readFile(join(output, 'resumed-from.json'), 'utf8')).reportSha256).toBe(
    sha(before)
  )
  await expect(readFile(join(output, 'external-failure.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  expect(await readFile(join(f.root, 'acceptance-results.json'))).toEqual(before)
  await expect(copyAcceptanceResume(snapshot, output)).rejects.toMatchObject({ code: 'EEXIST' })
})
it.each([
  'wrong-title',
  'wrong-plan',
  'wrong-scope',
  'already-passed',
  'gap',
  'duplicate',
  'failed-operation',
  'wrong-input-chain'
])('rejects an unverified prefix: %s', async (mode) => {
  const f = await fixture()
  if (mode === 'wrong-title') f.report.title = 'changed'
  if (mode === 'wrong-plan') f.report.planKey = 'changed'
  if (mode === 'wrong-scope') f.report.planScope = 'changed'
  if (mode === 'already-passed') f.report.status = 'passed'
  if (mode === 'gap') f.report.entries[0].entry = 'external'
  if (mode === 'duplicate') f.report.entries.push(f.report.entries[0])
  if (mode === 'failed-operation') f.report.entries[0].operation.status = 'failed'
  if (mode === 'wrong-input-chain') f.report.entries[0].inputPackageSha256 = 'b'.repeat(64)
  await f.writeReport()
  await expect(readAcceptanceResume(f.root, f.expected)).rejects.toThrow()
})
it.each(['research.science', 'author-results.science', 'author/result.json'])(
  'rejects changed evidence bytes: %s',
  async (path) => {
    const f = await fixture()
    await writeFile(join(f.root, path), 'changed')
    await expect(readAcceptanceResume(f.root, f.expected)).rejects.toThrow('checksum')
  }
)
it.each(['trial', 'budget', 'failed', 'missing-output', 'duplicate-output'])(
  'rejects an incompatible public usage receipt: %s',
  async (mode) => {
    const f = await fixture()
    if (mode === 'trial') f.receipt.trialId = 'another'
    if (mode === 'budget') f.receipt.budgetDocumentSha256 = 'b'.repeat(64)
    if (mode === 'failed') f.receipt.status = 'failed'
    if (mode === 'missing-output') f.receipt.outputs = []
    if (mode === 'duplicate-output') f.receipt.outputs.push(f.receipt.outputs[0])
    await f.writeReceipt()
    await expect(readAcceptanceResume(f.root, f.expected)).rejects.toThrow()
  }
)
it('rejects a mismatched Notebook producer and a changed operation sidecar', async () => {
  const f = await fixture()
  await writeFile(
    join(f.root, 'author-notebook-runs.json'),
    JSON.stringify([
      { runId: 'another', status: 'completed', exitCode: 0, promptMessageId: 'prompt' }
    ])
  )
  await expect(readAcceptanceResume(f.root, f.expected)).rejects.toThrow('Notebook evidence')
  await writeFile(
    join(f.root, 'author-operation.json'),
    JSON.stringify({ ...f.report.entries[0].operation, operationId: 'changed' })
  )
  await expect(readAcceptanceResume(f.root, f.expected)).rejects.toThrow('operation evidence')
})
it('rejects symlink evidence and prevents a resume output from being placed under its source', async () => {
  const f = await fixture(),
    snapshot = await readAcceptanceResume(f.root, f.expected)
  await mkdir(join(f.root, 'new'))
  await expect(copyAcceptanceResume(snapshot, join(f.root, 'new'))).rejects.toThrow('independent')
  await rm(join(f.root, 'research.science'))
  await symlink(join(f.root, 'author-results.science'), join(f.root, 'research.science'))
  await expect(readAcceptanceResume(f.root, f.expected)).rejects.toThrow('ordinary files')
})
it('checks actual current descriptor and included material bytes against the file index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-material-seal-'))
  roots.push(root)
  const code = 'console.log(1)'
  const descriptor = JSON.stringify({
    format: 'open-science-reproduction-description',
    descriptionVersion: 1,
    title: 'Generic',
    materials: [
      {
        key: 'script',
        role: 'script',
        availability: 'included',
        filename: 'main.mjs',
        restorePath: 'main.mjs',
        sha256: sha(code),
        sizeBytes: Buffer.byteLength(code)
      }
    ],
    plans: [
      {
        key: 'live',
        title: 'Live',
        scope: 'engineering-check',
        materialKeys: ['script'],
        claim: 'Check wiring',
        limitations: ['Fixture'],
        entrypoints: [{ materialKey: 'script' }]
      }
    ]
  })
  await Promise.all([
    writeFile(join(root, 'main.mjs'), code),
    writeFile(join(root, 'research-reproduction.json'), descriptor),
    writeFile(
      join(root, 'material-file-index.json'),
      JSON.stringify({
        description: 'research-reproduction.json',
        descriptionSha256: sha(descriptor),
        files: [
          {
            key: 'script',
            relativePath: 'main.mjs',
            sha256: sha(code),
            sizeBytes: Buffer.byteLength(code)
          }
        ]
      })
    )
  ])
  expect(await verifyAcceptanceMaterialFiles(root, 'research-reproduction.json')).toBe(
    sha(descriptor)
  )
  await writeFile(join(root, 'main.mjs'), 'console.log(2)')
  await expect(verifyAcceptanceMaterialFiles(root, 'research-reproduction.json')).rejects.toThrow(
    'material bytes'
  )
  await writeFile(join(root, 'research-reproduction.json'), '{}')
  await expect(verifyAcceptanceMaterialFiles(root, 'research-reproduction.json')).rejects.toThrow(
    'descriptor checksum'
  )
})

it.each(['valid', 'missing-reservation', 'changed-budget', 'changed-usage', 'changed-carry'])(
  'requires completed entries to remain charged in the exact durable budget: %s',
  async (mode) => {
    const f = await fixture(),
      snapshot = await readAcceptanceResume(f.root, f.expected)
    await mkdir(join(f.root, 'materials'))
    const budgetPath = join(f.root, 'materials', 'budget.json')
    await writeFile(budgetPath, '{}')
    const seal = {
      studyId: 'study',
      sha256: budget,
      carriedReservedUnits: 12_582_912,
      maximumUnitsPerTrial: 12_582_912
    }
    const ledger = {
      version: 2,
      unit: 'tokens',
      studyId: 'study',
      sealSha256: budget,
      carriedReservedUnits: 12_582_912,
      reservations: [
        {
          trialId: 'baseline',
          maximumUnits: 12_582_912,
          usageRecordedAt: 'recorded',
          usage: f.receipt.usage
        }
      ]
    }
    if (mode === 'missing-reservation') ledger.reservations = []
    if (mode === 'changed-budget') ledger.sealSha256 = 'b'.repeat(64)
    if (mode === 'changed-usage')
      ledger.reservations[0].usage = { ...f.receipt.usage, knownUnits: 0 }
    if (mode === 'changed-carry') ledger.carriedReservedUnits = 0
    const path = join(f.root, 'live-acceptance-budget-ledger.json'),
      bytes = JSON.stringify(ledger)
    await writeFile(path, bytes)
    const validation = verifyAcceptanceResumeReservations(
      snapshot,
      budgetPath,
      seal,
      f.expected.trialIds,
      f.expected.usageReceiptFilename
    )
    if (mode === 'valid') await validation
    else await expect(validation).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
)
