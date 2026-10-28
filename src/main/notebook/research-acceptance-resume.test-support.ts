import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { parseResearchReproductionDescription } from '../../shared/research-reproduction'

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const entryName = z.enum(['author', 'external', 'ordinary', 'fork'])
const operation = z
  .object({
    status: z.literal('completed'),
    operationId: z.string().min(1),
    notebookRunIds: z.array(z.string()),
    provenance: z.object({ promptMessageId: z.string().min(1) }).passthrough()
  })
  .passthrough()
const entrySchema = z
  .object({
    entry: entryName,
    inputPackageSha256: hash,
    packageSha256: hash,
    sourceIdentity: z.string().min(1),
    notebookRunId: z.string().min(1),
    operation,
    outputCount: z.number().int().nonnegative()
  })
  .passthrough()
const reportSchema = z
  .object({
    status: z.enum(['in-progress', 'passed']),
    title: z.string(),
    planKey: z.string(),
    planScope: z.string(),
    sourcePackageSha256: hash,
    entries: z.array(entrySchema).min(1).max(3)
  })
  .passthrough()
export type CompletedAcceptanceEntry = z.infer<typeof entrySchema>
export type AcceptanceResumeExpectation = {
  title: string
  planKey: string
  planScope: string
  budgetSha256: string
  usageReceiptFilename: string
  trialIds: Record<z.infer<typeof entryName>, string>
  outputs: ReadonlyArray<{ filename: string; optional?: boolean }>
  assertions: ReadonlyArray<{ path: string; pointer: string; equals: unknown }>
}
export type ValidatedAcceptanceResume = {
  report: z.infer<typeof reportSchema>
  files: Map<string, Buffer>
  provenance: {
    evidenceDirectory: string
    reportSha256: string
    copiedFiles: Array<{ path: string; sha256: string; sizeBytes: number }>
  }
}
const relativeFile = (value: string): string => {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Resume evidence contains an unsafe relative path.')
  return value
}
async function boundedFile(root: string, relative: string): Promise<Buffer> {
  const path = join(root, relativeFile(relative))
  if ((await realpath(path)) !== path || (await lstat(path)).isSymbolicLink())
    throw new Error('Resume evidence must be ordinary files under its selected directory.')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 128 * 1024 ** 2)
      throw new Error('Resume evidence exceeds its read bound.')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      bytes.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error('Resume evidence changed during verification.')
    return bytes
  } finally {
    await handle.close()
  }
}

/** Checks current file-index bytes and descriptor seals without any process, credential or network use. */
export async function verifyAcceptanceMaterialFiles(
  rootPath: string,
  descriptorFilename: string
): Promise<string> {
  const root = await realpath(rootPath)
  const index = z
    .object({
      description: z.string(),
      descriptionSha256: hash,
      files: z.array(
        z
          .object({
            key: z.string(),
            relativePath: z.string(),
            sha256: hash,
            sizeBytes: z.number().int().nonnegative()
          })
          .passthrough()
      ),
      demo: z
        .object({
          relativePath: z.string(),
          sha256: hash,
          sizeBytes: z.number().int().nonnegative()
        })
        .passthrough()
        .optional()
    })
    .passthrough()
    .parse(JSON.parse((await boundedFile(root, 'material-file-index.json')).toString()))
  if (index.description !== descriptorFilename)
    throw new Error('Current material description does not match acceptance.')
  const descriptor = await boundedFile(root, index.description)
  if (sha(descriptor) !== index.descriptionSha256)
    throw new Error('Current descriptor checksum differs from its file index.')
  const parsed = parseResearchReproductionDescription(descriptor.toString())
  if (parsed.status !== 'valid') throw new Error('Current research description is invalid.')
  const included = parsed.description.materials.filter((item) => item.availability === 'included')
  if (
    included.length !== index.files.length ||
    new Set(index.files.map((item) => item.key)).size !== index.files.length
  )
    throw new Error('Current material file index does not match the descriptor.')
  for (const material of included) {
    const file = index.files.find((item) => item.key === material.key)
    if (!file || material.sha256 !== file.sha256 || material.sizeBytes !== file.sizeBytes)
      throw new Error('Current material differs from its descriptor seal.')
    const bytes = await boundedFile(root, file.relativePath)
    if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256)
      throw new Error('Current material bytes differ from the reviewed file index.')
  }
  if (index.demo) {
    const bytes = await boundedFile(root, index.demo.relativePath)
    if (bytes.length !== index.demo.sizeBytes || sha(bytes) !== index.demo.sha256)
      throw new Error('Current supplemental material differs from its file index.')
  }
  return index.descriptionSha256
}

