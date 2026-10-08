import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Test-only synthetic records; production never reads this corpus. */
export function readPdfTranslationCases<T>(filename: string): T[] {
  return readFileSync(resolve('test/fixtures/pdf-translation', filename), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T)
}
