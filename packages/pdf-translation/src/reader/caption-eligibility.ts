import type { PdfTranslationSource } from './source.js'

type Unit = PdfTranslationSource['units'][number]
type Input = Pick<PdfTranslationSource, 'resourceRequestKey' | 'fingerprint' | 'pages' | 'units'>
type ProofKind = 'caption' | 'ordinary-prose'
const proofs = new WeakMap<PdfTranslationSource, ReadonlyMap<ProofKind, ReadonlySet<Unit>>>()
const origins = new WeakMap<Unit, PdfTranslationSource>()
const nativeKeys = new WeakMap<PdfTranslationSource, string>()

// Admission flags and original paint crops can change during a local projection.
// Native identity, reading order, literals and every source coordinate cannot.
function nativeKey(source: PdfTranslationSource): string {
  let key = nativeKeys.get(source)
  if (key === undefined) {
    key = JSON.stringify([
      source.resourceRequestKey,
      source.fingerprint,
      source.pages,
      source.units.map(({ id, source, fragments, referenceBoundary }) => [
        id,
        source,
        fragments,
        referenceBoundary
      ])
    ])
    nativeKeys.set(source, key)
  }
  return key
}

/** Completed native proof publishers call this; no serialized field is authority. */
function remember(source: PdfTranslationSource, ids: ReadonlySet<string>, kind: ProofKind): void {
  if (
    !Object.isFrozen(source) ||
    new Set(source.units.map((unit) => unit.id)).size !== source.units.length
  )
    return
  const units = new Set(
    source.units.filter(
      (unit) =>
        ids.has(unit.id) &&
        !unit.sourceOnly &&
        !unit.preserve &&
        !unit.figure &&
        Object.isFrozen(unit)
    )
  )
  if (!units.size) return
  const kinds = new Map(proofs.get(source))
  kinds.set(kind, units)
  proofs.set(source, kinds)
  for (const unit of units) origins.set(unit, source)
}

/** Complete native caption proof only; serialized role flags are never authority. */
export function rememberNativeCaptionEligibility(
  source: PdfTranslationSource,
  ids: ReadonlySet<string>
): void {
  remember(source, ids, 'caption')
}

/** Complete, independently closed ordinary prose proof at the post-structure Source. */
export function rememberNativeOrdinaryProseEligibility(
  source: PdfTranslationSource,
  ids: ReadonlySet<string>
): void {
  remember(source, ids, 'ordinary-prose')
}

export function hasNativeOrdinaryProseEligibility(
  source: PdfTranslationSource,
  unit: Unit
): boolean {
  return proofs.get(source)?.get('ordinary-prose')?.has(unit) === true
}

export function hasNativeCaptionEligibility(source: PdfTranslationSource, unit: Unit): boolean {
  return proofs.get(source)?.get('caption')?.has(unit) === true
}

/** A known local policy projection can retain the same complete native owner. */
export function carryNativeCaptionEligibility(
  from: PdfTranslationSource,
  to: PdfTranslationSource
): PdfTranslationSource {
  const certified = proofs.get(from)
  if (!certified?.size || nativeKey(from) !== nativeKey(to)) return to
  // Both proof kinds use the same complete Source identity and exact-owner rule.
  for (const [kind, owners] of certified) {
    const ids = new Set(
      [...owners]
        .filter((old) => {
          const next = to.units.find((unit) => unit.id === old.id)
          return next && JSON.stringify(next) === JSON.stringify(old)
        })
        .map((unit) => unit.id)
    )
    remember(to, ids, kind)
  }
  return to
}

/** Factory copies inherit authority only from the exact immutable input units.
 * Equal JSON, replacement units, reordered owners or a new source identity do not. */
export function inheritNativeCaptionEligibility(
  input: Input,
  output: PdfTranslationSource
): PdfTranslationSource {
  const origin = proofs.has(input as PdfTranslationSource)
    ? (input as PdfTranslationSource)
    : input.units
        .map((unit) => origins.get(unit))
        .find((source): source is PdfTranslationSource => !!source)
  if (
    !origin ||
    input.pages !== origin.pages ||
    input.resourceRequestKey !== origin.resourceRequestKey ||
    input.fingerprint !== origin.fingerprint ||
    input.units.length !== origin.units.length ||
    input.units.some((unit, index) => unit !== origin.units[index])
  )
    return output
  return carryNativeCaptionEligibility(origin, output)
}
