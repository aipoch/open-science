import { z } from 'zod'

const names = z
  .array(z.string().min(1).max(256))
  .max(64)
  .refine((v) => new Set(v).size === v.length)
const tolerance = z.number().finite().nonnegative().max(1e12)
const column = z.string().min(1).max(256)
const ratio = z.number().finite().min(0).max(1)
export const scientificComparisonPolicySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('differential-expression'),
      geneColumn: column,
      effectColumn: column,
      adjustedPColumn: column,
      contrast: z.string().min(1).max(256),
      adjustedPThreshold: z.number().finite().gt(0).lt(1),
      minimumAbsoluteEffect: tolerance,
      minimumGeneJaccard: ratio,
      minimumDirectionAgreement: ratio
    })
    .strict(),
  z
    .object({
      kind: z.literal('cell-clusters'),
      cellColumn: column,
      clusterColumn: column,
      minimumAdjustedRand: z.number().finite().min(-1).max(1)
    })
    .strict()
])
export type ScientificComparisonPolicy = z.infer<typeof scientificComparisonPolicySchema>
export const scientificComparisonReportSchema = z
  .object({
    kind: z.enum(['differential-expression', 'cell-clusters']),
    outcome: z.enum(['meets-criteria', 'does-not-meet', 'unavailable']),
    reason: z
      .enum([
        'missing-column',
        'duplicate-id',
        'missing-id',
        'invalid-value',
        'different-identifiers',
        'no-comparable-results'
      ])
      .optional(),
    identifiers: z.number().int().nonnegative(),
    missingIdentifiers: z.number().int().nonnegative(),
    addedIdentifiers: z.number().int().nonnegative(),
    expectedSignificant: z.number().int().nonnegative().optional(),
    actualSignificant: z.number().int().nonnegative().optional(),
    commonSignificant: z.number().int().nonnegative().optional(),
    missingValueChanges: z.number().int().nonnegative().optional(),
    geneJaccard: ratio.optional(),
    directionAgreement: ratio.optional(),
    adjustedRand: z.number().finite().min(-1).max(1).optional()
  })
  .strict()
export type ScientificComparisonReport = z.infer<typeof scientificComparisonReportSchema>
export const outputComparisonPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    scientific: scientificComparisonPolicySchema.optional(),
    table: z
      .object({
        keys: names,
        numericColumns: names,
        absoluteTolerance: tolerance,
        relativeTolerance: tolerance
      })
      .strict(),
    image: z
      .object({
        maxRmse: z.number().finite().min(0).max(255),
        maxChangedPixelRatio: z.number().finite().min(0).max(1)
      })
      .strict()
  })
  .strict()

export type OutputComparisonPolicy = z.infer<typeof outputComparisonPolicySchema>
export const DEFAULT_OUTPUT_COMPARISON_POLICY: OutputComparisonPolicy = {
  schemaVersion: 1,
  table: { keys: [], numericColumns: [], absoluteTolerance: 0, relativeTolerance: 0 },
  image: { maxRmse: 0, maxChangedPixelRatio: 0 }
}

const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
export const outputComparisonReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    comparator: z.literal('open-science-content-v1'),
    policy: outputComparisonPolicySchema,
    policyChecksum: hash,
    expectedChecksum: hash,
    actualChecksum: hash,
    scientific: scientificComparisonReportSchema.optional(),
    kind: z.enum(['image', 'table', 'unsupported']),
    outcome: z.enum(['equal', 'within-tolerance', 'different', 'unavailable']),
    reason: z
      .enum([
        'unsupported-format',
        'invalid-content',
        'budget-exceeded',
        'shape-mismatch',
        'schema-mismatch',
        'duplicate-key',
        'missing-key',
        'comparison-failed'
      ])
      .optional(),
    image: z
      .object({
        width: size,
        height: size,
        changedPixels: size,
        changedPixelRatio: z.number().min(0).max(1),
        rmse: z.number().finite().min(0).max(255),
        // Errors remain on a 0–255 scale; 16-bit samples retain fractional differences.
        maxDifference: z.number().finite().min(0).max(255),
        bitDepth: z.union([z.literal(8), z.literal(16)]).optional(),
        // Luminance, uniform 7x7 windows, sample covariance; alpha remains part of pixel comparison.
        ssim: z.number().finite().min(-1).max(1).optional()
      })
      .strict()
      .optional(),
    table: z
      .object({
        expectedRows: size,
        actualRows: size,
        columns: size,
        changedCells: size,
        outsideTolerance: size,
        missingRows: size,
        addedRows: size,
        maxAbsoluteError: z.number().finite().nonnegative(),
        differences: z
          .array(
            z
              .object({
                row: z.string().max(512),
                column: z.string().max(256),
                expected: z.string().max(512),
                actual: z.string().max(512),
                withinTolerance: z.boolean()
              })
              .strict()
          )
          .max(100),
        detailsTruncated: z.boolean()
      })
      .strict()
      .optional()
  })
  .strict()
export type OutputComparisonReport = z.infer<typeof outputComparisonReportSchema>
