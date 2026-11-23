import type { LocalModelSnapshot } from './local-models'
import { z } from 'zod'
import { sanitizeExportFilename } from './conversation-export'
import type { ResearchVideoProgress } from '@aipoch/research-film/contracts'

export const RESEARCH_VIDEO_STATUS_TIMEOUT_MS = 30_000
export const RESEARCH_VIDEO_STATUS_TIMEOUT_MESSAGE = 'Research film status timed out. Try again.'
export const RESEARCH_FILM_BUSY_MESSAGE = 'Another film is being generated. Wait for it to finish.'
export const RESEARCH_FILM_MODEL_TIMEOUT_MINUTES = 10
export const RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE = `Research film model request timed out after ${RESEARCH_FILM_MODEL_TIMEOUT_MINUTES} minutes. Try again.`

export const researchFilmModeSchema = z.enum(['research-explanation', 'operation-replay'])
export type ResearchFilmMode = z.infer<typeof researchFilmModeSchema>
export const researchFilmNarrationReviewSchema = z.literal('advisory')
export type ResearchFilmNarrationReview = z.infer<typeof researchFilmNarrationReviewSchema>

export const researchFilmReviewFailureSchema = z.strictObject({
  attemptId: z.uuid(),
  stage: z.enum(['script', 'visual', 'replay']),
  findings: z.array(z.string().min(1).max(500)).min(1).max(12)
})
export type ResearchFilmReviewFailure = z.infer<typeof researchFilmReviewFailureSchema>

export const researchFilmRevisionSchema = z.strictObject({
  attemptId: z.uuid(),
  feedback: z.string().trim().min(1).max(4000)
})
export type ResearchFilmRevision = z.infer<typeof researchFilmRevisionSchema>

export const researchVideoPresentationRequestSchema = z
  .object({
    projectId: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512),
    branchId: z.string().min(1).max(512).optional(),
    mode: researchFilmModeSchema.optional()
  })
  .strict()
export type ResearchVideoPresentationRequest = z.infer<
  typeof researchVideoPresentationRequestSchema
>
export const researchVideoStartRequestSchema = researchVideoPresentationRequestSchema.extend({
  resume: z.boolean().optional(),
  installNarration: z.boolean().optional()
})
export type ResearchVideoStartRequest = z.infer<typeof researchVideoStartRequestSchema>
export const researchVideoOwnerStartRequestSchema = researchVideoStartRequestSchema.extend({
  revision: researchFilmRevisionSchema.optional(),
  headless: z.boolean().optional(),
  // Accepted for clients of the earlier opt-in policy. Narration scoring is always advisory.
  narrationReview: researchFilmNarrationReviewSchema.optional()
})
export type ResearchVideoOwnerStartRequest = z.infer<typeof researchVideoOwnerStartRequestSchema>
export const researchVideoStatusRequestSchema = researchVideoPresentationRequestSchema.extend({
  checkReadiness: z.boolean().optional()
})
export type ResearchVideoStatusRequest = z.infer<typeof researchVideoStatusRequestSchema>
export type ResearchVideoPresentation = {
  id: string
  title: string
  playerPath: string
  sourcePath: string
  duration: number
  scriptScore?: number
  narrationReview?: ResearchFilmNarrationReview
  sessionAppMode?: 'live' | 'drawn'
}
export type ResearchVideoPresentationStatus = {
  branchId?: string
  narrationReview?: ResearchFilmNarrationReview
  reviewFailure?: ResearchFilmReviewFailure
  canResume?: boolean
  filmStep?: number
  narrationDownload?: LocalModelSnapshot
  generationBlock?: 'unavailable' | 'empty' | 'awaiting-reply' | 'busy'
  progress?: ResearchVideoProgress
  result?: ResearchVideoPresentation
  error?: string
  preflightError?: string
}

/** One portable display/export name for both formats; internal job paths remain stable. */
export function researchVideoFilename(title: string, extension: 'html' | 'mp4'): string {
  const stem = sanitizeExportFilename(title.trim() || 'Research explanation', 220)
    .replace(/^[. ]+/u, '')
    .replace(/\s+/gu, '-')
  const safeStem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem) ? `_${stem}` : stem
  return `${safeStem}.${extension}`
}
