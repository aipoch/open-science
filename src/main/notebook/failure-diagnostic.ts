type BoundedFailureDiagnosticOptions = Readonly<{
  fallback: string
  prefix?: string
  limit?: number
}>

const boundedFailureDiagnostic = (
  failure: unknown,
  { fallback, prefix = '', limit = 2_000 }: BoundedFailureDiagnosticOptions
): string => {
  let detail = fallback
  try {
    const readable = failure instanceof Error ? failure.message : String(failure)
    if (readable) detail = readable
  } catch {
    // A hostile rejected value must not break the receipt-bearing failure contract.
  }
  return `${prefix}${detail}`.slice(0, limit)
}

export { boundedFailureDiagnostic }
