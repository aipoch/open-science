// Cross-process download progress vocabulary + display formatters. No I/O so both main and renderer
// import it. formatBytes is reused from update.ts to keep one byte-unit convention app-wide.
import { formatBytes } from './update'

export type DownloadPhase = 'downloading' | 'reconnecting'

export type DownloadProgress = {
  phase: DownloadPhase
  transferred: number
  total?: number
  percent?: number
  bytesPerSecond: number
  etaSeconds?: number
  attempt: number
}

export const formatSpeed = (bytesPerSecond: number): string =>
  bytesPerSecond <= 0 ? '0 B/s' : `${formatBytes(bytesPerSecond)}/s`

export const formatEta = (seconds?: number): string | undefined => {
  if (seconds == null) return undefined
  if (seconds < 60) return `~${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `~${m}m` : `~${m}m ${s}s`
}

// One-line summary shown under the progress bar. Reconnecting takes priority so a mid-stall line
// reads as "resuming" rather than a frozen speed of 0.
export const formatProgressLine = (p: DownloadProgress): string => {
  if (p.phase === 'reconnecting') return `Connection lost, resuming… (attempt ${p.attempt})`
  const speed = formatSpeed(p.bytesPerSecond)
  if (p.total != null && p.percent != null) {
    const eta = formatEta(p.etaSeconds)
    const size = `${formatBytes(p.transferred)} / ${formatBytes(p.total)}`
    return [speed, size, `${p.percent}%`, eta].filter(Boolean).join(' · ')
  }
  return `${speed} · ${formatBytes(p.transferred)} downloaded`
}
