import { z } from 'zod'

export const researchVideoResolutionSchema = z.enum(['720p', '1080p', '4k'])
export type ResearchVideoResolution = z.infer<typeof researchVideoResolutionSchema>

export const RESEARCH_VIDEO_EXPORT_OPTIONS = {
  '720p': { label: '720p', width: 1280, height: 720, minutesPerMinute: [2, 6] },
  '1080p': { label: '1080p', width: 1920, height: 1080, minutesPerMinute: [3, 10] },
  '4k': { label: '4K', width: 3840, height: 2160, minutesPerMinute: [6, 24] }
} as const

/** Planning ranges, not a benchmark or a countdown; older players may omit duration. */
export function researchVideoExportEstimate(
  resolution: ResearchVideoResolution,
  duration?: number
): { min: number; max: number; perMinute: boolean } {
  const perMinute = !(Number.isFinite(duration) && duration! > 0 && duration! <= 3600)
  const minutes = perMinute ? 1 : duration! / 60
  const [lower, upper] = RESEARCH_VIDEO_EXPORT_OPTIONS[resolution].minutesPerMinute
  const min = Math.max(1, Math.ceil(minutes * lower))
  return { min, max: Math.max(min + 1, Math.ceil(minutes * upper)), perMinute }
}

/** Leave room beyond the planning range; the encoder separately detects stalled frames. */
export function researchVideoExportTimeout(
  resolution: ResearchVideoResolution,
  duration: number
): number {
  return Math.max(60 * 60_000, researchVideoExportEstimate(resolution, duration).max * 2 * 60_000)
}