/** Only a verified contiguous completed prefix is resumable. No budget or source file is modified. */
export async function readAcceptanceResume(
  directory: string,
  expected: AcceptanceResumeExpectation
): Promise<ValidatedAcceptanceResume> {
  const root = await realpath(directory),
    files = new Map<string, Buffer>()
  const read = async (path: string): Promise<Buffer> => {
    const bytes = await boundedFile(root, path)
    files.set(path, bytes)
    return bytes
  }
  const reportBytes = await boundedFile(root, 'acceptance-results.json')
  const report = reportSchema.parse(JSON.parse(reportBytes.toString()))
  if (
    report.status !== 'in-progress' ||
    report.title !== expected.title ||
    report.planKey !== expected.planKey ||
    report.planScope !== expected.planScope
  )
    throw new Error('Resume evidence belongs to another or already completed acceptance.')
  const order = ['author', 'external', 'ordinary', 'fork'] as const
  if (report.entries.some((entry, index) => entry.entry !== order[index]))
    throw new Error(
      'Resume entries must be a contiguous completed prefix beginning with the author.'
    )
  if (sha(await read('research.science')) !== report.sourcePackageSha256)
    throw new Error('Resume source package checksum differs from the recorded evidence.')
  const authorHash = report.entries[0].packageSha256
  for (const entry of report.entries) {
    if (
      entry.inputPackageSha256 !==
      (entry.entry === 'author' ? report.sourcePackageSha256 : authorHash)
    )
      throw new Error('Resume package input chain does not match the author baseline.')
    if (sha(await read(`${entry.entry}-results.science`)) !== entry.packageSha256)
      throw new Error('Resume result package checksum differs from the recorded evidence.')
    const recordedOperation = operation.parse(
      JSON.parse((await read(`${entry.entry}-operation.json`)).toString())
    )
    if (!isDeepStrictEqual(recordedOperation, entry.operation))
      throw new Error('Resume operation evidence differs from the completed entry.')
    const runs = z
      .array(
        z
          .object({
            runId: z.string(),
            status: z.literal('completed'),
            exitCode: z.literal(0),
            promptMessageId: z.string()
          })
          .passthrough()
      )
      .length(1)
      .parse(JSON.parse((await read(`${entry.entry}-notebook-runs.json`)).toString()))
    if (
      runs[0].runId !== entry.notebookRunId ||
      runs[0].promptMessageId !== recordedOperation.provenance.promptMessageId ||
      ((entry.entry === 'author' || entry.entry === 'external') &&
        !isDeepStrictEqual(recordedOperation.notebookRunIds, [entry.notebookRunId]))
    )
      throw new Error('Resume Notebook evidence is not bound to the completed operation.')
    if (basename(expected.usageReceiptFilename) !== expected.usageReceiptFilename)
      throw new Error('Unsafe usage receipt filename.')
    const receipt = z
      .object({
        status: z.literal('completed'),
        trialId: z.string(),
        budgetDocumentSha256: hash,
        usage: z
          .object({
            unit: z.literal('tokens'),
            state: z.enum(['unknown', 'partial', 'complete']),
            knownUnits: z.number().int().nonnegative().nullable()
          })
          .passthrough(),
        outputs: z.array(
          z
            .object({ path: z.string(), sha256: hash, sizeBytes: z.number().int().nonnegative() })
            .passthrough()
        )
      })
      .passthrough()
      .parse(JSON.parse((await read(`${entry.entry}/${expected.usageReceiptFilename}`)).toString()))
    if (
      receipt.trialId !== expected.trialIds[entry.entry] ||
      receipt.budgetDocumentSha256 !== expected.budgetSha256
    )
      throw new Error('Resume usage receipt belongs to another trial or reviewed budget.')
    if (new Set(receipt.outputs.map((item) => item.path)).size !== receipt.outputs.length)
      throw new Error('Resume receipt has duplicate output evidence.')
    for (const output of expected.outputs) {
      if (basename(output.filename) !== output.filename)
        throw new Error('Unsafe acceptance output filename.')
      if (output.filename === expected.usageReceiptFilename) continue
      const sealed = receipt.outputs.find((item) => item.path === output.filename)
      if (!sealed) {
        if (output.optional) continue
        throw new Error('Resume receipt is missing a required output seal.')
      }
      const bytes = await read(`${entry.entry}/${output.filename}`)
      if (sha(bytes) !== sealed.sha256 || bytes.length !== sealed.sizeBytes)
        throw new Error('Resume output checksum differs from its completed receipt.')
    }
    for (const assertion of expected.assertions) {
      const bytes = files.get(`${entry.entry}/${relativeFile(assertion.path)}`)
      if (!bytes) throw new Error('Resume assertion references an unverified output.')
      let actual: unknown = JSON.parse(bytes.toString())
      for (const part of assertion.pointer.split('/').slice(1))
        actual = (actual as Record<string, unknown>)[
          part.replaceAll('~1', '/').replaceAll('~0', '~')
        ]
      if (!isDeepStrictEqual(actual, assertion.equals))
        throw new Error('Resume output does not satisfy the reviewed acceptance assertions.')
    }
  }
  return {
    report,
    files,
    provenance: {
      evidenceDirectory: root,
      reportSha256: sha(reportBytes),
      copiedFiles: [...files].map(([path, bytes]) => ({
        path,
        sha256: sha(bytes),
        sizeBytes: bytes.length
      }))
    }
  }
}

