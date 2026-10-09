/** Display only: labels never replace exact receiving Artifact/Version identity. */
export function recordingSourceLabel(
  {
    format,
    name,
    title,
    number
  }: {
    format?: 'web-recording' | 'project-recording' | 'run-observation'
    name: string
    title?: string
    number: number
  },
  t: (key: string, options?: { number: number }) => string
): string {
  const declared = title?.trim()
  if (declared) return declared
  if (name.length <= 80 && !/\.json$/i.test(name)) return name
  return format === 'web-recording'
    ? t('Web recording {{number}}', { number })
    : format === 'project-recording'
      ? t('Project recording {{number}}', { number })
      : t('Archived observation {{number}}', { number })
}
