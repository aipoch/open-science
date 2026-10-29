// Persisted DOI key version 1. Changes to these rules require a new database migration/version.
export const normalizeLiteratureDoiValueV1 = (value: string): string => {
  const candidate = value
    .trim()
    .replace(/^doi:\s*/iu, '')
    .trim()
  // Unwrap resolver URLs without URL's dot-segment normalization of an opaque DOI suffix.
  const path = /^https?:\/\/(?:dx\.)?doi\.org\/([^?#]*)(?:[?#].*)?$/iu.exec(candidate)?.[1]
  if (path === undefined) return candidate
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export const normalizeLiteratureDoiKeyV1 = (value: string): string =>
  normalizeLiteratureDoiValueV1(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase())
