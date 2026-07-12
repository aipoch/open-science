// Compact star count for the badge: counts under 1000 verbatim, thousands as "1.2k" with a single
// decimal and a trimmed trailing ".0" (e.g. 1000 -> "1k"). Keeps the badge narrow in the sidebar rail.
export const formatStarCount = (count: number): string => {
  if (count < 1000) return String(count)

  const rounded = Math.round((count / 1000) * 10) / 10

  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}k`
}
