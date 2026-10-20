/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled worker helper. */
const identifiers = (text) => {
  const pattern =
    /(?:max|min)[a-z\p{Script=Greek}]∈\[[A-Za-z\p{Script=Greek}\d]+\]|[A-Z]1\[[a-z\p{Script=Greek}][<>≤≥]\d+\]|(?:E\[[A-Za-z\p{Script=Greek}]\]){1,2}T|[A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]*(?:(?:ˆ|\u0302)\s*[A-Za-z\p{Script=Greek}\d]*)?′{0,3}(?:[∈<>≤≥×−+-][A-Za-z\p{Script=Greek}\d]+|,[\p{Script=Greek}\d][A-Za-z\p{Script=Greek}\d]*|\.{3}[A-Za-z\p{Script=Greek}\d]+)*(?:\([A-Za-z\p{Script=Greek}\d−+-]+\)[A-Za-z]?)?/gu
  const result = [...text.matchAll(pattern)]
  // A prose qualifier follows the variable, not its native lowered suffix:
  // d_model-dimensional. Only native script evidence can choose this prefix.
  for (const match of text.matchAll(/\b([A-Za-z\p{Script=Greek}]+)-[a-z]{3,}\b/gu)) {
    const prefix = [match[1]]
    prefix.index = match.index
    result.push(prefix)
  }
  // Add spaced suffix candidates without swallowing neighboring ordinary tokens.
  // Only native lowered markers can select these candidates below.
  result.push(...text.matchAll(/\b[A-Za-z\p{Script=Greek}][a-z] [a-z]\b/gu))
  // A callee keeps its own scripts when a parenthesized prose qualifier is
  // translated, e.g. NETGate(baseline) -> NETGate（基线）.
  for (const token of [...result]) {
    const end = token[0].indexOf('(')
    if (end > 0 && /^(?:baseline|reference|proposed|ours)$/iu.test(token[0].slice(end + 1, -1))) {
      const base = [token[0].slice(0, end)]
      base.index = token.index
      result.push(base)
    }
  }
  // A function call also contains identifiers in its argument: p(gt) must not
  // hide g's native subscript behind the outer call token.
  for (const argument of text.matchAll(/\(([^()]*)\)/gu)) {
    for (const inner of argument[1].matchAll(pattern)) {
      inner.index += argument.index + 1
      if (!result.some((match) => match.index === inner.index && match[0] === inner[0]))
        result.push(inner)
    }
  }
  // A raised parenthesized index may be explained on its own in prose.
  // Keep it distinct from a function argument or an attached x(m) index.
  result.push(
    ...text.matchAll(
      /(?<![A-Za-z\p{Script=Greek}\d])\([A-Za-z\p{Script=Greek}]{1,3}\)(?![A-Za-z\p{Script=Greek}\d])/gu
    )
  )
  // A collection's limits belong to its closing brace; keep inner variables
  // as separate tokens so their own indices can still be resolved.
  result.push(...text.matchAll(/\}[A-Z][a-z]=\d{1,3}(?![A-Za-z\p{Script=Greek}\d])/gu))
  return result.sort((a, b) => a.index - b.index || a[0].length - b[0].length)
}
const sameStyle = (a, b) => Math.abs(a.scale - b.scale) < 0.01 && Math.abs(a.rise - b.rise) < 0.01

