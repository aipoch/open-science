const errorDetail = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : undefined

export { errorDetail }
