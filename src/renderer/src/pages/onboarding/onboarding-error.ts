const onboardingErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error
    ? error.message
    : typeof error === 'string' && error.trim()
      ? error
      : fallback

export { onboardingErrorMessage }
