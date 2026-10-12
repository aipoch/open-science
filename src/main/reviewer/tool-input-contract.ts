import { z } from 'zod'
import {
  MAX_SPREADSHEET_CELLS,
  MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_ROW_SPAN,
  MAX_XLSX_ROWS
} from './bounded-artifact-content'
import {
  MAX_REVIEW_CHECKS,
  MAX_REVIEW_CLAIM_CHARACTERS,
  MAX_REVIEW_EVIDENCE_CHARACTERS,
  MAX_REVIEW_SUBMISSION_BYTES,
  reviewSubmissionByteLength
} from './submission-limits'

// Zod schema for the optional locator on a check submitted by the reviewer.
export const checkLocatorSchema = z.object({
  blockRef: z
    .object({
      messageId: z.string().optional(),
      activityId: z.string().optional(),
      blockIndex: z.number().int().min(0)
    })
    .describe('Identifies the block within the turn this check points at'),
  contentHash: z.string().describe('The contentHash of the block this check points at')
})

export const checkFields = {
  claim: z
    .string()
    .min(1)
    .max(MAX_REVIEW_CLAIM_CHARACTERS)
    .describe('The specific claim or thing being checked'),
  evidence: z
    .string()
    .min(1)
    .max(MAX_REVIEW_EVIDENCE_CHARACTERS)
    .describe(
      'Supporting evidence from the turn (cite block ids / exec-log entries / artifact content you read). ' +
        'For pass checks: describe what you verified and why it passed. ' +
        'For warn/fail: describe the contradiction found.'
    ),
  sourceFindingId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable id of an original Review Check being re-evaluated. Required for every tracked check ' +
        'during a fix-loop re-review; never invent or rewrite this id.'
    ),
  artifactVersionId: z
    .string()
    .optional()
    .describe('If this check relates to an artifact, its version id')
}

// The status controls the locator contract at the schema seam: pass may summarize a verified area,
// while warn/fail must identify the exact frozen block whose claim is being challenged.
export const checkSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pass').describe('Verified and supported by the audited evidence.'),
    ...checkFields,
    locator: checkLocatorSchema
      .optional()
      .describe('Optional block-level locator for a passing verification.')
  }),
  z.object({
    status: z.enum(['warn', 'fail']).describe('A warning or failure that requires exact location.'),
    ...checkFields,
    locator: checkLocatorSchema.describe(
      'Required block-level locator for the claim being warned or failed.'
    )
  })
])

// The top-level submit_findings input schema.
// v2: a single `checks[]` replaces the old findings[]+summary+checks[] split.
// v3: reasoning removed — the reviewer log is captured from the action stream, not self-authored.
// summary is explicitly excluded — the panel no longer shows it.
export type SubmitFindingsObjectSchema = z.ZodObject<{
  checks: z.ZodArray<typeof checkSchema>
}>

export type SubmitFindingsInput = z.infer<SubmitFindingsObjectSchema>

export const createSubmitFindingsObjectSchema = (
  mode: 'initial' | 'tracked',
  trackedCheckAllowance: number | null = 0
): SubmitFindingsObjectSchema => {
  const checksSchema =
    mode === 'tracked'
      ? z.array(checkSchema).min(1, 'A tracked re-review must disposition every tracked check.')
      : z.array(checkSchema)
  const boundedChecksSchema =
    trackedCheckAllowance === null
      ? checksSchema
      : checksSchema.max(
          MAX_REVIEW_CHECKS + trackedCheckAllowance,
          `At most ${MAX_REVIEW_CHECKS} new findings are allowed beyond tracked dispositions`
        )

  return z
    .object({
      checks: boundedChecksSchema.describe(
        'All checks you ran, each with status pass|warn|fail, claim, and evidence. ' +
          'A locator is required for warn/fail and optional for pass. ' +
          'An initial review may submit an empty array only when the frozen turn contains no ' +
          'checkable claims; tracked re-reviews must disposition every tracked check.'
      )
    })
    .strict() // Reject unknown fields including the old `summary`, old `findings`, and old `reasoning`
}

export const createSubmitFindingsInputSchema = (
  mode: 'initial' | 'tracked',
  trackedCheckAllowance = 0
): z.ZodType<SubmitFindingsInput> =>
  createSubmitFindingsObjectSchema(mode, trackedCheckAllowance).superRefine((input, context) => {
    const bytes = reviewSubmissionByteLength(input.checks)
    if (bytes > MAX_REVIEW_SUBMISSION_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message:
          `Reviewer result exceeds the ${MAX_REVIEW_SUBMISSION_BYTES}-byte limit ` +
          `(got ${bytes} bytes)`
      })
    }
  })

export const submitFindingsInputSchema = createSubmitFindingsInputSchema('initial')

export const submitFindingsBridgeInputSchema = createSubmitFindingsObjectSchema('initial', null)

export const reviewerArtifactReadInputSchema = z
  .object({
    id: z.string().min(1).describe('In-scope immutable file Version id'),
    view: z
      .enum(['trace', 'content'])
      .optional()
      .describe('Trace provenance or final content; omitted remains content'),
    offset: z.number().int().min(0).optional().describe('Byte offset for a bounded page'),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Requested source bytes; the host clamps this to its page limit'),
    pages: z
      .array(z.number().int().positive())
      .min(1)
      .max(32)
      .optional()
      .describe('Exact 1-based PDF/DOCX pages or PPTX slides needed for the claim'),
    sheet: z.string().min(1).max(255).optional().describe('Exact XLSX sheet name'),
    rowStart: z
      .number()
      .int()
      .positive()
      .max(MAX_XLSX_ROWS)
      .optional()
      .describe('First 1-based XLSX row'),
    rowEnd: z
      .number()
      .int()
      .positive()
      .max(MAX_XLSX_ROWS)
      .optional()
      .describe('Last 1-based XLSX row'),
    columns: z
      .array(
        z
          .string()
          .max(3)
          .regex(/^[A-Z]+$/i)
      )
      .min(1)
      .max(MAX_SPREADSHEET_COLUMNS)
      .optional()
      .describe('Exact XLSX column letters needed for the claim'),
    includePreview: z
      .boolean()
      .optional()
      .describe('Include bounded page/slide preview images for a visual claim')
  })
  .strict()
  .superRefine((input, context) => {
    const start = input.rowStart ?? 1
    const end = input.rowEnd ?? start + 99
    const span = end - start + 1
    if (span < 1 || span > MAX_SPREADSHEET_ROW_SPAN) {
      context.addIssue({
        code: 'custom',
        path: ['rowEnd'],
        message: `Spreadsheet row span must be between 1 and ${MAX_SPREADSHEET_ROW_SPAN}`
      })
    }
    const cells = span * (input.columns?.length ?? MAX_SPREADSHEET_COLUMNS)
    if (cells > MAX_SPREADSHEET_CELLS) {
      context.addIssue({
        code: 'custom',
        path: ['columns'],
        message: `Spreadsheet target exceeds ${MAX_SPREADSHEET_CELLS} cells`
      })
    }
  })
