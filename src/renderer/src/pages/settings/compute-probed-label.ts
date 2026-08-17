import type { ComputeHost } from '../../../../shared/compute'
import { relativeTimeParts, type RelativeTimeUnit } from '@/lib/format-relative-time'

// Buckets a host's last probe time into a catalog key plus its count, for the "probed 2 h ago" line the
// list and the detail page both render. Kept pure and locale-free: the unit sits after the number in
// English and before "前" in Chinese, so only the catalog can place it. Lives in its own module because
// react-refresh forbids a .tsx from exporting anything but components, and two views need this.
//
// Keys are the English source text, so the unit has to be spelled out per bucket rather than built by
// interpolation — a `probed {{count}} {{unit}} ago` template would put the English word order into
// every locale. The map is exhaustive over RelativeTimeUnit so a new bucket fails to compile.
const PROBED_LABELS = {
  now: 'probed just now',
  minute: 'probed {{count}} min ago',
  hour: 'probed {{count}} h ago',
  day: 'probed {{count}} d ago',
  week: 'probed {{count}} w ago',
  month: 'probed {{count}} mo ago',
  year: 'probed {{count}} y ago'
} as const satisfies Record<RelativeTimeUnit, string>

// Returns null when the host has never been probed, or when the stored timestamp doesn't parse.
export type ProbedLabel = {
  key: (typeof PROBED_LABELS)[RelativeTimeUnit]
  count: number
}

export const probedLabel = (host: ComputeHost): ProbedLabel | null => {
  const probedAt = host.probeResult?.probedAt
  if (!probedAt) return null
  const then = Date.parse(probedAt)
  if (Number.isNaN(then)) return null
  const { unit, count } = relativeTimeParts(then)
  return { key: PROBED_LABELS[unit], count }
}
