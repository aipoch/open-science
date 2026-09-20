import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { compareScientificTables } from './scientific-output-comparison'
import {
  DEFAULT_OUTPUT_COMPARISON_POLICY,
  outputComparisonPolicySchema,
  outputComparisonReportSchema,
  type OutputComparisonPolicy,
  type OutputComparisonReport
} from '../../shared/output-comparison'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import {
  compareOutputContent,
  type OutputComparisonWorkerInput,
  type OutputComparisonWorkerResult
} from './output-comparison-worker'

const workerSource = `const { parentPort, workerData } = require('node:worker_threads');
(${compareOutputContent.toString()})(workerData.input, require(workerData.sharp), require(workerData.papa), (${compareScientificTables.toString()}))
.then(value => parentPort.postMessage(value), () => parentPort.postMessage({ kind: 'unsupported', outcome: 'unavailable', reason: 'comparison-failed' }));`

const execute = async (
  input: OutputComparisonWorkerInput,
  signal?: AbortSignal
): Promise<OutputComparisonWorkerResult> => {
  signal?.throwIfAborted()
  const require = createRequire(import.meta.url)
  const worker = new Worker(workerSource, {
    eval: true,
    // The worker is self-contained CommonJS; parent launch loaders/input modes do not apply.
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    workerData: { input, sharp: require.resolve('sharp'), papa: require.resolve('papaparse') }
  })
  try {
    return await new Promise<OutputComparisonWorkerResult>((resolve, reject) => {
      const abort = (): void => reject(signal?.reason ?? new Error('Comparison cancelled.'))
      const timer = setTimeout(() => reject(new Error('Comparison timed out.')), 30_000)
      signal?.addEventListener('abort', abort, { once: true })
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      worker.once('message', (value: OutputComparisonWorkerResult) => {
        cleanup()
        resolve(value)
      })
      worker.once('error', (error) => {
        cleanup()
        reject(error)
      })
      worker.once('exit', () => {
        cleanup()
        reject(new Error('Comparison worker stopped.'))
      })
    })
  } finally {
    await worker.terminate()
  }
}

// Bound concurrency across preview requests and checks; kernels keep their own lifecycle.
let queue: Promise<unknown> = Promise.resolve()
let pending = 0
export const compareReproducedContent = async (input: {
  filename: string
  expected: Buffer
  actual: Buffer
  policy?: OutputComparisonPolicy
  preview?: boolean
  signal?: AbortSignal
}): Promise<{
  report: OutputComparisonReport
  differenceImage?: string
  originalImage?: string
  reproducedImage?: string
}> => {
  const policy = outputComparisonPolicySchema.parse(
    input.policy ?? DEFAULT_OUTPUT_COMPARISON_POLICY
  )
  const base = {
    schemaVersion: 1 as const,
    comparator: 'open-science-content-v1' as const,
    policy,
    policyChecksum: sha256(canonicalJson(policy as CanonicalJson)),
    expectedChecksum: sha256(input.expected),
    actualChecksum: sha256(input.actual)
  }
  const run = async (): Promise<OutputComparisonWorkerResult> => {
    input.signal?.throwIfAborted()
    if (Math.max(input.expected.length, input.actual.length) > 32 * 1024 * 1024)
      return { kind: 'unsupported', outcome: 'unavailable', reason: 'budget-exceeded' }
    try {
      return await execute(
        {
          expected: input.expected,
          actual: input.actual,
          filename: input.filename,
          policy,
          preview: input.preview
        },
        input.signal
      )
    } catch {
      input.signal?.throwIfAborted()
      return { kind: 'unsupported', outcome: 'unavailable', reason: 'comparison-failed' }
    }
  }
  if (pending >= 2) {
    return {
      report: { ...base, kind: 'unsupported', outcome: 'unavailable', reason: 'budget-exceeded' }
    }
  }
  pending++
  const result = queue.then(run, run).finally(() => {
    pending--
  })
  queue = result.catch(() => undefined)
  const { differenceImage, originalImage, reproducedImage, ...metrics } = await result
  const report = outputComparisonReportSchema.parse({ ...base, ...metrics })
  return {
    report,
    ...(differenceImage ? { differenceImage } : {}),
    ...(originalImage ? { originalImage } : {}),
    ...(reproducedImage ? { reproducedImage } : {})
  }
}