// Preserve a complete parameterized operator when its lowered parameters have
// their own raised indices, a raised parameter with its own lowered index, or
// a compact slashed derivative. Every character and native script level must
// be proven; flat identifiers are not anchors.
export const resolveNestedScriptGroups = (source, translation, markers) => {
  const pattern =
      /(?<![A-Za-z\p{Script=Greek}\d⊥])(?:[A-Z]{1,4}(?:\p{Script=Greek}\([A-Za-z\d]+\))(?:,\p{Script=Greek}\([A-Za-z\d]+\))+|∂[A-Za-z\p{Script=Greek}ℓ`]\/∂[A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]*(?:[−+-]\d+)?|[A-Za-z\p{Script=Greek}](?:[A-Za-z\p{Script=Greek}\d]{2,7}|[A-Za-z\p{Script=Greek}\d]⊥))(?![A-Za-z\p{Script=Greek}\d⊥])/gu,
    sourceGroups = [...source.matchAll(pattern)],
    targetGroups = [...translation.matchAll(pattern)],
    groups = []
  // Publishers can insert a space between a body variable and its native
  // scripts (W Qi), with a comma sharing the variable's object. Keep the
  // complete script stack; the body object and its punctuation remain prose.
  // Exact token identity, native adjacency and attachment prove ownership.
  const spaced = (text) => [
      ...text.matchAll(
        /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'\u{1d400}-\u{1d7ff}])([A-Z\p{Script=Greek}]) ([A-Z\p{Script=Greek}][a-z]?)(?![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'\u{1d400}-\u{1d7ff}])/gu
      )
    ],
    spacedSources = spaced(source),
    spacedTargets = spaced(translation)
  for (const token of spacedSources) {
    const start = token.index + 2,
      end = token.index + token[0].length,
      bases = markers.filter(
        (marker) =>
          marker.sourceOffset <= token.index &&
          marker.sourceOffset + marker.label.length === token.index + 1 &&
          /^(?:[,;:]\s*)?[A-Z\p{Script=Greek}]$/u.test(marker.label) &&
          source.slice(marker.sourceOffset, token.index + 1) === marker.label
      ),
      parts = markers
        .filter((marker) => marker.sourceOffset >= start && marker.sourceOffset < end)
        .sort((a, b) => a.sourceOffset - b.sourceOffset),
      from = spacedSources.filter((value) => value[0] === token[0]),
      to = spacedTargets.filter((value) => value[0] === token[0]),
      base = bases[0],
      upper = parts[0],
      lower = parts[1]
    if (
      bases.length !== 1 ||
      parts.length !== token[2].length ||
      from.length !== to.length ||
      ![base, ...parts].every(
        (marker, index, all) =>
          Number.isFinite(marker.scale) &&
          Number.isFinite(marker.rise) &&
          marker.sourceIndices.length === 1 &&
          Number.isInteger(marker.sourceIndices[0]) &&
          marker.sourceIndices[0] >= 0 &&
          (!index || marker.sourceIndices[0] === all[index - 1].sourceIndices[0] + 1) &&
          marker.bounds?.length === 4 &&
          marker.bounds.every(Number.isFinite) &&
          marker.bounds[0] < marker.bounds[2] &&
          marker.bounds[1] < marker.bounds[3]
      ) ||
      base.scale < 0.9 ||
      base.scale > 1.1 ||
      Math.abs(base.rise) > 0.01 ||
      !parts.every(
        (part, index) =>
          part.label === token[2][index] &&
          part.sourceOffset === start + index &&
          part.scale >= 0.5 &&
          part.scale < 0.85
      ) ||
      upper.rise <= 0.1 ||
      (lower && (lower.rise >= -0.1 || Math.abs(lower.scale - upper.scale) >= 0.01))
    )
      continue
    const height = base.bounds[3] - base.bounds[1],
      center = (marker) => (marker.bounds[1] + marker.bounds[3]) / 2
    if (
      !parts.every(
        (part) =>
          part.bounds[0] >= base.bounds[2] - height * 0.2 &&
          part.bounds[0] <= base.bounds[2] + height * 0.5 &&
          Math.abs(part.rise) <= height &&
          part.bounds[3] > base.bounds[1]
      ) ||
      center(upper) <= center(base) ||
      (lower &&
        (center(lower) >= center(base) ||
          Math.abs(upper.bounds[0] - lower.bounds[0]) > height * 0.25))
    )
      continue
    groups.push({
      sourceOffset: start,
      targetOffset: to[from.indexOf(token)].index + 2,
      label: token[2],
      sourceIndices: parts.flatMap((part) => part.sourceIndices),
      baselineIndex: base.sourceIndices[0],
      scriptOnly: true
    })
  }
  // Mathematical alphabets use surrogate pairs. Keep their original UTF-16
  // offsets, and match only complete two-letter identifiers. The bundled font
  // may fold the requested output to ASCII, but the native group keeps both
  // original glyphs and their relative script geometry.
  const identifier =
      /(?<![A-Za-z\p{Script=Greek}\d_\u{1d400}-\u{1d7ff}])(?:[\u{1d400}-\u{1d7cb}]{2}|[A-Za-z]{2})(?![A-Za-z\p{Script=Greek}\d_\u{1d400}-\u{1d7ff}])/gu,
    originals = [...source.matchAll(identifier)],
    targets = [...translation.matchAll(identifier)],
    mathematical = (text) => /^[\u{1d400}-\u{1d7cb}]{2}$/u.test(text) && /^\p{L}{2}$/u.test(text)
  for (const match of originals) {
    if (!mathematical(match[0])) continue
    const [letter, suffix] = [...match[0]],
      base = markers.find(
        (marker) => marker.sourceOffset === match.index && marker.label === letter
      ),
      script = markers.find(
        (marker) => marker.sourceOffset === match.index + letter.length && marker.label === suffix
      )
    if (
      !base ||
      !script ||
      ![base.scale, base.rise, script.scale, script.rise].every(Number.isFinite) ||
      markers.filter(
        (marker) =>
          marker.sourceOffset >= match.index && marker.sourceOffset < match.index + match[0].length
      ).length !== 2 ||
      base.scale < 0.9 ||
      Math.abs(base.rise) >= 0.01 ||
      script.scale < 0.5 ||
      script.scale >= 0.85 ||
      script.rise >= -0.01 ||
      base.sourceIndices.length !== 1 ||
      script.sourceIndices.length !== 1 ||
      base.sourceIndices[0] + 1 !== script.sourceIndices[0] ||
      ![base, script].every(
        (marker) =>
          Number.isInteger(marker.sourceIndices[0]) &&
          marker.sourceIndices[0] >= 0 &&
          marker.bounds?.length === 4 &&
          marker.bounds.every(Number.isFinite) &&
          marker.bounds[0] < marker.bounds[2] &&
          marker.bounds[1] < marker.bounds[3]
      )
    )
      continue
    const height = base.bounds[3] - base.bounds[1],
      gap = script.bounds[0] - base.bounds[2]
    if (
      height <= 0 ||
      script.rise < -height * 0.5 ||
      script.bounds[3] <= base.bounds[1] ||
      gap < -height * 0.1 ||
      gap > height * 0.5 ||
      script.bounds[1] >= base.bounds[1] ||
      script.bounds[3] > base.bounds[3]
    )
      continue
    const folded = match[0].normalize('NFKC'),
      from = originals.filter((other) => other[0] === match[0]),
      // Never borrow an ASCII identifier or another mathematical font's
      // occurrence when output normalization makes their spellings identical.
      ambiguous = originals.some(
        (other) => other[0] !== match[0] && other[0].normalize('NFKC') === folded
      ),
      to = targets.filter(
        (other) =>
          other[0] === match[0] ||
          (!ambiguous && /^[A-Za-z]{2}$/u.test(folded) && other[0] === folded)
      )
    if (from.length !== to.length) continue
    const target = to[from.findIndex((other) => other.index === match.index)]
    groups.push({
      sourceOffset: match.index,
      targetOffset: target.index,
      label: target[0],
      sourceIndices: [...base.sourceIndices, ...script.sourceIndices],
      baselineIndex: base.sourceIndices[0]
    })
  }
  // A signed index is a native lowered glyph, not an arithmetic operator.
  // Admit only the complete two-run token, retaining the sign's original font.
  const signedPattern =
      /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'+−\u{1d400}-\u{1d7ff}])[A-Za-z\p{Script=Greek}][+−](?![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'+−\u{1d400}-\u{1d7ff}])/gu,
    signedSources = [...source.matchAll(signedPattern)],
    signedTargets = [...translation.matchAll(signedPattern)]
  for (const match of signedSources) {
    const label = match[0],
      from = signedSources.filter((token) => token[0] === label),
      to = signedTargets.filter((token) => token[0] === label),
      parts = markers
        .filter(
          (part) =>
            part.sourceOffset >= match.index && part.sourceOffset < match.index + label.length
        )
        .sort((a, b) => a.sourceOffset - b.sourceOffset),
      [base, script] = parts
    if (
      from.length !== to.length ||
      parts.length !== 2 ||
      base.sourceOffset !== match.index ||
      script.sourceOffset !== match.index + 1 ||
      base.label !== label[0] ||
      script.label !== label[1] ||
      !parts.every(
        (part, index) =>
          Number.isFinite(part.scale) &&
          Number.isFinite(part.rise) &&
          part.sourceIndices.length === 1 &&
          Number.isInteger(part.sourceIndices[0]) &&
          part.sourceIndices[0] >= 0 &&
          (!index || part.sourceIndices[0] === base.sourceIndices[0] + 1) &&
          part.bounds?.length === 4 &&
          part.bounds.every(Number.isFinite) &&
          part.bounds[0] < part.bounds[2] &&
          part.bounds[1] < part.bounds[3]
      ) ||
      base.scale < 0.9 ||
      base.scale > 1.1 ||
      Math.abs(base.rise) > 0.01 ||
      script.scale < base.scale * 0.5 ||
      script.scale >= base.scale * 0.85
    )
      continue
    const height = base.bounds[3] - base.bounds[1],
      width = base.bounds[2] - base.bounds[0],
      drop = base.rise - script.rise
    if (
      drop < height * 0.1 ||
      drop > height * 0.6 ||
      script.bounds[0] <= base.bounds[0] ||
      script.bounds[0] < base.bounds[2] - width * 0.25 ||
      script.bounds[0] > base.bounds[2] + width * 0.5 ||
      script.bounds[3] <= base.bounds[1]
    )
      continue
    groups.push({
      sourceOffset: match.index,
      targetOffset: to[from.indexOf(match)].index,
      label,
      sourceIndices: parts.flatMap((part) => part.sourceIndices),
      baselineIndex: base.sourceIndices[0]
    })
  }
  // A three-object cascading subscript is an indivisible native token.
  // Its two script levels move with the base, never through generated spans.
  const loweredPattern =
      /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'<>≤≥\u{1d400}-\u{1d7ff}])[A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d][<>≤≥]?[A-Za-z\p{Script=Greek}\d](?![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'<>≤≥\u{1d400}-\u{1d7ff}])/gu,
    loweredSources = [...source.matchAll(loweredPattern)],
    loweredTargets = [...translation.matchAll(loweredPattern)]
  for (const match of loweredSources) {
    const label = match[0],
      from = loweredSources.filter((token) => token[0] === label),
      to = loweredTargets.filter((token) => token[0] === label),
      parts = markers
        .filter(
          (part) =>
            part.sourceOffset >= match.index && part.sourceOffset < match.index + label.length
        )
        .sort((a, b) => a.sourceOffset - b.sourceOffset),
      [base, lower, inner] = parts
    if (
      from.length !== to.length ||
      parts.length !== 3 ||
      !/^[A-Za-z\p{Script=Greek}]$/u.test(base.label) ||
      !/^[A-Za-z\p{Script=Greek}\d]$/u.test(lower.label) ||
      !/^[<>≤≥]?[A-Za-z\p{Script=Greek}\d]$/u.test(inner.label) ||
      base.sourceOffset !== match.index ||
      lower.sourceOffset !== base.sourceOffset + base.label.length ||
      inner.sourceOffset !== lower.sourceOffset + lower.label.length ||
      parts.map((part) => part.label).join('') !== label ||
      !parts.every(
        (part, index) =>
          Number.isFinite(part.scale) &&
          Number.isFinite(part.rise) &&
          part.sourceIndices.length === 1 &&
          Number.isInteger(part.sourceIndices[0]) &&
          part.sourceIndices[0] >= 0 &&
          (!index || part.sourceIndices[0] === parts[index - 1].sourceIndices[0] + 1) &&
          part.bounds?.length === 4 &&
          part.bounds.every(Number.isFinite) &&
          part.bounds[0] < part.bounds[2] &&
          part.bounds[1] < part.bounds[3]
      ) ||
      base.scale < 0.9 ||
      base.scale > 1.1 ||
      Math.abs(base.rise) > 0.01 ||
      ![1, 2].every((index) => {
        const previous = parts[index - 1],
          current = parts[index],
          width = previous.bounds[2] - previous.bounds[0],
          height = previous.bounds[3] - previous.bounds[1],
          drop = previous.rise - current.rise
        return (
          current.scale >= previous.scale * 0.5 &&
          current.scale < previous.scale * 0.85 &&
          drop >= height * 0.1 &&
          drop <= height * 0.6 &&
          current.bounds[0] > previous.bounds[0] &&
          current.bounds[0] >= previous.bounds[2] - width * 0.25 &&
          current.bounds[0] <= previous.bounds[2] + width * 0.5 &&
          current.bounds[3] > previous.bounds[1]
        )
      })
    )
      continue
    groups.push({
      sourceOffset: match.index,
      targetOffset: to[from.indexOf(match)].index,
      label,
      sourceIndices: parts.flatMap((part) => part.sourceIndices),
      baselineIndex: base.sourceIndices[0]
    })
  }
  for (const match of sourceGroups) {
    const label = match[0],
      end = match.index + label.length,
      from = sourceGroups.filter((other) => other[0] === label),
      to = targetGroups.filter((other) => other[0] === label)
    if (from.length !== to.length) continue
    const parts = markers
      .filter((marker) => marker.sourceOffset >= match.index && marker.sourceOffset < end)
      .sort((a, b) => a.sourceOffset - b.sourceOffset)
    let offset = match.index
    if (
      !parts.length ||
      !parts.every((part) => {
        if (
          part.sourceOffset !== offset ||
          source.slice(offset, offset + part.label.length) !== part.label
        )
          return false
        offset += part.label.length
        return offset <= end
      }) ||
      offset !== end
    )
      continue
    if (/^[A-Za-z\p{Script=Greek}\d]+⊥?$/u.test(label)) {
      // A native body with aligned upper/lower runs is one mathematical token.
      // Moving the three original objects together preserves long precision
      // labels (FP32) or a lowered perpendicular, as well as their shared
      // horizontal attachment point. A flat symbol is never sufficient proof.
      if (parts.length === 3) {
        const base = parts[0],
          upper = parts.slice(1).find((part) => part.rise > 0.1),
          lower = parts.slice(1).find((part) => part.rise < -0.1),
          boundary = /[\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'⊥\u{1d400}-\u{1d7ff}]/u,
          complete = (text, token) =>
            !boundary.test([...text.slice(0, token.index)].at(-1) ?? '') &&
            !boundary.test([...text.slice(token.index + token[0].length)][0] ?? '')
        if (
          !upper ||
          !lower ||
          !/^[A-Za-z\p{Script=Greek}]$/u.test(base.label) ||
          !/^[A-Za-z\p{Script=Greek}\d]{1,4}$/u.test(upper.label) ||
          !/^(?:[A-Za-z\p{Script=Greek}\d]{1,4}|⊥)$/u.test(lower.label) ||
          !(base.scale >= 0.9 && base.scale <= 1.1 && Math.abs(base.rise) <= 0.01) ||
          ![upper, lower].every((part) => part.scale >= 0.5 && part.scale < 0.85) ||
          Math.abs(upper.scale - lower.scale) >= 0.01 ||
          !from.every((token) => complete(source, token)) ||
          !to.every((token) => complete(translation, token)) ||
          !parts.every(
            (part, index) =>
              part.sourceIndices.length === 1 &&
              Number.isInteger(part.sourceIndices[0]) &&
              part.sourceIndices[0] >= 0 &&
              (!index || part.sourceIndices[0] === parts[index - 1].sourceIndices[0] + 1) &&
              Number.isFinite(part.scale) &&
              Number.isFinite(part.rise) &&
              part.bounds?.length === 4 &&
              part.bounds.every(Number.isFinite) &&
              part.bounds[0] < part.bounds[2] &&
              part.bounds[1] < part.bounds[3]
          )
        )
          continue
        const width = base.bounds[2] - base.bounds[0],
          height = base.bounds[3] - base.bounds[1],
          centerY = (part) => (part.bounds[1] + part.bounds[3]) / 2
        if (
          ![upper, lower].every(
            (part) =>
              part.bounds[0] >= base.bounds[2] - width * 0.25 &&
              part.bounds[0] <= base.bounds[2] + width * 0.5 &&
              Math.abs(part.rise) <= height
          ) ||
          Math.abs(upper.bounds[0] - lower.bounds[0]) > width * 0.25 ||
          centerY(upper) <= centerY(base) ||
          centerY(lower) >= centerY(base) ||
          upper.bounds[1] > base.bounds[3] + height * 0.5 ||
          lower.bounds[3] < base.bounds[1]
        )
          continue
        groups.push({
          sourceOffset: match.index,
          targetOffset: to[from.indexOf(match)].index,
          label,
          sourceIndices: parts.flatMap((part) => part.sourceIndices),
          baselineIndex: base.sourceIndices[0]
        })
        continue
      }
      const base = parts[0],
        upper = parts.find((part) => part.scale >= 0.5 && part.scale < 0.85 && part.rise > 0.1),
        lower = parts.find((part) => part.scale >= 0.5 && part.scale < 0.85 && part.rise < -0.1),
        inner = upper && parts[parts.indexOf(upper) + 1]
      if (
        parts.length !== 4 ||
        !upper ||
        !lower ||
        !inner ||
        !/^[A-Za-z\p{Script=Greek}]$/u.test(base.label) ||
        !/^[A-Za-z\p{Script=Greek}]$/u.test(upper.label) ||
        ![lower, inner].every((part) => /^[A-Za-z\p{Script=Greek}\d]{1,3}$/u.test(part.label)) ||
        !(base.scale >= 0.9 && base.scale <= 1.1 && Math.abs(base.rise) <= 0.01) ||
        Math.abs(upper.scale - lower.scale) >= 0.01 ||
        !(inner.scale >= 0.3 && inner.scale < upper.scale * 0.85) ||
        !(inner.rise > 0.1 && inner.rise < upper.rise - 0.1) ||
        upper.sourceOffset + upper.label.length !== inner.sourceOffset ||
        !parts.every(
          (part) =>
            part.sourceIndices.length === 1 &&
            Number.isInteger(part.sourceIndices[0]) &&
            part.sourceIndices[0] >= 0 &&
            Number.isFinite(part.scale) &&
            Number.isFinite(part.rise) &&
            part.bounds?.length === 4 &&
            part.bounds.every(Number.isFinite) &&
            part.bounds[0] < part.bounds[2] &&
            part.bounds[1] < part.bounds[3]
        ) ||
        new Set(parts.flatMap((part) => part.sourceIndices)).size !== 4
      )
        continue
      const centerY = (part) => (part.bounds[1] + part.bounds[3]) / 2,
        follows = (parent, child) => {
          const [left, , right] = parent.bounds,
            width = right - left
          return child.bounds[0] >= left + width / 2 && child.bounds[0] <= right + width / 2
        }
      // Both outer indices attach at the body's right edge; the smaller inner
      // index attaches to the raised parameter, between its and the body line.
      // Baselines alone cannot distinguish this stack from neighboring glyphs.
      if (
        !follows(base, upper) ||
        !follows(base, lower) ||
        !follows(upper, inner) ||
        !(centerY(upper) > centerY(inner) && centerY(inner) > centerY(base)) ||
        !(centerY(lower) < centerY(base))
      )
        continue
      groups.push({
        sourceOffset: match.index,
        targetOffset: to[from.indexOf(match)].index,
        label,
        sourceIndices: parts.flatMap((part) => part.sourceIndices)
      })
      continue
    }
    if (label.startsWith('∂')) {
      const slash = parts.findIndex((part) => part.label === '/'),
        numerator = parts.slice(0, slash),
        denominator = parts.slice(slash + 1),
        baseline = parts[slash]
      if (
        slash <= 0 ||
        !denominator.length ||
        baseline.scale < 0.9 ||
        baseline.scale > 1.1 ||
        Math.abs(baseline.rise) > 0.01 ||
        !numerator.every(
          (part) =>
            part.scale >= 0.5 &&
            part.scale < 0.85 &&
            part.rise > 0.1 &&
            sameStyle(part, numerator[0])
        ) ||
        !denominator.every(
          (part) =>
            part.scale >= 0.3 && part.scale <= numerator[0].scale + 0.01 && part.rise <= 0.01
        ) ||
        Math.abs(denominator[0].rise) > 0.01
      )
        continue
      groups.push({
        sourceOffset: match.index,
        targetOffset: to[from.indexOf(match)].index,
        label,
        sourceIndices: parts.flatMap((part) => part.sourceIndices),
        baselineIndex: baseline.sourceIndices[0]
      })
      continue
    }
    const base = parts[0],
      lowered = parts.filter((part) => /^[,\p{Script=Greek}]+$/u.test(part.label)),
      raised = parts.slice(1).filter((part) => !lowered.includes(part))
    if (
      !/^[A-Z]{1,4}$/u.test(base.label) ||
      !(base.scale >= 0.9 && base.scale <= 1.1) ||
      !(Math.abs(base.rise) <= 0.01) ||
      lowered.length < 2 ||
      !raised.length ||
      !lowered.every(
        (part) =>
          part.scale >= 0.5 && part.scale < 0.85 && part.rise < -0.1 && sameStyle(part, lowered[0])
      ) ||
      !raised.every(
        (part) =>
          part.scale >= 0.3 &&
          part.scale < lowered[0].scale * 0.85 &&
          part.rise > lowered[0].rise + 0.1 &&
          sameStyle(part, raised[0])
      )
    )
      continue
    groups.push({
      sourceOffset: match.index,
      targetOffset: to[from.indexOf(match)].index,
      label,
      sourceIndices: parts.flatMap((part) => part.sourceIndices)
    })
  }
  return groups
}

// These markers come from verified PDF objects, not from guesses about translated prose.
// Equal occurrence counts allow each proven occurrence to retain its own styling.
// Extra target occurrences need consistent evidence for every source occurrence.
export const resolveScientificScriptSpans = (source, translation, markers) => {
  const sourceTokens = identifiers(source),
    targetTokens = identifiers(translation),
    groups = new Map(),
    runs = []
  for (const marker of [...markers].sort((a, b) => a.sourceOffset - b.sourceOffset)) {
    if (
      !Number.isInteger(marker.sourceOffset) ||
      marker.sourceOffset < 0 ||
      !Number.isFinite(marker.scale) ||
      marker.scale <= 0 ||
      marker.scale >= 0.9 ||
      !Number.isFinite(marker.rise) ||
      Math.abs(marker.rise) < 0.01 ||
      (!/^[A-Za-z\p{Script=Greek}\d′∈<>≤≥×−+()[\],=.-]+[,.;:]*$/u.test(marker.label) &&
        !(marker.rise < 0 && /^[a-z] [a-z]$/u.test(marker.label))) ||
      source.slice(marker.sourceOffset, marker.sourceOffset + marker.label.length) !== marker.label
    )
      continue
    const label = marker.label,
      previous = runs.at(-1)
    if (
      previous &&
      previous.sourceOffset + previous.label.length === marker.sourceOffset &&
      sameStyle(previous, marker)
    ) {
      previous.label += label
      previous.sourceIndices.push(...marker.sourceIndices)
      previous.sourceOffsets.push(marker.sourceOffset)
    } else {
      runs.push({
        ...marker,
        label,
        sourceIndices: [...marker.sourceIndices],
        sourceOffsets: [marker.sourceOffset]
      })
    }
  }
  for (const run of runs) run.label = run.label.replace(/[,.;:]+$/u, '')
  for (const run of runs) {
    const token = sourceTokens.find(
      (match) =>
        (match.index < run.sourceOffset ||
          (match.index === run.sourceOffset &&
            run.rise > 0 &&
            /^\([A-Za-z\p{Script=Greek}]{1,3}\)$/u.test(run.label))) &&
        (match.index + match[0].length === run.sourceOffset + run.label.length ||
          ((/^′{1,3}$/u.test(run.label) ||
            (run.rise < 0 && /^[\p{Script=Greek}]+(?:,[\p{Script=Greek}]+)+$/u.test(run.label))) &&
            /^\([A-Za-z\p{Script=Greek}\d−+-]+\)$/u.test(
              match[0].slice(run.sourceOffset + run.label.length - match.index)
            )) ||
          (run.rise > 0 &&
            /^\}[A-Z][a-z]=\d{1,3}$/u.test(match[0]) &&
            run.sourceOffset === match.index + 1 &&
            /^[A-Z]$/u.test(run.label)) ||
          (run.rise > 0 &&
            /^[a-z]{1,3}$/u.test(run.label) &&
            /^[A-Z]$/u.test(match[0].slice(0, run.sourceOffset - match.index)) &&
            runs.some(
              (other) =>
                other.rise < 0 &&
                /^[A-Z]{1,3}$/u.test(other.label) &&
                other.sourceOffset === run.sourceOffset + run.label.length &&
                other.sourceOffset + other.label.length === match.index + match[0].length
            )) ||
          (/^\([A-Za-z\p{Script=Greek}\d−+-]+\)$/u.test(run.label) &&
            /^[A-Za-z]$/u.test(match[0].slice(run.sourceOffset + run.label.length - match.index)) &&
            runs.some(
              (other) =>
                other.sourceOffset === run.sourceOffset + run.label.length &&
                other.sourceOffset + other.label.length === match.index + match[0].length
            )))
    )
    if (
      !token ||
      runs.some(
        (other) =>
          other !== run &&
          other.sourceOffset < run.sourceOffset + run.label.length &&
          other.sourceOffset + other.label.length > run.sourceOffset
      )
    )
      continue
    const prefixLength = run.sourceOffset - token.index,
      prefix = token[0].slice(0, prefixLength).trimEnd(),
      collectionLimits =
        /^\}[A-Z][a-z]=\d{1,3}$/u.test(token[0]) &&
        markers.some(
          (marker) =>
            marker.scale >= 0.9 &&
            Math.abs(marker.rise) < 0.01 &&
            marker.label.endsWith('}') &&
            marker.sourceOffset + marker.label.length === token.index + 1
        ) &&
        runs.some(
          (other) =>
            other.rise > 0 && other.label === token[0][1] && other.sourceOffset === token.index + 1
        ) &&
        runs.some(
          (other) =>
            other.rise < 0 &&
            other.label === token[0].slice(2) &&
            other.sourceOffset === token.index + 2
        ),
      standaloneIndex =
        prefixLength === 0 && /^\([A-Za-z\p{Script=Greek}]{1,3}\)$/u.test(run.label),
      indicatorPredicate =
        run.rise < 0 &&
        ((/^[A-Za-z\p{Script=Greek}]1$/u.test(prefix) &&
          /^[A-Za-z\p{Script=Greek}][<>≤≥]\d+$/u.test(run.label)) ||
          (/^[A-Z]$/u.test(prefix) && /^1\[[a-z\p{Script=Greek}][<>≤≥]\d+\]$/u.test(run.label))) &&
        markers.some(
          (marker) =>
            marker.scale >= 0.9 &&
            Math.abs(marker.rise) < 0.01 &&
            marker.sourceOffset + marker.label.length === run.sourceOffset &&
            marker.label.endsWith(prefix) &&
            source.slice(marker.sourceOffset, run.sourceOffset) === marker.label
        ),
      expectationTranspose =
        run.label === 'T' &&
        run.rise > 0 &&
        /^(?:E\[[A-Za-z\p{Script=Greek}]\]){1,2}$/u.test(prefix),
      pairedLevel =
        run.rise < 0 &&
        /^[A-Z]{1,3}$/u.test(run.label) &&
        /^[A-Z][a-z]{1,3}$/u.test(prefix) &&
        runs.some(
          (other) =>
            other.rise > 0 &&
            other.sourceOffset === token.index + 1 &&
            other.label === prefix.slice(1) &&
            other.sourceOffset + other.label.length === run.sourceOffset
        )
    if (
      !standaloneIndex &&
      !collectionLimits &&
      !indicatorPredicate &&
      !expectationTranspose &&
      !/^[A-Za-z\p{Script=Greek}]+(?:ˆ|\u0302)?(?:\([A-Za-z\p{Script=Greek}\d−+-]+\))?$/u.test(
        prefix
      )
    )
      continue
    if (/[<>≤≥]/u.test(run.label) && !indicatorPredicate) continue
    // Superscript citations after ordinary words must never become identifiers.
    // Longer named variables require both a lowered suffix and its native body prefix.
    if (
      !standaloneIndex &&
      !collectionLimits &&
      !indicatorPredicate &&
      !expectationTranspose &&
      !pairedLevel &&
      !/^(?:[A-Z]{1,4}|[a-z]|\p{Script=Greek}{1,4})(?:ˆ|\u0302)?(?:\([A-Za-z\p{Script=Greek}\d−+-]+\))?$/u.test(
        prefix
      ) &&
      !(
        (run.rise < 0 || (run.label === 'T' && run.rise > 0 && /^([a-z])\1$/u.test(prefix))) &&
        markers.some(
          (marker) =>
            marker.scale >= 0.9 &&
            Math.abs(marker.rise) < 0.01 &&
            marker.sourceOffset <= token.index &&
            marker.sourceOffset + marker.label.length === run.sourceOffset &&
            source.slice(marker.sourceOffset, run.sourceOffset) === marker.label &&
            marker.label.endsWith(prefix)
        )
      )
    )
      continue
    const group = `${token[0]}:${prefixLength}:${run.label.length}`,
      entries = groups.get(group) ?? []
    entries.push({ ...run, prefixLength, identifier: token[0] })
    groups.set(group, entries)
  }
  const spans = []
  for (const entries of groups.values()) {
    const identifier = entries[0].identifier,
      sourceMatches = sourceTokens.filter((match) => match[0] === identifier),
      targetMatches = targetTokens.filter((match) => match[0] === identifier),
      first = entries[0],
      prefixLength = first.prefixLength
    if (
      entries.some((entry) => entry.prefixLength !== prefixLength || !sameStyle(entry, first)) ||
      entries.some(
        (entry) => entries.filter((other) => other.sourceOffset === entry.sourceOffset).length !== 1
      )
    )
      continue
    const add = (token, evidence) =>
      spans.push({
        start: token.index + prefixLength,
        end: token.index + prefixLength + first.label.length,
        scale: first.scale,
        rise: first.rise,
        sourceIndices: [...new Set(evidence.flatMap((entry) => entry.sourceIndices))],
        sourceOffsets: evidence.flatMap((entry) => entry.sourceOffsets)
      })
    if (sourceMatches.length === targetMatches.length) {
      // A caller may be proving one native region of a multi-region paragraph.
      // Do not borrow sibling-region evidence or attach its objects to this region.
      for (const entry of entries) {
        const position = sourceMatches.findIndex(
          (match) => match.index + prefixLength === entry.sourceOffset
        )
        if (position >= 0) add(targetMatches[position], [entry])
      }
    } else if (
      sourceMatches.length === entries.length &&
      sourceMatches.every((match) =>
        entries.some((entry) => entry.sourceOffset === match.index + prefixLength)
      )
    ) {
      for (const token of targetMatches) add(token, entries)
    }
  }
  // Native upper and lower indices can be serialized in either order. Keep
  // their distinct styles only when the body base and both levels are proven,
  // and the target contains exactly the same two index values.
  for (const token of sourceTokens) {
    const base = token[0][0],
      first = runs.find((run) => run.sourceOffset === token.index + 1),
      second =
        first && runs.find((run) => run.sourceOffset === first.sourceOffset + first.label.length)
    if (
      !first ||
      !second ||
      first.rise * second.rise >= 0 ||
      first.label === second.label ||
      !/^[A-Za-z\p{Script=Greek}]$/u.test(base) ||
      ![first, second].every((run) => /^[A-Za-z\p{Script=Greek}\d]{1,3}$/u.test(run.label)) ||
      token[0] !== base + first.label + second.label ||
      !markers.some(
        (marker) =>
          marker.scale >= 0.9 &&
          Math.abs(marker.rise) < 0.01 &&
          marker.sourceOffset <= token.index &&
          marker.sourceOffset + marker.label.length === token.index + 1 &&
          source.slice(marker.sourceOffset, token.index + 1) === marker.label
      )
    )
      continue
    const spelling = (run) =>
      run.rise > 0 && /^\d+$/u.test(run.label)
        ? `(?:${run.label}|${[...run.label].map((digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]).join('')})`
        : run.label
    const targets = [
        [first, second],
        [second, first]
      ]
        .flatMap((order) =>
          [
            ...translation.matchAll(
              new RegExp(
                `(?<![A-Za-z\\p{Script=Greek}\\p{N}])${base}(${spelling(order[0])})(${spelling(order[1])})(?![A-Za-z\\p{Script=Greek}\\p{N}])`,
                'gu'
              )
            )
          ].map((match) => ({ match, order }))
        )
        .sort((a, b) => a.match.index - b.match.index),
      from = sourceTokens.filter((candidate) => candidate[0] === token[0])
    if (
      from.length !== targets.length ||
      targets.some(
        (target, index) => index && target.match.index === targets[index - 1].match.index
      )
    )
      continue
    const target = targets[from.indexOf(token)]
    let offset = target.match.index + 1
    for (let i = 0; i < 2; i++) {
      const run = target.order[i],
        label = target.match[i + 1]
      // Unicode powers use the writer's existing native-glyph anchor; generating
      // an already raised character at a raised baseline would raise it twice.
      if (
        label === run.label &&
        !spans.some((span) => span.start < offset + label.length && span.end > offset)
      )
        spans.push({
          start: offset,
          end: offset + label.length,
          scale: run.scale,
          rise: run.rise,
          sourceIndices: [...run.sourceIndices],
          sourceOffsets: [...run.sourceOffsets]
        })
      offset += label.length
    }
  }
  // A differential operator owns its lowered index even when the following
  // function is printed without a space (∇θf). Prove the body operator itself;
  // a nearby Greek letter or a changed/repeated target is not sufficient.
  for (const run of runs) {
    if (run.rise >= 0 || !/^[A-Za-z\p{Script=Greek}]$/u.test(run.label)) continue
    const base = markers.find(
      (marker) =>
        /^[∇∂]$/u.test(marker.label) &&
        marker.scale >= 0.9 &&
        Math.abs(marker.rise) < 0.01 &&
        marker.sourceOffset + marker.label.length === run.sourceOffset &&
        source.slice(marker.sourceOffset, run.sourceOffset) === marker.label
    )
    if (!base) continue
    const parts = [run],
      functionBase = markers.find(
        (marker) =>
          marker.sourceOffset === run.sourceOffset + run.label.length &&
          /^[A-Za-z\p{Script=Greek}]$/u.test(marker.label) &&
          marker.scale >= 0.9 &&
          Math.abs(marker.rise) < 0.01 &&
          source[marker.sourceOffset] === marker.label
      ),
      functionIndex =
        functionBase &&
        runs.find(
          (candidate) =>
            candidate.sourceOffset === functionBase.sourceOffset + functionBase.label.length &&
            candidate.rise < 0 &&
            /^[A-Za-z\p{Script=Greek}\d]$/u.test(candidate.label)
        )
    if (functionIndex) parts.push(functionIndex)
    const end = parts.at(-1).sourceOffset + parts.at(-1).label.length,
      label = source.slice(base.sourceOffset, end),
      occurrences = (text) => [...text.matchAll(new RegExp(label, 'gu'))],
      from = occurrences(source),
      to = occurrences(translation),
      occurrence = from.findIndex((value) => value.index === base.sourceOffset)
    if (occurrence < 0 || from.length !== to.length) continue
    for (const part of parts) {
      const start = to[occurrence].index + part.sourceOffset - base.sourceOffset
      if (spans.some((span) => span.start < start + part.label.length && span.end > start)) continue
      spans.push({
        start,
        end: start + part.label.length,
        scale: part.scale,
        rise: part.rise,
        sourceIndices: [...part.sourceIndices],
        sourceOffsets: [...part.sourceOffsets]
      })
    }
  }

  // A finite indexed set has separate raised/lowered bounds after its closing
  // brace. Keep both styles only when the complete set and both native bounds
  // match, including a body-sized closing brace; ordinary prose is not a set.
  const sets = (text) => [
      ...text.matchAll(
        /\{([A-Za-z\p{Script=Greek}]\u0302?(?:\([a-z\p{Script=Greek}]\))?)\}\s*([A-Z])([a-z]=\d+)/gu
      )
    ],
    identity = (match) => `${match[1]}:${match[2]}:${match[3]}`,
    sourceSets = sets(source),
    targetSets = sets(translation)
  for (const value of sourceSets) {
    const boundsOffset = value.index + value[0].lastIndexOf(value[2] + value[3]),
      braceOffset = value.index + value[0].indexOf('}'),
      upper = runs.find(
        (run) => run.sourceOffset === boundsOffset && run.label === value[2] && run.rise > 0
      ),
      lower = runs.find(
        (run) =>
          run.sourceOffset === boundsOffset + value[2].length &&
          run.label === value[3] &&
          run.rise < 0
      ),
      from = sourceSets.filter((match) => identity(match) === identity(value)),
      to = targetSets.filter((match) => identity(match) === identity(value))
    if (
      !upper ||
      !lower ||
      from.length !== to.length ||
      !markers.some(
        (marker) =>
          marker.sourceOffset === braceOffset &&
          marker.label === '}' &&
          marker.scale >= 0.9 &&
          Math.abs(marker.rise) < 0.01
      )
    )
      continue
    const target = to[from.indexOf(value)],
      start = target.index + target[0].lastIndexOf(target[2] + target[3])
    for (const [run, offset] of [
      [upper, start],
      [lower, start + target[2].length]
    ]) {
      // Unspaced bounds can already match the generic collection identifier.
      // Each target range must have one owner, regardless of which proof found it.
      if (spans.some((span) => span.start < offset + run.label.length && span.end > offset))
        continue
      spans.push({
        start: offset,
        end: offset + run.label.length,
        scale: run.scale,
        rise: run.rise,
        sourceIndices: [...new Set(run.sourceIndices)],
        sourceOffsets: [...run.sourceOffsets]
      })
    }
  }

  // A finite numeric alphabet can have a raised matrix dimension, {0, 1}N×D.
  // Prove the whole set and dimension, then its complete native attachment to
  // a body-sized closing brace. A nearby raised word is not this exponent.
  const matrixSets = (text) => [
      ...text.matchAll(
        /\{(?:\d{1,3}\s*,\s*){1,3}\d{1,3}\}\s*([A-Z](?:×[A-Z]){1,3})(?![A-Za-z\d×])/gu
      )
    ],
    matrixIdentity = (match) => match[0].replace(/\s/gu, ''),
    fromMatrices = matrixSets(source),
    toMatrices = matrixSets(translation)
  for (const value of fromMatrices) {
    const offset = value.index + value[0].lastIndexOf(value[1]),
      end = offset + value[1].length,
      braces = markers.filter(
        (marker) =>
          marker.sourceOffset === value.index + value[0].indexOf('}') && marker.label === '}'
      ),
      brace = braces.length === 1 ? braces[0] : undefined,
      run = runs.find(
        (candidate) => candidate.sourceOffset === offset && candidate.label === value[1]
      ),
      parts = markers
        .filter((marker) => marker.sourceOffset >= offset && marker.sourceOffset < end)
        .sort((a, b) => a.sourceOffset - b.sourceOffset),
      from = fromMatrices.filter((other) => matrixIdentity(other) === matrixIdentity(value)),
      to = toMatrices.filter((other) => matrixIdentity(other) === matrixIdentity(value))
    if (
      !brace ||
      !run ||
      !parts.length ||
      from.length !== to.length ||
      !(brace.scale >= 0.9 && brace.scale <= 1.1 && Math.abs(brace.rise) < 0.01) ||
      !(run.scale >= 0.5 && run.scale < 0.85 && run.rise > 0.1) ||
      ![brace, ...parts].every(
        (part) =>
          part.sourceIndices.length === 1 &&
          Number.isInteger(part.sourceIndices[0]) &&
          part.sourceIndices[0] >= 0 &&
          Number.isFinite(part.scale) &&
          Number.isFinite(part.rise) &&
          part.bounds?.length === 4 &&
          part.bounds.every(Number.isFinite) &&
          part.bounds[0] < part.bounds[2] &&
          part.bounds[1] < part.bounds[3]
      ) ||
      new Set([brace, ...parts].flatMap((part) => part.sourceIndices)).size !== parts.length + 1
    )
      continue
    let cursor = offset,
      previous = brace.bounds
    const height = brace.bounds[3] - brace.bounds[1]
    if (
      !parts.every((part) => {
        if (
          part.sourceOffset !== cursor ||
          source.slice(cursor, cursor + part.label.length) !== part.label ||
          !sameStyle(part, run) ||
          part.bounds[0] < previous[2] - 0.01 ||
          part.bounds[0] - previous[2] > height * 0.25 ||
          part.bounds[1] + part.bounds[3] <= brace.bounds[1] + brace.bounds[3]
        )
          return false
        cursor += part.label.length
        previous = part.bounds
        return cursor <= end
      }) ||
      cursor !== end ||
      Math.max(...parts.map((part) => part.bounds[3])) <= brace.bounds[3]
    )
      continue
    const target = to[from.indexOf(value)],
      start = target.index + target[0].lastIndexOf(target[1])
    if (spans.some((span) => span.start < start + run.label.length && span.end > start)) continue
    spans.push({
      start,
      end: start + run.label.length,
      scale: run.scale,
      rise: run.rise,
      sourceIndices: [...run.sourceIndices],
      sourceOffsets: [...run.sourceOffsets]
    })
  }
  return spans.sort((a, b) => a.start - b.start)
}

// A model may spell a proven native matrix transpose explicitly as J^T. Keep
// that literal caret notation instead of flattening the raised source T into JT.
export const resolveExplicitTransposeIndices = (source, translation, markers) => {
  const sourceTokens = identifiers(source),
    targetTokens = [
      ...translation.matchAll(
        /(?<![A-Za-z\p{Script=Greek}\d])J{1,2}\^T(?![A-Za-z\p{Script=Greek}\d])/gu
      )
    ],
    result = []
  for (const identifier of ['JT', 'JJT']) {
    const from = sourceTokens.filter((token) => token[0] === identifier),
      to = targetTokens.filter((token) => token[0] === identifier.slice(0, -1) + '^T'),
      evidence = markers.filter(
        (marker) =>
          marker.scale > 0 &&
          marker.scale < 0.9 &&
          marker.rise > 0 &&
          /^T[,.;:]*$/u.test(marker.label) &&
          source.slice(marker.sourceOffset, marker.sourceOffset + marker.label.length) ===
            marker.label &&
          from.some((token) => token.index + identifier.length - 1 === marker.sourceOffset)
      )
    if (
      !from.length ||
      from.length !== to.length ||
      evidence.length !== from.length ||
      !from.every(
        (token) =>
          evidence.filter((marker) => marker.sourceOffset === token.index + identifier.length - 1)
            .length === 1
      )
    )
      continue
    result.push(...evidence.flatMap((marker) => marker.sourceIndices))
  }
  return [...new Set(result)]
}

// Complete negative powers can retain their native group or use explicit caret
// notation only after geometry proves every sign/digit and its decimal base.
export const resolveExplicitPowerIndices = (source, translation, markers, bodySize) => {
  const powers = (text) => [
      ...text.matchAll(
        /(?<![A-Za-z\p{Script=Greek}\d])\d{1,4}(⁻[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})(?![A-Za-z\p{Script=Greek}\d⁻⁰¹²³⁴⁵⁶⁷⁸⁹])/gu
      )
    ],
    from = powers(source),
    to = [
      ...translation.matchAll(
        /(?<![A-Za-z\p{Script=Greek}\d])\d{1,4}\^\(-\d{1,2}\)(?![A-Za-z\p{Script=Greek}\d])/gu
      )
    ],
    result = []
  if (!Number.isFinite(bodySize) || bodySize <= 0) return result
  // PDF text flattens powers in complexity terms, e.g. O(abc²) -> O(abc2).
  // Accept explicit caret notation only for the same complete term, backed by
  // a body-sized variable object and its genuinely raised native digits.
  for (const match of source.matchAll(/(?:O|Θ)\(([A-Za-z\p{Script=Greek}]{1,8})(\d{1,2})\)/gu)) {
    const start = match.index + 2 + match[1].length,
      power = markers.find((marker) => marker.sourceOffset === start && marker.label === match[2]),
      base = markers.find(
        (marker) =>
          marker.sourceOffset === match.index + 2 &&
          marker.label === match[1] &&
          marker.scale >= 0.9 &&
          Math.abs(marker.rise) < 0.01
      ),
      target = match[0].slice(0, -match[2].length - 1) + '^' + match[2] + ')'
    if (
      base &&
      power &&
      power.scale > 0 &&
      power.scale < 0.9 &&
      power.rise > bodySize * 0.2 &&
      source.split(match[0]).length === translation.split(target).length
    )
      result.push(...power.sourceIndices)
  }
  for (const power of from) {
    const matching = from.filter((value) => value[0] === power[0])
    const explicit =
      power[0].slice(0, -power[1].length) +
      '^(' +
      power[1].normalize('NFKC').replace('−', '-') +
      ')'
    const unicode = powers(translation).filter((value) => value[0] === power[0])
    if (matching.length !== to.filter((value) => value[0] === explicit).length + unicode.length)
      continue
    const start = power.index + power[0].length - power[1].length,
      end = power.index + power[0].length,
      pieces = markers
        .filter((marker) => marker.sourceOffset >= start && marker.sourceOffset < end)
        .sort((a, b) => a.sourceOffset - b.sourceOffset),
      base = markers.find(
        (marker) =>
          marker.sourceOffset <= power.index &&
          marker.sourceOffset + marker.label.length === start &&
          marker.scale >= 0.9 &&
          Math.abs(marker.rise) < 0.01 &&
          source.slice(marker.sourceOffset, start) === marker.label
      )
    if (!base || !pieces.length) continue
    let cursor = start
    const proven = pieces.every((marker) => {
      const actual = marker.label.replace(/−/gu, '-'),
        expected = source
          .slice(cursor, cursor + marker.label.length)
          .normalize('NFKC')
          .replace(/−/gu, '-')
      if (
        marker.sourceOffset !== cursor ||
        marker.scale <= 0 ||
        marker.scale >= 0.9 ||
        marker.rise <= bodySize * 0.2 ||
        !sameStyle(pieces[0], marker) ||
        !/^-?\d*$/u.test(actual) ||
        !actual ||
        actual !== expected
      )
        return false
      cursor += marker.label.length
      return true
    })
    if (!proven || cursor !== end) continue
    // Retaining the Unicode spelling must also prove physical attachment, not
    // merely a small number somewhere above an otherwise matching decimal base.
    if (unicode.length) {
      const chain = [base, ...pieces]
      if (
        !chain.every(
          (marker) =>
            [marker.scale, marker.rise].every(Number.isFinite) &&
            marker.bounds?.length === 4 &&
            marker.bounds.every(Number.isFinite) &&
            marker.bounds[0] < marker.bounds[2] &&
            marker.bounds[1] < marker.bounds[3] &&
            marker.sourceIndices.length === 1 &&
            Number.isInteger(marker.sourceIndices[0])
        ) ||
        base.scale > 1.1 ||
        !pieces.every((marker, index) => {
          const previous = chain[index],
            gap = marker.bounds[0] - previous.bounds[2]
          return (
            marker.sourceIndices[0] === previous.sourceIndices[0] + 1 &&
            marker.scale >= 0.5 &&
            marker.rise <= bodySize * 0.75 &&
            gap >= -bodySize * 0.2 &&
            gap <= bodySize * 0.3 &&
            (marker.bounds[1] + marker.bounds[3]) / 2 > (base.bounds[1] + base.bounds[3]) / 2 &&
            marker.bounds[1] > base.bounds[1]
          )
        })
      )
        continue
    }
    result.push(...pieces.flatMap((marker) => marker.sourceIndices))
  }
  return [...new Set(result)]
}

// Raised English ordinal suffixes are typography, not mathematical powers.
// Require the correctly spelled ordinal and its actual body-sized numeric base.
export const resolveOrdinalSuffixIndices = (source, markers, bodySize) => {
  const result = []
  for (const match of source.matchAll(
    /(?<![\p{L}\p{N}])(\d{1,6})(st|nd|rd|th)(?![\p{L}\p{N}])/gu
  )) {
    const number = Number(match[1]),
      last = number % 100,
      expected =
        last >= 11 && last <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] ?? 'th'),
      offset = match.index + match[1].length
    if (match[2] !== expected) continue
    const base = markers.find(
        (marker) =>
          marker.scale >= 0.9 &&
          Math.abs(marker.rise) < 0.01 &&
          marker.sourceOffset <= match.index &&
          marker.sourceOffset + marker.label.length === offset &&
          source.slice(marker.sourceOffset, offset) === marker.label
      ),
      suffix = markers.filter(
        (marker) =>
          marker.sourceOffset === offset &&
          marker.label === expected &&
          marker.scale >= 0.5 &&
          marker.scale < 0.9 &&
          marker.rise > bodySize * 0.2
      )
    if (base && suffix.length === 1) result.push(...suffix[0].sourceIndices)
  }
  return [...new Set(result)]
}
