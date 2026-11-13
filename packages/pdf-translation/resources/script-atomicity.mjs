/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker JavaScript. */
// A retained signed exponent must travel with its native identifier. A space in
// the extracted spelling is not evidence that the raised glyph can wrap alone.
export function nativeSignedScriptRanges(source, target, regions) {
  const pattern =
    /(?<![A-Za-z\p{Script=Greek}\d_/])([A-Za-z\p{Script=Greek}]{1,8})[ \t]*([−+-][ \t]*\d{1,3})(?![A-Za-z\p{Script=Greek}\d])/gu
  const matches = (text) => [...text.matchAll(pattern)]
  const from = matches(source),
    to = matches(target),
    result = []
  const key = (match) => match[0].replace(/[ \t]/gu, '')
  for (const match of from) {
    const same = from.filter((item) => key(item) === key(match)),
      translated = to.filter((item) => key(item) === key(match)),
      mapped = translated[same.indexOf(match)]
    if (!mapped || same.length !== translated.length) continue
    const sourceStart = match.index,
      sourceScript = sourceStart + match[0].indexOf(match[2]),
      targetStart = mapped.index,
      targetScript = targetStart + mapped[0].indexOf(mapped[2]),
      sourceEnd = sourceStart + match[0].length,
      targetEnd = targetStart + mapped[0].length
    const proofs = []
    for (const region of regions) {
      const { nativeScriptMarkers: markers, nativeScriptBodySize: size, anchors } = region
      if (!markers || !(size > 0) || !Number.isFinite(size)) continue
      const bases = markers.filter(
        (marker) => marker.sourceOffset === sourceStart && marker.label === match[1]
      )
      if (bases.length !== 1) continue
      const base = bases[0],
        scripts = markers
          .filter(
            (marker) => marker.sourceOffset >= sourceScript && marker.sourceOffset < sourceEnd
          )
          .toSorted((a, b) => a.sourceOffset - b.sourceOffset)
      if (!scripts.length || Math.abs(base.scale - 1) > 0.05 || Math.abs(base.rise) > size * 0.05)
        continue
      const valid = (marker) =>
        marker.sourceIndices?.length === 1 &&
        Number.isSafeInteger(marker.sourceIndices[0]) &&
        marker.fontName &&
        Number.isFinite(marker.scale) &&
        Number.isFinite(marker.rise) &&
        Number.isFinite(marker.baseline) &&
        Array.isArray(marker.bounds) &&
        marker.bounds.length === 4 &&
        marker.bounds.every(Number.isFinite) &&
        marker.bounds[2] > marker.bounds[0] &&
        marker.bounds[3] > marker.bounds[1] &&
        source.slice(marker.sourceOffset, marker.sourceOffset + marker.label.length) ===
          marker.label
      if (![base, ...scripts].every(valid)) continue
      const indices = [base, ...scripts].flatMap((marker) => marker.sourceIndices)
      if (new Set(indices).size !== indices.length) continue
      let cursor = sourceScript,
        previous = base,
        previousAnchorEnd = targetScript,
        safe = true
      for (const marker of scripts) {
        const own = anchors.filter(
          (anchor) =>
            anchor.indices.length === 1 &&
            anchor.indices[0] === marker.sourceIndices[0] &&
            anchor.sourceOffset === marker.sourceOffset &&
            anchor.label === marker.label &&
            !anchor.annotation &&
            !anchor.nativeFootnoteRow &&
            !anchor.nativeUriFootnote &&
            anchor.movable &&
            Number.isFinite(anchor.baseline)
        )
        const anchor = own[0],
          gap = marker.bounds[0] - previous.bounds[2]
        if (
          own.length !== 1 ||
          !/^[ \t]*$/u.test(source.slice(cursor, marker.sourceOffset)) ||
          marker.scale < 0.5 ||
          marker.scale > 0.85 ||
          marker.rise < size * 0.15 ||
          marker.rise > size * 0.6 ||
          Math.abs(marker.baseline - base.baseline - marker.rise) > size * 0.05 ||
          Math.abs(marker.baseline - scripts[0].baseline) > size * 0.05 ||
          Math.abs(marker.scale - scripts[0].scale) > 0.05 ||
          gap < -size * 0.1 ||
          gap > size * 0.45 ||
          anchor.targetOffset < previousAnchorEnd ||
          anchor.targetOffset + anchor.label.length > targetEnd ||
          !/^[ \t]*$/u.test(target.slice(previousAnchorEnd, anchor.targetOffset)) ||
          Math.abs(anchor.baseline - marker.baseline) > size * 0.02
        ) {
          safe = false
          break
        }
        cursor = marker.sourceOffset + marker.label.length
        previousAnchorEnd = anchor.targetOffset + anchor.label.length
        previous = marker
      }
      if (safe && cursor === sourceEnd && previousAnchorEnd === targetEnd)
        proofs.push({ start: targetStart, scriptStart: targetScript, end: targetEnd })
    }
    // Shared or repeated native ownership cannot establish a unique attachment.
    if (proofs.length === 1) result.push(proofs[0])
  }
  return result
}
