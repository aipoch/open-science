// A react-i18next stub for structure tests that call components as plain functions instead of
// rendering them. There is no React context in that mode, so the real useTranslation hook throws.
//
// Keys are the English source text, so English has no catalog and the stub echoes the key back —
// exactly what real i18next does on a missing key, interpolation included. There is nothing to look
// up and no namespace to resolve, which is why this is so much smaller than the version that
// preceded natural-language keys.

type Values = Record<string, unknown>

// Mirrors i18next's plural resolution for English, verified against the real library: the key is the
// plural ('other') form, and a call that needs a distinct singular passes it as `defaultValue_one`.
// Without that option a count of 1 renders the plural key verbatim ("1 files selected"), so callers
// that pluralize must supply it — and this stub reproduces that failure rather than papering over it.
const template = (key: string, values?: Values): string =>
  values?.count === 1 && typeof values.defaultValue_one === 'string' ? values.defaultValue_one : key

// {{name}} placeholders resolve from the same options object i18next reads, so `count` interpolates
// alongside the caller's own values. Reserved options (context, defaultValue_one) are simply never
// referenced by a placeholder, so passing them through is harmless.
export const translateForTest = (key: string, values?: Values): string =>
  Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    template(key, values)
  )

// Pass straight to vi.mock('react-i18next', () => createI18nTestStub()). The factory body runs
// lazily, so referencing this import from inside it is safe despite vi.mock hoisting.
export const createI18nTestStub = (): {
  useTranslation: () => { t: (key: string, values?: Values) => string }
  Trans: (props: { i18nKey: string; values?: Values }) => string
} => ({
  useTranslation: () => ({ t: translateForTest }),
  // Structure tests assert on text, so collapse Trans to its resolved string; the real component's
  // element interpolation is covered by the render tests that mount through React.
  Trans: ({ i18nKey, values }) => translateForTest(i18nKey, values)
})
