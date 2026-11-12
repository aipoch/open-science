import type { LocalModelSnapshot } from './local-models'
import { z } from 'zod'
import { sanitizeExportFilename } from './conversation-export'
import type { ResearchVideoProgress } from '@aipoch/research-film/contracts'

export const researchVideoPresentationRequestSchema = z
  .object({
    projectId: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512),
    branchId: z.string().min(1).max(512).optional()
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
}
export type ResearchVideoPresentationStatus = {
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