/** The destination must be new. Copy verified byte snapshots only, never failed-entry evidence. */
export async function copyAcceptanceResume(
  snapshot: ValidatedAcceptanceResume,
  newDirectory: string
): Promise<void> {
  const root = await realpath(newDirectory)
  if (
    root === snapshot.provenance.evidenceDirectory ||
    resolve(root).startsWith(snapshot.provenance.evidenceDirectory + '/')
  )
    throw new Error('Resume output must be independent from its source evidence.')
  for (const [path, bytes] of snapshot.files) {
    const destination = join(root, relativeFile(path))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes, { flag: 'wx' })
  }
  await writeFile(join(root, 'resumed-from.json'), JSON.stringify(snapshot.provenance, null, 2), {
    flag: 'wx'
  })
}

/** Completed entries must remain charged in the same durable budget; resume never re-arms them. */
export async function verifyAcceptanceResumeReservations(
  snapshot: ValidatedAcceptanceResume,
  budgetPath: string,
  seal: {
    studyId: string
    sha256: string
    carriedReservedUnits: number
    maximumUnitsPerTrial: number
  },
  trialIds: AcceptanceResumeExpectation['trialIds'],
  usageReceiptFilename: string
): Promise<void> {
  const root = dirname(dirname(await realpath(budgetPath)))
  const ledger = z
    .object({
      version: z.literal(2),
      unit: z.literal('tokens'),
      studyId: z.string(),
      sealSha256: hash,
      carriedReservedUnits: z.number().int().nonnegative().default(0),
      reservations: z
        .array(
          z
            .object({
              trialId: z.string(),
              maximumUnits: z.number().int().positive(),
              usageRecordedAt: z.string().optional(),
              usage: z.unknown()
            })
            .passthrough()
        )
        .max(4)
    })
    .passthrough()
    .parse(JSON.parse((await boundedFile(root, 'live-acceptance-budget-ledger.json')).toString()))
  if (
    ledger.studyId !== seal.studyId ||
    ledger.sealSha256 !== seal.sha256 ||
    ledger.carriedReservedUnits !== seal.carriedReservedUnits ||
    new Set(ledger.reservations.map((row) => row.trialId)).size !== ledger.reservations.length
  )
    throw new Error('Resume budget ledger does not match the reviewed study.')
  for (const entry of snapshot.report.entries) {
    const row = ledger.reservations.find((item) => item.trialId === trialIds[entry.entry])
    const receipt = JSON.parse(
      snapshot.files.get(`${entry.entry}/${usageReceiptFilename}`)!.toString()
    )
    if (
      !row ||
      row.maximumUnits !== seal.maximumUnitsPerTrial ||
      !row.usageRecordedAt ||
      !isDeepStrictEqual(row.usage, receipt.usage)
    )
      throw new Error(
        'Completed resume entry is not retained with matching usage in the durable budget ledger.'
      )
  }
}
