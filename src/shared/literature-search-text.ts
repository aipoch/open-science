// Version 1 is also used by the immutable literature search migration. Change the persisted
// normalization only with a new migration so historical and newly written values stay equivalent.
export const normalizeLiteratureSearchTextV1 = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