export const validOutputComparisonReport = (
  value: unknown,
  expected: string,
  actual: unknown
): boolean => {
  const parsed = outputComparisonReportSchema.safeParse(value)
  if (!parsed.success) return false
  const report = parsed.data
  if (
    report.scientific &&
    (!report.policy.scientific ||
      report.scientific.kind !== report.policy.scientific.kind ||
      report.kind !== 'table')
  )
    return false
  if (report.scientific && report.policy.scientific) {
    const m = report.scientific,
      policy = report.policy.scientific
    if (
      m.identifiers > 100_000 ||
      m.missingIdentifiers > m.identifiers ||
      m.addedIdentifiers > 100_000
    )
      return false
    if (m.reason === 'different-identifiers') {
      if (m.outcome !== 'does-not-meet' || !(m.missingIdentifiers || m.addedIdentifiers))
        return false
    } else if (m.missingIdentifiers || m.addedIdentifiers) return false
    if (m.outcome === 'unavailable' && !m.reason) return false
    if (m.outcome === 'meets-criteria' && (m.reason || m.identifiers < 2)) return false
    if (!m.reason) {
      if (policy.kind === 'cell-clusters') {
        if (
          m.adjustedRand === undefined ||
          m.geneJaccard !== undefined ||
          m.outcome !==
            (m.adjustedRand >= policy.minimumAdjustedRand ? 'meets-criteria' : 'does-not-meet')
        )
          return false
      } else {
        const {
          expectedSignificant: a,
          actualSignificant: b,
          commonSignificant: c,
          missingValueChanges: missing,
          geneJaccard,
          directionAgreement
        } = m
        if (
          a === undefined ||
          b === undefined ||
          c === undefined ||
          missing === undefined ||
          geneJaccard === undefined ||
          directionAgreement === undefined ||
          a > m.identifiers ||
          b > m.identifiers ||
          c > Math.min(a, b) ||
          c === 0 ||
          missing > m.identifiers ||
          geneJaccard !== c / (a + b - c) ||
          m.adjustedRand !== undefined
        )
          return false
        const accepted =
          !missing &&
          geneJaccard >= policy.minimumGeneJaccard &&
          directionAgreement >= policy.minimumDirectionAgreement
        if (m.outcome !== (accepted ? 'meets-criteria' : 'does-not-meet')) return false
      }
    } else if (
      m.outcome !== 'unavailable' &&
      m.reason !== 'different-identifiers' &&
      m.reason !== 'no-comparable-results'
    )
      return false
  }
  if (report.kind === 'image' && report.table) return false
  if (report.kind === 'table' && report.image) return false
  if (report.outcome === 'unavailable') {
    if (!report.reason || report.image || report.table) return false
  } else if (report.image) {
    const m = report.image
    if (
      report.reason ||
      m.width < 1 ||
      m.height < 1 ||
      m.width * m.height > 4_000_000 ||
      m.changedPixels > m.width * m.height ||
      m.maxDifference > 255 ||
      (m.bitDepth !== 16 && !Number.isInteger(m.maxDifference)) ||
      m.changedPixelRatio !== m.changedPixels / (m.width * m.height)
    )
      return false
    const outcome =
      m.changedPixels === 0
        ? 'equal'
        : m.rmse <= report.policy.image.maxRmse &&
            m.changedPixelRatio <= report.policy.image.maxChangedPixelRatio
          ? 'within-tolerance'
          : 'different'
    if (
      report.outcome !== outcome ||
      (m.changedPixels === 0 && (m.rmse !== 0 || m.maxDifference !== 0))
    )
      return false
  } else if (report.table) {
    const m = report.table
    if (
      report.reason ||
      m.outsideTolerance > m.changedCells ||
      m.differences.length > m.changedCells ||
      m.missingRows > m.expectedRows ||
      m.addedRows > m.actualRows ||
      m.expectedRows - m.missingRows !== m.actualRows - m.addedRows ||
      m.changedCells > (m.expectedRows - m.missingRows) * m.columns
    )
      return false
    const outcome =
      m.missingRows || m.addedRows || m.outsideTolerance
        ? 'different'
        : m.changedCells
          ? 'within-tolerance'
          : 'equal'
    if (report.outcome !== outcome) return false
  } else if (
    report.outcome !== 'different' ||
    !(
      (report.kind === 'image' && report.reason === 'shape-mismatch') ||
      (report.kind === 'table' && report.reason === 'schema-mismatch')
    )
  )
    return false
  return (
    report.expectedChecksum === expected &&
    report.actualChecksum === actual &&
    report.policyChecksum === sha256(canonicalJson(report.policy as CanonicalJson)) &&
    (report.outcome === 'unavailable' ||
      (report.kind === 'image' &&
        (report.image !== undefined || report.reason === 'shape-mismatch')) ||
      (report.kind === 'table' &&
        (report.table !== undefined || report.reason === 'schema-mismatch')))
  )
}
