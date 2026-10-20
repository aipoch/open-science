type Json = Record<string, unknown>
export const sanitizeXaiResponsesRequest = (body: Json): Json => {
  // Unsupported request metadata is top-level. Schemas and tool output are opaque business data.
  const sanitized = Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) =>
        value !== null &&
        key !== 'prompt_cache_retention' &&
        key !== 'safety_identifier' &&
        key !== 'external_web_access'
    )
  )
  if (Array.isArray(sanitized.additional_tools)) {
    sanitized.tools = [
      ...(Array.isArray(sanitized.tools) ? sanitized.tools : []),
      ...sanitized.additional_tools
    ]
    delete sanitized.additional_tools
  }
  return sanitized
}
