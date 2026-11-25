/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled worker helper. */
const identifiers = (text) => {
  const pattern =
    /(?:max|min)[a-z\p{Script=Greek}]∈\[[A-Za-z\p{Script=Greek}\d]+\]|[A-Z]1\[[a-z\p{Script=Greek}][<>≤≥]\d+\]|(?:E\[[A-Za-z\p{Script=Greek}]\]){1,2}T|[A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]*(?:(?:ˆ|\u0302)\s*[A-Za-z\p{Script=Greek}\d]*)?′{0,3}(?:[-∈<>≤≥×−+:][A-Za-z\p{Script=Greek}\d]+|,[\p{Script=Greek}\d][A-Za-z\p{Script=Greek}\d]*|\.{3}[A-Za-z\p{Script=Greek}\d]+)*(?:\([A-Za-z\p{Script=Greek}\d,−+-]+\)[A-Za-z]?)?/gu
  // TeX can extract the difference operator as U+2206, outside the Greek script.
  const result = [...text.matchAll(pattern), ...text.matchAll(/∆[a-z]{1,3}(?![A-Za-z\d_])/gu)]
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
      /(?<![A-Za-z\p{Script=Greek}\d⊥])(?:[A-Za-z\p{Script=Greek}]′[A-Za-z\p{Script=Greek}\d]{1,4}|[A-Z]{1,4}(?:\p{Script=Greek}\([A-Za-z\d]+\))(?:,\p{Script=Greek}\([A-Za-z\d]+\))+|∂[A-Za-z\p{Script=Greek}ℓ`]\/∂[A-Za-z\p{Script=Greek}][A-Za-z\p{Script=Greek}\d]*(?:[−+-]\d+)?|[A-Za-z\p{Script=Greek}](?:[A-Za-z\p{Script=Greek}\d]{2,7}|[A-Za-z\p{Script=Greek}\d]⊥))(?![A-Za-z\p{Script=Greek}\d⊥])/gu,
    sourceGroups = [...source.matchAll(pattern)],
    targetGroups = [...translation.matchAll(pattern)],
    groups = []
  // Preserve complete native differential parentheses and spaced tensor runs.
  // These families keep original objects, including a shared "= (" run; no
  // source substring or whitespace-normalized identifier grants ownership.
  const boundary = /[\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'\u{1d400}-\u{1d7ff}]/u,
    occurrences = (text, label) => {
      const found = []
      for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + label.length))
        if (
          !boundary.test([...text.slice(0, at)].at(-1) ?? '') &&
          !boundary.test([...text.slice(at + label.length)][0] ?? '')
        )
          found.push(at)
      return found
    },
    nativeParts = (start, end, count, raisedDigits = false) => {
      const parts = markers
        .filter((part) => part.sourceOffset < end && part.sourceOffset + part.label.length > start)
        .sort((a, b) => a.sourceOffset - b.sourceOffset)
      return parts.length === count &&
        parts.every(
          (part, index) =>
            Number.isInteger(part.sourceOffset) &&
            part.sourceOffset >= start &&
            part.sourceOffset + part.label.length <= end &&
            (() => {
              const spelling = source.slice(
                part.sourceOffset,
                part.sourceOffset + part.label.length
              )
              return (
                spelling === part.label ||
                (raisedDigits &&
                  /^(?:⁻|[⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/u.test(spelling) &&
                  spelling.normalize('NFKC') === part.label)
              )
            })() &&
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
        )
        ? parts
        : undefined
    },
    body = (part) => part.scale >= 0.9 && part.scale <= 1.1 && Math.abs(part.rise) < 0.01,
    small = (part) => part.scale >= 0.5 && part.scale < 0.85,
    center = (part) => (part.bounds[1] + part.bounds[3]) / 2,
    pushNativeGroup = (start, end, parts, baseline, targetOffset, needsInlineReflow) => {
      groups.push({
        sourceOffset: start,
        targetOffset,
        label: source.slice(start, end),
        sourceIndices: parts.flatMap((part) => part.sourceIndices),
        baselineIndex: baseline.sourceIndices[0],
        nativeScriptGroup: true,
        ...(needsInlineReflow ? { needsInlineReflow: true } : {})
      })
    },
    addNativeGroup = (start, end, parts, baseline, needsInlineReflow) => {
      const label = source.slice(start, end),
        from = occurrences(source, label),
        to = occurrences(translation, label),
        ordinal = from.indexOf(start)
      if (ordinal < 0 || from.length !== to.length) return
      pushNativeGroup(start, end, parts, baseline, to[ordinal], needsInlineReflow)
    }
  // A numeric uncertainty can share its base with a prose run. Preserve the
  // complete native stack only when both signed values travel with that base.
  const uncertainty =
      /(?<![\p{L}\p{M}\p{N}_.])([0-9]{1,4})(\+[0-9]{1,3})(−)([0-9]{1,3})(?![\p{L}\p{M}\p{N}_.+−])/gu,
    sourceUncertainties = [...source.matchAll(uncertainty)],
    targetUncertainties = [...translation.matchAll(uncertainty)]
  for (const token of sourceUncertainties) {
    const start = token.index + token[1].length,
      end = token.index + token[0].length,
      parts = nativeParts(start, end, 3)
    if (!parts) continue
    const [upper, minus, lower] = parts,
      bases = markers.filter(
        (marker) =>
          marker.sourceOffset <= token.index &&
          marker.sourceOffset + marker.label.length === start &&
          marker.label.endsWith(token[1]) &&
          source.slice(marker.sourceOffset, start) === marker.label
      ),
      base = bases[0]
    if (
      bases.length !== 1 ||
      base.sourceIndices.length !== 1 ||
      base.sourceIndices[0] + 1 !== upper.sourceIndices[0] ||
      base.bounds?.length !== 4 ||
      !base.bounds.every(Number.isFinite) ||
      !body(base) ||
      !/^(?:[A-Z]{6}\+)?CMR10$/u.test(base.fontName) ||
      parts.some((part, i) => part.label !== token[i + 2] || !small(part)) ||
      ![upper, lower].every((part) => /^(?:[A-Z]{6}\+)?CMR7$/u.test(part.fontName)) ||
      !/^(?:[A-Z]{6}\+)?CMSY7$/u.test(minus.fontName) ||
      Math.abs(upper.scale - lower.scale) > 0.01 ||
      !sameStyle(minus, lower)
    )
      continue
    const height = base.bounds[3] - base.bounds[1]
    if (
      !(height > 0) ||
      ![base, ...parts].every(
        (part) =>
          Math.abs(part.baseline - base.baseline - part.rise) < 0.01 &&
          part.bounds[2] > part.bounds[0] &&
          part.bounds[3] > part.bounds[1]
      ) ||
      upper.rise < height * 0.3 ||
      upper.rise > height * 0.65 ||
      lower.rise < -height * 0.5 ||
      lower.rise > -height * 0.15 ||
      upper.bounds[0] < base.bounds[2] ||
      upper.bounds[0] - base.bounds[2] > height * 0.25 ||
      lower.bounds[0] < minus.bounds[2] ||
      lower.bounds[0] - minus.bounds[2] > height * 0.25 ||
      Math.abs(upper.bounds[0] - minus.bounds[0]) > height * 0.15 ||
      Math.abs(upper.bounds[2] - lower.bounds[2]) > height * 0.25 ||
      upper.bounds[1] < lower.bounds[3]
    )
      continue
    const from = sourceUncertainties.filter((match) => match[0] === token[0]),
      to = targetUncertainties.filter((match) => match[0] === token[0])
    if (from.length !== to.length) continue
    pushNativeGroup(start, end, parts, base, to[from.indexOf(token)].index + token[1].length, true)
  }

  // PDF.js can insert spaces around a native symbolic superscript.
  for (const match of source.matchAll(/∼ [A-Z] [a-z](?![\p{L}\p{M}\p{N}_])/gu)) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 3)
    if (!parts) continue
    const [relation, base, exponent] = parts,
      face = /^(?:[A-Z]{6}\+)?CMMI(9|10)$/u.exec(base.fontName)?.[1],
      relationFace = /^(?:[A-Z]{6}\+)?CMSY(9|10)$/u.exec(relation.fontName)?.[1],
      exponentFace = /^(?:[A-Z]{6}\+)?CMMI(6|7)$/u.exec(exponent.fontName)?.[1],
      gap = exponent.bounds[0] - base.bounds[2],
      height = base.bounds[3] - base.bounds[1]
    if (
      !face ||
      relationFace !== face ||
      Number(face) - Number(exponentFace) !== 3 ||
      occurrences(source, match[0]).length !== 1 ||
      !body(relation) ||
      !body(base) ||
      !small(exponent) ||
      [relation, base, exponent].some((part, i) => part.sourceOffset !== start + 2 * i) ||
      Math.abs(relation.baseline - base.baseline) >= 0.01 ||
      Math.abs(exponent.baseline - base.baseline - exponent.rise) >= 0.01 ||
      exponent.rise < height * 0.45 ||
      exponent.rise > height * 0.7 ||
      !(gap >= 0 && gap <= height * 0.2) ||
      center(exponent) <= center(base) ||
      relation.bounds[2] >= base.bounds[0] ||
      base.bounds[0] - relation.bounds[2] > height * 0.7
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // Latin Modern can draw a complete symbolic exponent as three separate objects.
  for (const match of source.matchAll(
    /(?<![\p{L}\p{M}\p{N}_])[2-9][a-z]−[1-9](?![\p{L}\p{M}\p{N}_])/gu
  )) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 4)
    if (!parts) continue
    const [base, variable, minus, constant] = parts,
      height = base.bounds[3] - base.bounds[1],
      faces = [
        /^(?:[A-Z]{6}\+)?LMMathItalic([78])-Regular$/u,
        /^(?:[A-Z]{6}\+)?LMMathSymbols([78])-Regular$/u,
        /^(?:[A-Z]{6}\+)?LMRoman([78])-Regular$/u
      ],
      scriptFace = faces[0].exec(variable.fontName)?.[1]
    if (
      !body(base) ||
      !/^(?:[A-Z]{6}\+)?LMRoman10-Regular$/u.test(base.fontName) ||
      !scriptFace ||
      [variable, minus, constant].some((part, index) => {
        const gap = part.bounds[0] - parts[index].bounds[2]
        return (
          part.sourceOffset !== start + index + 1 ||
          part.label !== match[0][index + 1] ||
          faces[index].exec(part.fontName)?.[1] !== scriptFace ||
          !small(part) ||
          !sameStyle(part, variable) ||
          !(Math.abs(part.baseline - base.baseline - part.rise) <= 0.01) ||
          !(part.rise > height * 0.4 && part.rise < height * 0.65) ||
          center(part) <= center(base) ||
          gap < 0 ||
          gap > height * 0.24
        )
      }) ||
      base.sourceOffset !== start ||
      base.label !== match[0][0]
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // A comparison and its italic variable can share one native object.
  // Keep that whole run with the adjacent, smaller roman index.
  for (const match of source.matchAll(
    /(?<=\d )[<>] [\u{1D434}-\u{1D467}][a-z]{2,3}(?= [<>≤≥] \d)/gu
  )) {
    const start = match.index,
      end = match.index + match[0].length,
      parts = nativeParts(start, end, 2)
    if (!parts) continue
    const [base, index] = parts,
      height = base.bounds[3] - base.bounds[1],
      gap = index.bounds[0] - base.bounds[2],
      drop = base.baseline - index.baseline
    if (
      !/^[<>] [\u{1D434}-\u{1D467}]$/u.test(base.label) ||
      !/^[a-z]{2,3}$/u.test(index.label) ||
      base.sourceOffset !== start ||
      index.sourceOffset !== start + base.label.length ||
      index.sourceOffset + index.label.length !== end ||
      !body(base) ||
      !small(index) ||
      !Number.isFinite(drop) ||
      Math.abs(drop + index.rise) >= 0.01 ||
      drop < height * 0.1 ||
      drop > height * 0.35 ||
      gap < -height * 0.1 ||
      gap > height * 0.25 ||
      index.bounds[3] <= base.bounds[1] ||
      index.bounds[1] >= base.bounds[1] ||
      index.bounds[3] > base.bounds[3]
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // Preserve a raised Computer Modern comparison painted as two script runs.
  for (const match of source.matchAll(/[A-Za-z]≤[a-z]/gu)) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 3)
    if (!parts) continue
    const [base, relation, operand] = parts,
      height = base.bounds[3] - base.bounds[1],
      rise = relation.baseline - base.baseline
    if (
      base.sourceOffset !== start ||
      base.label !== match[0][0] ||
      relation.sourceOffset !== start + 1 ||
      relation.label !== '≤' ||
      operand.sourceOffset !== start + 2 ||
      operand.label !== match[0][2] ||
      !/^(?:[A-Z]{6}\+)?(?:CMMI10|EUFM10)$/u.test(base.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMSY7$/u.test(relation.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMMI7$/u.test(operand.fontName) ||
      !body(base) ||
      !small(relation) ||
      !sameStyle(relation, operand) ||
      !(rise >= height * 0.4 && rise <= height * 0.85) ||
      !(Math.abs(relation.baseline - operand.baseline) < 0.01) ||
      parts.slice(1).some((part, index) => {
        const gap = part.bounds[0] - parts[index].bounds[2]
        return center(part) <= center(base) || gap < 0 || gap > height * 0.28
      })
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // TeX can raise the colon slightly within a definition operator.
  for (const match of source.matchAll(/:=/gu)) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 2)
    if (!parts) continue
    const [colon, equal] = parts,
      height = colon.bounds[3] - colon.bounds[1],
      rise = colon.baseline - equal.baseline,
      gap = equal.bounds[0] - colon.bounds[2]
    if (
      !body(colon) ||
      !body(equal) ||
      colon.fontName !== equal.fontName ||
      !/^(?:[A-Z]{6}\+)?LMRoman10-Regular$/u.test(equal.fontName) ||
      colon.scale !== equal.scale ||
      !(rise > 0.1 && rise <= height * 0.15) ||
      gap < 0 ||
      gap > height * 0.22 ||
      equal.bounds[1] < colon.bounds[1] ||
      equal.bounds[3] > colon.bounds[3]
    )
      continue
    addNativeGroup(start, end, parts, equal, true)
  }
  // A tightly attached quantity symbol can follow a separately painted
  // negative power. Preserve its sign, magnitude and symbol as one group.
  for (const match of source.matchAll(/(?<=[∼≈]\s)10⁻[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}[a-z](?![\p{L}\p{N}_])/gu)) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 4, true)
    if (!parts) continue
    const [base, sign, exponent, symbol] = parts,
      height = base.bounds[3] - base.bounds[1]
    if (
      base.label !== '10' ||
      sign.label !== '−' ||
      !/^\d{1,2}$/u.test(exponent.label) ||
      symbol.label !== match[0].at(-1) ||
      !body(base) ||
      !body(symbol) ||
      !/^(?:[A-Z]{6}\+)?CMR10$/u.test(base.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMSY7$/u.test(sign.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMR7$/u.test(exponent.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMMI10$/u.test(symbol.fontName) ||
      !small(sign) ||
      !sameStyle(sign, exponent) ||
      sign.rise < height * 0.3 ||
      sign.rise > height * 0.7 ||
      ![sign, exponent].every((part) => center(part) > center(base)) ||
      parts.slice(1).some((part, index) => {
        const previous = parts[index]
        const gap = part.bounds[0] - previous.bounds[2]
        return (
          part.sourceOffset !== previous.sourceOffset + previous.label.length ||
          gap < 0 ||
          gap > height * 0.3
        )
      })
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // Opposite TeX indices share the same attachment point. Their flattened
  // spelling can follow an adjacent coefficient; preserve only the three glyphs.
  const opposed =
    /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}_.,])\d{1,3}([A-Z][a-z]{2})(?![\p{Script=Latin}\p{Script=Greek}\p{N}_])/gu
  const opposedSources = [...source.matchAll(opposed)],
    opposedTargets = [...translation.matchAll(opposed)]
  for (const match of opposedSources) {
    const end = match.index + match[0].length,
      start = end - match[1].length,
      parts = nativeParts(start, end, 3)
    if (!parts) continue
    const [base, upper, lower] = parts,
      height = base.bounds[3] - base.bounds[1]
    if (
      !body(base) ||
      !/^(?:[A-Z]{6}\+)?CMMI10$/u.test(base.fontName ?? '') ||
      base.label !== match[1][0] ||
      parts.some((part, i) => part.sourceOffset !== start + i || part.label !== match[1][i]) ||
      ![upper, lower].every(
        (part) =>
          small(part) &&
          /^(?:[A-Z]{6}\+)?CMMI7$/u.test(part.fontName ?? '') &&
          Math.abs(part.baseline - base.baseline - part.rise) <= 0.01 &&
          Math.abs(part.bounds[0] - base.bounds[2]) <= height * 0.2
      ) ||
      Math.abs(upper.scale - lower.scale) >= 0.01 ||
      Math.abs(upper.bounds[0] - lower.bounds[0]) >= height * 0.15 ||
      upper.rise < height * 0.35 ||
      upper.rise > height * 0.7 ||
      lower.rise > -height * 0.2 ||
      lower.rise < -height * 0.5 ||
      center(upper) <= center(base) ||
      center(lower) >= center(base)
    )
      continue
    const from = opposedSources.filter((entry) => entry[0] === match[0]),
      to = opposedTargets.filter((entry) => entry[0] === match[0])
    if (from.length !== to.length) continue
    const target = to[from.indexOf(match)]
    pushNativeGroup(
      start,
      end,
      parts,
      base,
      target.index + target[0].length - match[1].length,
      true
    )
  }

  // A blackboard capital and its native italic script are one identifier.
  const blackboardIndices = new Map()
  for (const match of source.matchAll(/\b[A-Z][a-z]\b/gu)) {
    const start = match.index,
      end = start + match[0].length
    if (
      boundary.test([...source.slice(0, start)].at(-1) ?? '') ||
      boundary.test([...source.slice(end)][0] ?? '')
    )
      continue
    const parts = nativeParts(start, end, 2)
    if (!parts) continue
    const [base, script] = parts,
      height = base.bounds[3] - base.bounds[1],
      gap = script.bounds[0] - base.bounds[2],
      lowered =
        /^(?:[A-Z]{6}\+)?CMMI(?:8|B9)$/u.test(script.fontName) &&
        script.rise <= -height * 0.16 &&
        script.rise >= -height * 0.28 &&
        script.bounds[3] > base.bounds[1] &&
        center(script) < center(base),
      raised =
        /^[RZ]$/u.test(base.label) &&
        /^(?:[A-Z]{6}\+)?CMMI[78]$/u.test(script.fontName) &&
        script.rise >= height * 0.42 &&
        script.rise <= height * 0.65 &&
        script.bounds[1] < base.bounds[3] &&
        center(script) > center(base)
    if (
      base.label !== match[0][0] ||
      script.label !== match[0][1] ||
      !/^(?:[A-Z]{6}\+)?MSBM10$/u.test(base.fontName) ||
      !body(base) ||
      !small(script) ||
      ![base.baseline, script.baseline].every(Number.isFinite) ||
      Math.abs(script.baseline - base.baseline - script.rise) >= 0.01 ||
      gap < 0 ||
      gap > height * 0.1 ||
      (!lowered && !raised)
    )
      continue
    const label = match[0]
    if (!blackboardIndices.has(label)) blackboardIndices.set(label, [])
    blackboardIndices.get(label).push({ start, end, parts })
  }
  for (const [label, pairs] of blackboardIndices) {
    const from = occurrences(source, label),
      to = occurrences(translation, label)
    // An identical spelling in prose or at the opposite script level cannot replace a formula.
    const relation = (text, offset) => /([∈⊂])\s*$/u.exec(text.slice(0, offset))?.[1]
    if (
      from.length !== pairs.length ||
      from.length !== to.length ||
      pairs.some(
        ({ parts }, index) =>
          Math.sign(parts[1].rise) !== Math.sign(pairs[0].parts[1].rise) ||
          (parts[1].rise > 0 && relation(source, from[index]) !== relation(translation, to[index]))
      )
    )
      continue
    for (const [index, { start, end, parts }] of pairs.entries())
      pushNativeGroup(start, end, parts, parts[0], to[index], true)
  }
  // Treat a parenthesized sequence and its lowered range as one native run.
  for (const match of source.matchAll(
    /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}_])\([A-Z]([a-z])\)\1[≤≥]\d(?![\p{Script=Latin}\p{Script=Greek}\p{N}_])/gu
  )) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 7)
    if (!parts) continue
    const [opening, base, index, closing, lower, relation, bound] = parts,
      height = opening.bounds[3] - opening.bounds[1]
    if (
      parts.some((part, i) => part.sourceOffset !== start + i || part.label !== match[0][i]) ||
      ![opening, base, closing].every((part) => body(part) && sameStyle(part, opening)) ||
      !/^(?:[A-Z]{6}\+)?LMRoman10-Regular$/u.test(opening.fontName) ||
      closing.fontName !== opening.fontName ||
      !/^(?:[A-Z]{6}\+)?LMMathItalic10-Regular$/u.test(base.fontName) ||
      !/^(?:[A-Z]{6}\+)?LMMathItalic8-Regular$/u.test(index.fontName) ||
      lower.fontName !== index.fontName ||
      !/^(?:[A-Z]{6}\+)?LMMathSymbols8-Regular$/u.test(relation.fontName) ||
      !/^(?:[A-Z]{6}\+)?LMRoman8-Regular$/u.test(bound.fontName) ||
      !small(index) ||
      index.rise > -height * 0.1 ||
      index.rise < -height * 0.25 ||
      ![lower, relation, bound].every((part) => sameStyle(part, index)) ||
      parts.some((part, i) => {
        const gap = i ? part.bounds[0] - parts[i - 1].bounds[2] : 0
        return (
          !(Math.abs(part.baseline - opening.baseline - part.rise) < 0.01) ||
          gap < -height * 0.15 ||
          gap > height * 0.2
        )
      }) ||
      groups.some((group) =>
        parts.some((part) => group.sourceIndices.includes(part.sourceIndices[0]))
      )
    )
      continue
    addNativeGroup(start, end, parts, opening, true)
  }
  // The extracted space before a raised TeX prime does not make it a prose row.
  for (const match of source.matchAll(
    /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}_′″])([A-Z]|[a-z](?= ′\([a-z]\))) (′{1,2})(?![\p{Script=Latin}\p{Script=Greek}\p{N}_′″])/gu
  )) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 2)
    if (!parts) continue
    const [base, prime] = parts,
      derivative = /^[a-z]$/u.test(match[1]),
      h = base.bounds[3] - base.bounds[1],
      gap = prime.bounds[0] - base.bounds[2]
    if (
      base.sourceOffset !== start ||
      prime.sourceOffset !== start + 2 ||
      base.label !== match[1] ||
      prime.label !== match[2] ||
      !/^(?:[A-Z]{6}\+)?CMMI(?:9|10)$/u.test(base.fontName) ||
      !(derivative ? /^(?:[A-Z]{6}\+)?CMSY7$/u : /^(?:[A-Z]{6}\+)?CMSY[68]$/u).test(
        prime.fontName
      ) ||
      !body(base) ||
      prime.scale < 0.65 ||
      prime.scale > 0.75 ||
      ![base.baseline, prime.baseline].every(Number.isFinite) ||
      Math.abs(prime.baseline - base.baseline - prime.rise) >= 0.01 ||
      prime.rise < h * (derivative ? 0.35 : 0.5) ||
      prime.rise > h * (derivative ? 0.45 : 0.7) ||
      gap < 0 ||
      gap > h * 0.15 ||
      center(prime) <= center(base) ||
      prime.bounds[1] >= base.bounds[3]
    )
      continue
    if (derivative) {
      const from = occurrences(source, match[0]),
        to = occurrences(translation, match[0]),
        ordinal = from.indexOf(start)
      if (
        ordinal < 0 ||
        from.length !== to.length ||
        source.slice(end, end + 3) !==
          translation.slice(to[ordinal] + match[0].length, to[ordinal] + match[0].length + 3)
      )
        continue
      pushNativeGroup(start, end, parts, base, to[ordinal], true)
    } else addNativeGroup(start, end, parts, base, true)
  }
  // TeX can expose a blackboard-bold space and its raised dimension as one flat token.
  // Retain the complete native dimension product only when all four painters agree.
  for (const match of source.matchAll(
    /(?<=∈ )R[A-Z][×·](?:[A-Z]{1,3}|[a-z])(?![A-Za-z\p{Script=Greek}\d])/gu
  )) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 4)
    if (!parts) continue
    const [base, dimension, operator, parameter] = parts,
      height = base.bounds[3] - base.bounds[1]
    if (
      !/^(?:[A-Z]{6}\+)?MSBM10$/u.test(base.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMMI7$/u.test(dimension.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMSY7$/u.test(operator.fontName) ||
      !/^(?:[A-Z]{6}\+)?(?:CMMI7|CMR7|NimbusRomNo9L-Regu)$/u.test(parameter.fontName) ||
      !body(base) ||
      dimension.scale < 0.68 ||
      dimension.scale > 0.73 ||
      dimension.rise < height * 0.42 ||
      dimension.rise > height * 0.65 ||
      !parts.slice(1).every((part, index) => {
        const gap = part.bounds[0] - parts[index].bounds[2]
        return (
          sameStyle(part, dimension) &&
          Number.isFinite(part.baseline) &&
          Math.abs(part.baseline - base.baseline - part.rise) < 0.01 &&
          gap >= -height * 0.08 &&
          gap <= height * 0.32
        )
      })
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // A native mathematical capital can carry a smaller TeX index even when
  // extracted text spells both as a flat token. Its native run may begin with
  // a membership symbol, and the capital may overhang the lowered index.
  for (const match of source.matchAll(
    /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}_])(?:∈ )?[A-Z][a-z](?![\p{Script=Latin}\p{Script=Greek}\p{N}_])/gu
  )) {
    const start = match.index,
      end = start + match[0].length
    const parts = nativeParts(start, end, 2)
    if (!parts) continue
    const [base, index] = parts,
      height = base.bounds[3] - base.bounds[1],
      gap = index.bounds[0] - base.bounds[2]
    if (
      !/^(?:[A-Z]{6}\+)?CMSY10$/u.test(base.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMMI[78]$/u.test(index.fontName) ||
      !body(base) ||
      index.scale < 0.7 ||
      index.scale > 0.77 ||
      index.rise > -height * 0.13 ||
      index.rise < -height * 0.35 ||
      !Number.isFinite(base.baseline) ||
      !Number.isFinite(index.baseline) ||
      Math.abs(index.baseline - base.baseline - index.rise) > 0.01 ||
      index.bounds[0] <= base.bounds[0] ||
      gap < -height * 0.35 ||
      gap > height * 0.16 ||
      center(index) >= center(base)
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // A bracketed subscript can carry its own raised letter without appearing
  // raised above the body line. Keep the complete native index and base.
  for (const match of source.matchAll(
    /(?<![\p{Script=Latin}\p{Script=Greek}\p{N}_])\p{Script=Greek}\[\p{Ll}\][a-z](?![\p{Script=Latin}\p{Script=Greek}\p{N}_])/gu
  )) {
    const start = match.index,
      end = start + match[0].length
    const parts = nativeParts(start, end, 5)
    if (!parts) continue
    const [base, opening, letter, closing, suffix] = parts,
      height = (opening.bounds[3] - opening.bounds[1]) / opening.scale
    if (
      !/^(?:[A-Z]{6}\+)?CMMI10$/u.test(base.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMR7$/u.test(opening.fontName) ||
      closing.fontName !== opening.fontName ||
      !/^(?:[A-Z]{6}\+)?CMMI7$/u.test(letter.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMMI5$/u.test(suffix.fontName) ||
      !body(base) ||
      opening.scale < 0.68 ||
      opening.scale > 0.73 ||
      ![letter, closing].every((part) => sameStyle(part, opening)) ||
      opening.rise > -height * 0.12 ||
      opening.rise < -height * 0.25 ||
      suffix.scale < 0.48 ||
      suffix.scale > 0.53 ||
      Math.abs(suffix.rise) > height * 0.06 ||
      ![base, opening, letter, closing, suffix].every(
        (part) =>
          Number.isFinite(part.baseline) &&
          Math.abs(part.baseline - base.baseline - part.rise) < 0.01
      ) ||
      parts.slice(1).some((part, index) => {
        const gap = part.bounds[0] - parts[index].bounds[2]
        return gap < -height * 0.06 || gap > height * 0.2
      })
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // A logarithm may share its text object with prose. Move the complete native
  // base and scripted ratio together while regenerating the prose and “log”.
  const logarithmicMassRatio = /\blog((\d{1,2})M⋆\/M⊙)[.。]$/gu
  for (const match of source.matchAll(logarithmicMassRatio)) {
    const start = match.index + 3,
      end = start + match[1].length,
      parts = nativeParts(start, end, 5)
    if (!parts) continue
    const [logBase, numerator, star, slashMass, sun] = parts,
      h = numerator.bounds[3] - numerator.bounds[1],
      roman = /^(?:[A-Z]{6}\+)?CMR\d{1,2}$/u,
      italic = /^(?:[A-Z]{6}\+)?CMMI\d{1,2}$/u,
      symbol = /^(?:[A-Z]{6}\+)?CMSY\d{1,2}$/u,
      operators = markers.filter(
        (part) => part.sourceOffset + part.label.length === start && part.label.endsWith('log')
      ),
      [preceding] = operators
    if (
      operators.length !== 1 ||
      !body(preceding) ||
      !roman.test(preceding.fontName) ||
      ![preceding, ...parts].every(
        (part) =>
          Number.isFinite(part.baseline) &&
          Math.abs(part.baseline - numerator.baseline - part.rise) < 0.01
      ) ||
      logBase.sourceIndices[0] !== preceding.sourceIndices[0] + 1 ||
      logBase.label !== match[2] ||
      !roman.test(logBase.fontName) ||
      !italic.test(numerator.fontName) ||
      !italic.test(star.fontName) ||
      slashMass.fontName !== numerator.fontName ||
      !symbol.test(sun.fontName) ||
      [numerator.label, star.label, slashMass.label, sun.label].join('|') !== 'M|⋆|/M|⊙' ||
      !body(numerator) ||
      !body(slashMass) ||
      ![logBase, star, sun].every((part) => small(part)) ||
      !sameStyle(star, sun) ||
      star.rise > -h * 0.08 ||
      star.rise < -h * 0.35 ||
      logBase.rise > star.rise - h * 0.05 ||
      logBase.rise < -h * 0.5 ||
      parts.some((part, index) => {
        const previous = index ? parts[index - 1] : preceding,
          gap = part.bounds[0] - previous.bounds[2]
        return gap < -h * 0.12 || gap > h * 0.26
      })
    )
      continue
    const [target] = translation.matchAll(logarithmicMassRatio)
    if (target?.[1] !== match[1]) continue
    groups.push({
      sourceOffset: start,
      targetOffset: target.index + 3,
      label: match[1],
      sourceIndices: parts.flatMap((part) => part.sourceIndices),
      baselineIndex: numerator.sourceIndices[0],
      nativeScriptGroup: true,
      needsInlineReflow: true
    })
  }
  // Keep both lowered mass markers and the raised power as one native expression.
  const massAssignment =
    /(?<![\p{L}\p{N}])M⋆ = (\d{1,3}) × 10([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})M⊙(?![\p{L}\p{N}])/gu
  for (const match of source.matchAll(massAssignment)) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 8, true)
    if (!parts) continue
    const [mass, star, coefficient, times, decimal, power, unit, sun] = parts,
      h = mass.bounds[3] - mass.bounds[1],
      roman = /^(?:[A-Z]{6}\+)?CMR\d{1,2}$/u,
      italic = /^(?:[A-Z]{6}\+)?CMMI\d{1,2}$/u,
      symbol = /^(?:[A-Z]{6}\+)?CMSY\d{1,2}$/u
    if (
      ![mass, coefficient, times, decimal, unit].every(body) ||
      ![star, power, sun].every(small) ||
      !sameStyle(star, sun) ||
      Math.abs(power.scale - star.scale) > 0.01 ||
      !italic.test(mass.fontName) ||
      !italic.test(star.fontName) ||
      unit.fontName !== mass.fontName ||
      !roman.test(coefficient.fontName) ||
      decimal.fontName !== coefficient.fontName ||
      !roman.test(power.fontName) ||
      !symbol.test(times.fontName) ||
      !symbol.test(sun.fontName) ||
      [
        mass.label,
        star.label,
        coefficient.label,
        times.label,
        decimal.label,
        unit.label,
        sun.label
      ].join('|') !== ['M', '⋆', '= ' + match[1], '×', '10', 'M', '⊙'].join('|') ||
      power.label !== match[2].normalize('NFKC') ||
      star.rise < -h * 0.35 ||
      star.rise > -h * 0.1 ||
      power.rise < h * 0.3 ||
      power.rise > h * 0.65 ||
      parts.some((part, index) => {
        if (
          !Number.isFinite(part.baseline) ||
          Math.abs(part.baseline - mass.baseline - part.rise) > 0.01
        )
          return true
        if (index === 0) return false
        const gap = part.bounds[0] - parts[index - 1].bounds[2]
        return gap < -h * 0.09 || gap > h * ([1, 5, 7].includes(index) ? 0.24 : 0.8)
      })
    )
      continue
    const written = match[0].replace(match[2], '^' + power.label),
      originalOffsets = occurrences(source, match[0]),
      exactTargets = occurrences(translation, match[0]),
      caretTargets = occurrences(translation, written)
    if (originalOffsets.length !== 1 || exactTargets.length + caretTargets.length !== 1) continue
    const label = exactTargets.length ? match[0] : written
    groups.push({
      sourceOffset: start,
      targetOffset: exactTargets[0] ?? caretTargets[0],
      label,
      sourceLabel: match[0],
      sourceIndices: parts.flatMap((part) => part.sourceIndices),
      baselineIndex: mass.sourceIndices[0],
      nativeScriptGroup: true,
      needsInlineReflow: true
    })
  }

  // Extraction flattens a blackboard capital and its raised dimensions.
  // Move the entire native group only for unchanged set relations and dimensions.
  const dimensions =
    /([∈⊂])\s*([A-Z][a-z](?:×[a-z])?)(?![\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'×+\-/^−\u{1d400}-\u{1d7ff}])/gu
  const sourceDimensions = [...source.matchAll(dimensions)],
    targetDimensions = [...translation.matchAll(dimensions)]
  for (const match of sourceDimensions) {
    const label = match[2],
      end = match.index + match[0].length,
      start = end - label.length,
      parts = nativeParts(match.index, end, label.length + 1)
    if (!parts) continue
    const [relation, base, ...exponent] = parts,
      height = base.bounds[3] - base.bounds[1],
      relationGap = base.bounds[0] - relation.bounds[2]
    if (
      relation.sourceOffset !== match.index ||
      relation.label !== match[1] ||
      !/^(?:[A-Z]{6}\+)?CMSY(?:5|6|7|8|9|10|12)$/u.test(relation.fontName) ||
      !body(relation) ||
      !body(base) ||
      !Number.isFinite(relation.baseline - base.baseline) ||
      Math.abs(relation.baseline - base.baseline) > 0.01 ||
      relationGap < 0 ||
      relationGap >= height ||
      base.sourceOffset !== start ||
      base.label !== label[0] ||
      !/^(?:[A-Z]{6}\+)?MSBM(?:5|6|7|8|9|10|12)$/u.test(base.fontName) ||
      exponent.some((part, index) => {
        const gap = part.bounds[0] - parts[index + 1].bounds[2],
          font =
            part.label === '×' ? /^(?:[A-Z]{6}\+)?CMSY\d{1,2}$/u : /^(?:[A-Z]{6}\+)?CMMI\d{1,2}$/u
        return (
          part.sourceOffset !== start + index + 1 ||
          part.label !== label[index + 1] ||
          !font.test(part.fontName) ||
          !small(part) ||
          !sameStyle(exponent[0], part) ||
          part.rise < height * 0.3 ||
          part.rise > height * 0.85 ||
          center(part) <= center(base) ||
          gap < -height * 0.1 ||
          gap > height * 0.4
        )
      })
    )
      continue
    const from = sourceDimensions.filter((entry) => entry[2] === label),
      to = targetDimensions.filter((entry) => entry[2] === label)
    if (from.length !== to.length || from.some((entry, index) => entry[1] !== to[index][1]))
      continue
    const target = to[from.indexOf(match)]
    const targetOffset = target.index + target[0].length - label.length
    // The bare blackboard recognizer may already prove this exact native pair.
    if (
      groups.some(
        (group) =>
          group.sourceOffset === start &&
          group.targetOffset === targetOffset &&
          group.label === label &&
          group.sourceIndices.length === parts.length - 1 &&
          parts
            .slice(1)
            .every((part, index) => part.sourceIndices[0] === group.sourceIndices[index])
      )
    )
      continue
    pushNativeGroup(start, end, parts.slice(1), base, targetOffset)
  }
  // Preserve the entire raised exponent when TeX paints its slash separately.
  for (const match of source.matchAll(
    /(?<![\p{L}\p{M}\p{N}_])([a-z])([1-9]\/[2-9])(?![\p{L}\p{M}\p{N}_/])/gu
  )) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 4)
    if (!parts) continue
    const [base, numerator, slash, denominator] = parts,
      height = base.bounds[3] - base.bounds[1],
      rise = numerator.baseline - base.baseline
    if (
      !body(base) ||
      !/^(?:[A-Z]{6}\+)?CMMI10$/u.test(base.fontName) ||
      ![numerator, denominator].every((part) => /^(?:[A-Z]{6}\+)?CMR8$/u.test(part.fontName)) ||
      !/^(?:[A-Z]{6}\+)?CMMI8$/u.test(slash.fontName) ||
      !Number.isFinite(rise) ||
      rise < height * 0.55 ||
      rise > height * 0.95 ||
      parts.some((part, index) => {
        if (part.label !== match[0][index] || part.sourceOffset !== start + index) return true
        if (!index) return false
        const gap = part.bounds[0] - parts[index - 1].bounds[2]
        return (
          !small(part) ||
          !sameStyle(numerator, part) ||
          !Number.isFinite(part.baseline) ||
          Math.abs(part.baseline - base.baseline - rise) > 0.01 ||
          Math.abs(part.rise - rise) > 0.01 ||
          part.bounds[1] <= base.baseline ||
          gap < 0 ||
          gap > height * 0.3
        )
      })
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }

  // Preserve native symbolic powers beside their exact decimal base.
  const symbolicPowers =
    /(?<![\p{L}\p{M}\p{N}_])([1-9][0-9]{0,2})([a-z][2-9]?)(?![\p{L}\p{M}\p{N}_])/gu
  for (const match of source.matchAll(symbolicPowers)) {
    const start = match.index + match[1].length,
      end = match.index + match[0].length,
      parts = nativeParts(start, end, match[2].length),
      from = occurrences(source, match[0]),
      to = occurrences(translation, match[0])
    if (!parts || from.length !== to.length) continue
    const [first, second] = parts,
      bases = markers.filter(
        (part) =>
          part.sourceOffset <= match.index &&
          part.sourceOffset + part.label.length === start &&
          source.slice(part.sourceOffset, start) === part.label &&
          body(part)
      )
    if (bases.length !== 1) continue
    const [base] = bases,
      height = base.bounds?.[3] - base.bounds?.[1],
      raise = first.baseline - base.baseline,
      gap = first.bounds[0] - base.bounds[2]
    if (
      first.sourceOffset !== start ||
      first.label !== match[2][0] ||
      !nativeParts(base.sourceOffset, end, 1 + parts.length) ||
      !/^(?:[A-Z]{6}\+)?CMR10$/u.test(base.fontName) ||
      !/^(?:[A-Z]{6}\+)?CMMI7$/u.test(first.fontName) ||
      !small(first) ||
      !(raise > height * 0.3 && raise < height * 0.7) ||
      center(first) <= center(base) ||
      !(gap >= 0 && gap < height * 0.22)
    )
      continue
    if (second) {
      const innerRaise = second.baseline - first.baseline,
        innerGap = second.bounds[0] - first.bounds[2]
      if (
        second.sourceOffset !== start + 1 ||
        second.label !== match[2][1] ||
        !/^(?:[A-Z]{6}\+)?CMR5$/u.test(second.fontName) ||
        !(second.scale >= 0.45 && second.scale < first.scale * 0.8) ||
        !(innerRaise > height * 0.3 && innerRaise < height * 0.7) ||
        center(second) <= center(first) ||
        !(innerGap >= 0 && innerGap < height * 0.22)
      )
        continue
    }
    const ordinal = from.indexOf(match.index)
    if (ordinal < 0) continue
    if (base.sourceOffset === match.index) {
      pushNativeGroup(match.index, end, [base, ...parts], base, to[ordinal], true)
      continue
    }
    pushNativeGroup(start, end, parts, base, to[ordinal] + match[1].length, true)
  }
  // A raised parenthesized order and lowered index can share a blackboard
  // capital. Move their complete native glyphs together, even for split runs.
  for (const match of source.matchAll(/[A-Z](\([a-z0-9]{1,2}\))([1-9][0-9]?[a-z]?)/gu)) {
    const start = match.index,
      end = start + match[0].length,
      count = markers.filter(
        (part) => part.sourceOffset >= start && part.sourceOffset < end
      ).length,
      parts = count >= 3 && count <= 8 && nativeParts(start, end, count)
    if (!parts) continue
    const [base, ...indices] = parts,
      lowerOffset = start + 1 + match[1].length,
      upper = indices.filter((part) => part.sourceOffset < lowerOffset),
      lower = indices.filter((part) => part.sourceOffset >= lowerOffset),
      height = base.bounds[3] - base.bounds[1]
    if (
      !/^(?:[A-Z]{6}\+)?MSBM10$/u.test(base.fontName) ||
      !body(base) ||
      base.sourceOffset !== start ||
      base.label !== match[0][0] ||
      indices.some(
        (part, index) => part.sourceOffset !== parts[index].sourceOffset + parts[index].label.length
      ) ||
      ![upper, lower].every(
        (run, index) =>
          run.map((part) => part.label).join('') === match[index + 1] &&
          run.every(
            (part, at) =>
              small(part) &&
              /^(?:[A-Z]{6}\+)?CM(?:R|MI)7$/u.test(part.fontName) &&
              sameStyle(part, run[0]) &&
              Math.abs(part.baseline - base.baseline - part.rise) < 0.01 &&
              (at
                ? Math.abs(part.bounds[0] - run[at - 1].bounds[2]) < height * 0.2
                : Math.abs(part.bounds[0] - base.bounds[2]) < height * 0.25)
          )
      ) ||
      upper[0].rise < height * 0.4 ||
      upper[0].rise > height ||
      lower[0].rise > -height * 0.15 ||
      lower[0].rise < -height * 0.6 ||
      Math.abs(upper[0].bounds[0] - lower[0].bounds[0]) > height * 0.15 ||
      upper.some((part) => center(part) <= center(base)) ||
      lower.some((part) => center(part) >= center(base)) ||
      parts.map((part) => part.label).join('') !== match[0]
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // Cambria Math may paint a mathematical capital, its subscript, and its
  // parenthesized order in five adjacent objects, with overlapping script rails.
  for (const match of source.matchAll(/([\u{1D434}-\u{1D44D}])(\d{1,3})\((\d{1,2})\)/gu)) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 5)
    if (!parts) continue
    const [base, lower, open, order, close] = parts,
      height = base.bounds[3] - base.bounds[1]
    if (
      !/^(?:[A-Z]{6}\+)?CambriaMath$/u.test(base.fontName) ||
      !body(base) ||
      lower.label !== match[2] ||
      open.label !== '(' ||
      order.label !== match[3] ||
      close.label !== ')' ||
      parts.map((part) => part.label).join('') !== match[0] ||
      parts
        .slice(1)
        .some(
          (part, i) =>
            !small(part) ||
            part.fontName !== base.fontName ||
            Math.abs(part.scale - lower.scale) >= 0.02 ||
            part.sourceOffset !== parts[i].sourceOffset + parts[i].label.length
        ) ||
      lower.rise >= -height * 0.2 ||
      lower.rise <= -height * 0.6 ||
      open.rise <= height * 0.4 ||
      open.rise >= height ||
      Math.abs(lower.bounds[0] - base.bounds[2]) >= height * 0.15 ||
      Math.abs(open.bounds[0] - lower.bounds[0]) >= height * 0.3 ||
      center(lower) >= center(base) ||
      [open, order, close].some(
        (part, i) =>
          Math.abs(part.baseline - open.baseline) >= 0.01 ||
          center(part) <= center(base) ||
          Math.abs(part.bounds[0] - [base, open, order][i].bounds[2]) >= height * 0.25
      )
    )
      continue
    addNativeGroup(start, end, parts, base, true)
  }
  // Move the complete raised order and lowered index with their native base.
  for (const match of source.matchAll(/\p{Script=Greek}\(\d{1,2}\)\d{2,6}(?=\s*=)/gu)) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 5)
    if (!parts) continue
    const [base, open, order, close, lower] = parts,
      height = base.bounds[3] - base.bounds[1],
      upper = [open, order, close]
    if (
      open.label !== '(' ||
      close.label !== ')' ||
      !/^\d{1,2}$/u.test(order.label) ||
      !/^\d{2,6}$/u.test(lower.label) ||
      parts.map((part) => part.label).join('') !== match[0] ||
      !body(base) ||
      ![...upper, lower].every(small) ||
      open.rise <= height * 0.3 ||
      open.rise >= height ||
      lower.rise >= -height * 0.15 ||
      lower.rise <= -height * 0.7 ||
      Math.abs(lower.bounds[0] - open.bounds[0]) > height * 0.15 ||
      center(lower) >= center(base) ||
      upper.some((part, index) => {
        const gap = part.bounds[0] - [base, open, order][index].bounds[2]
        return (
          Math.abs(part.rise - open.rise) >= 0.01 ||
          center(part) <= center(base) ||
          gap < -height * 0.1 ||
          gap > height * 0.3
        )
      })
    )
      continue
    addNativeGroup(start, end, parts, base)
  }
  for (const match of source.matchAll(/\(∂([A-Za-z\p{Script=Greek}])\)(\p{Script=Greek})/gu)) {
    const opening = markers.filter(
        (part) =>
          ['(', '= ('].includes(part.label) &&
          part.sourceOffset + part.label.length === match.index + 1
      ),
      start = opening[0]?.sourceOffset,
      end = match.index + match[0].length,
      parts = opening.length === 1 && nativeParts(start, end, 5)
    if (!parts) continue
    const [open, operator, inner, close, outer] = parts,
      height = open.bounds[3] - open.bounds[1]
    if (
      operator.label !== '∂' ||
      inner.label !== match[1] ||
      close.label !== ')' ||
      outer.label !== match[2] ||
      parts.some(
        (part, index) =>
          index &&
          part.sourceOffset !== parts[index - 1].sourceOffset + parts[index - 1].label.length
      ) ||
      ![open, operator, close].every(body) ||
      ![inner, outer].every(small) ||
      Math.abs(inner.scale - outer.scale) >= 0.01 ||
      inner.rise >= -height * 0.05 ||
      inner.rise < -height * 0.4 ||
      outer.rise <= height * 0.1 ||
      outer.rise > height * 0.6 ||
      center(inner) >= center(open) ||
      center(outer) <= center(open) ||
      Math.abs(close.bounds[1] - open.bounds[1]) > height * 0.05 ||
      Math.abs(close.bounds[3] - open.bounds[3]) > height * 0.05 ||
      parts.some(
        (part, index) =>
          part.bounds[1] < open.bounds[1] - height * 0.1 ||
          part.bounds[3] > open.bounds[3] + height * 0.1 ||
          (index &&
            (part.bounds[0] < parts[index - 1].bounds[2] - height * 0.1 ||
              part.bounds[0] > parts[index - 1].bounds[2] + height * 0.5))
      )
    )
      continue
    addNativeGroup(start, end, parts, open)
  }
  for (const match of source.matchAll(
    /(?:∇(\p{Script=Greek}))?T (\p{Script=Greek}[a-z\p{Script=Greek}])/gu
  )) {
    const start = match.index,
      end = start + match[0].length,
      prefix = !!match[1],
      parts = nativeParts(start, end, prefix ? 4 : 2)
    if (!parts) continue
    const [base, raised] = parts.slice(-2),
      height = base.bounds[3] - base.bounds[1],
      gap = raised.bounds[0] - base.bounds[2]
    if (
      base.label !== 'T' ||
      base.sourceOffset !== start + (prefix ? 2 : 0) ||
      raised.label !== match[2] ||
      raised.sourceOffset !== base.sourceOffset + 2 ||
      !body(base) ||
      !small(raised) ||
      raised.rise <= height * 0.1 ||
      raised.rise > height * 0.8 ||
      center(raised) <= center(base) ||
      raised.bounds[1] <= base.bounds[1] ||
      raised.bounds[3] > base.bounds[3] + height * 0.5 ||
      gap < -height * 0.1 ||
      gap > height * 0.5
    )
      continue
    if (prefix) {
      const [operator, lower] = parts
      if (
        operator.label !== '∇' ||
        operator.sourceOffset !== start ||
        !body(operator) ||
        lower.label !== match[1] ||
        lower.sourceOffset !== start + 1 ||
        !small(lower) ||
        Math.abs(operator.scale - base.scale) >= 0.05 ||
        Math.abs(lower.scale - raised.scale) >= 0.01 ||
        lower.rise >= -height * 0.05 ||
        lower.rise < -height * 0.5 ||
        center(lower) >= center(operator) ||
        lower.bounds[3] <= operator.bounds[1] ||
        lower.bounds[0] < operator.bounds[2] - height * 0.1 ||
        lower.bounds[0] > operator.bounds[2] + height * 0.5 ||
        base.bounds[0] < lower.bounds[2] - height * 0.1 ||
        base.bounds[0] > lower.bounds[2] + height * 0.5 ||
        Math.abs(center(operator) - center(base)) > height * 0.3
      )
        continue
    }
    addNativeGroup(start, end, parts, base)
  }
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
  // NewTX paints an italic mathematical base and the lowered suffix
  // independently. Keep the joined native identifier on its source body row.
  for (const match of source.matchAll(
    /(?<![\p{L}\p{M}\p{N}_])([\u{1d434}-\u{1d467}])([a-z]{2,3}|ℓ)(?![\p{L}\p{M}\p{N}_])/gu
  )) {
    const start = match.index,
      end = start + match[0].length,
      parts = nativeParts(start, end, 2)
    if (!parts) continue
    const [base, index] = parts,
      height = base.bounds[3] - base.bounds[1],
      gap = index.bounds[0] - base.bounds[2]
    if (
      base.sourceOffset !== start ||
      base.label !== match[1] ||
      index.sourceOffset !== start + base.label.length ||
      index.label !== match[2] ||
      !/^(?:[A-Z]{6}\+)?NewTXMI$/u.test(base.fontName) ||
      !(index.label === 'ℓ'
        ? /^(?:[A-Z]{6}\+)?NewTXMI7$/u.test(index.fontName)
        : /^(?:[A-Z]{6}\+)?TeXGyreTermesX-Regular$/u.test(index.fontName)) ||
      !body(base) ||
      !small(index) ||
      !(Math.abs(index.baseline - base.baseline - index.rise) < 0.01) ||
      index.rise < -height * 0.36 ||
      index.rise > -height * 0.1 ||
      gap < -height * 0.2 ||
      gap > height * 0.25 ||
      index.bounds[0] <= base.bounds[0] ||
      index.bounds[3] <= base.bounds[1] ||
      center(index) >= center(base)
    )
      continue
    addNativeGroup(start, end, parts, base, true)
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
    if (
      /^(?:[A-Za-z\p{Script=Greek}\d]+⊥?|[A-Za-z\p{Script=Greek}]′[A-Za-z\p{Script=Greek}\d]{1,4})$/u.test(
        label
      )
    ) {
      const productBoundary =
          /[\p{Script=Latin}\p{Script=Greek}\p{N}\p{M}_′″‴'⊥\u{1d400}-\u{1d7ff}]/u,
        completeProduct = (text, token) =>
          !productBoundary.test([...text.slice(0, token.index)].at(-1) ?? '') &&
          !productBoundary.test([...text.slice(token.index + token[0].length)][0] ?? '')
      // Adjacent indexed factors form one identifier in extracted prose. Keep
      // their complete native packet instead of flattening either lowered run.
      if (
        parts.length === 4 &&
        [0, 2].every(
          (index) =>
            /^[A-Za-z\p{Script=Greek}]$/u.test(parts[index].label) &&
            parts[index].scale >= 0.9 &&
            parts[index].scale <= 1.1 &&
            Math.abs(parts[index].rise) <= 0.01
        ) &&
        [1, 3].every(
          (index) =>
            /^[A-Za-z\p{Script=Greek}\d]{1,3}$/u.test(parts[index].label) &&
            parts[index].scale >= 0.5 &&
            parts[index].scale < 0.85 &&
            parts[index].rise < -0.1
        ) &&
        from.every((token) => completeProduct(source, token)) &&
        to.every((token) => completeProduct(translation, token)) &&
        sameStyle(parts[0], parts[2]) &&
        sameStyle(parts[1], parts[3]) &&
        parts.every(
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
        ) &&
        [0, 2].every((index) => {
          const base = parts[index],
            lower = parts[index + 1],
            width = base.bounds[2] - base.bounds[0],
            height = base.bounds[3] - base.bounds[1]
          return (
            -lower.rise >= height * 0.05 &&
            -lower.rise <= height * 0.6 &&
            lower.bounds[0] >= base.bounds[2] - width * 0.25 &&
            lower.bounds[0] <= base.bounds[2] + width * 0.5 &&
            lower.bounds[1] < base.bounds[3] &&
            lower.bounds[3] > base.bounds[1] &&
            (!index ||
              (base.bounds[0] >= parts[index - 1].bounds[2] - width * 0.1 &&
                base.bounds[0] <= parts[index - 1].bounds[2] + width * 0.5))
          )
        })
      ) {
        groups.push({
          sourceOffset: match.index,
          targetOffset: to[from.indexOf(match)].index,
          label,
          sourceIndices: parts.flatMap((part) => part.sourceIndices),
          baselineIndex: parts[0].sourceIndices[0],
          indexedProduct: true
        })
        continue
      }
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
          !/^(?:[A-Za-z\p{Script=Greek}\d]{1,4}|′)$/u.test(upper.label) ||
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
          baselineIndex: base.sourceIndices[0],
          ...(upper.label === '′' ? { nativeScriptGroup: true } : {})
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

  // Computer Modern small-cap text can be lowered inside a math index without
  // changing its nominal size. Prove the full original run against the base row.
  const loweredIdentifier =
    /(?<![\p{Script=Latin}\p{Script=Greek}\d_])[A-Za-z](?:[A-Z] [a-z](?:,[A-Z]{1,3})?|[A-Z]{2},[a-z]{2,6}|[a-z])(?![\p{Script=Latin}\p{Script=Greek}\d_])/gu
  const smallCapAtom = /^[A-Za-z][A-Z] [a-z](?:,[A-Z]{1,3})?$/u
  const proved = []
  for (const match of source.matchAll(loweredIdentifier)) {
    const label = match[0],
      end = match.index + label.length,
      smallCaps = smallCapAtom.test(label),
      comma = label.includes(','),
      count = smallCaps ? 3 + (comma ? 2 : 0) : comma ? 4 : 2,
      parts = nativeParts(match.index, end, count)
    if (!parts) continue
    const [base, ...index] = parts,
      smallCapPart = smallCaps ? index[1] : undefined
    if (
      base.sourceOffset !== match.index ||
      !/^[A-Za-z]$/u.test(base.label) ||
      !/^CMMI\d{1,2}$/u.test(base.fontName ?? '') ||
      !body(base) ||
      parts.at(-1).sourceOffset + parts.at(-1).label.length !== end ||
      parts.some(
        (part, i) =>
          !Number.isFinite(part.baseline) ||
          (i > 0 &&
            parts[i - 1].sourceOffset +
              parts[i - 1].label.length +
              (part === smallCapPart ? 1 : 0) !==
              part.sourceOffset)
      )
    )
      continue
    const height = base.bounds[3] - base.bounds[1],
      drop = base.baseline - index[0].baseline,
      indexScale = index[0].scale
    if (
      drop < height * 0.1 ||
      drop > height * 0.32 ||
      !Number.isFinite(indexScale) ||
      indexScale < base.scale * 0.6 ||
      indexScale >= base.scale * 0.85 ||
      index.some((part, i) => {
        const previous = parts[i]
        if (
          Math.abs(part.baseline - index[0].baseline) > 0.03 ||
          part.bounds[0] < previous.bounds[2] - height * 0.04 ||
          part.bounds[0] > previous.bounds[2] + height * 0.4 ||
          part.bounds[3] <= base.bounds[1] ||
          part.bounds[3] > base.bounds[3]
        )
          return true
        return part === smallCapPart
          ? !/^CMCSC\d{1,2}$/u.test(part.fontName ?? '') ||
              Math.abs(part.scale - base.scale) > 0.02 ||
              part.bounds[3] - part.bounds[1] >= height * 0.72
          : Math.abs(part.scale - indexScale) > 0.02 ||
              !(part.label === ',' ? /^CMMI\d{1,2}$/u : /^CMR\d{1,2}$/u).test(part.fontName ?? '')
      })
    )
      continue
    proved.push({ match, parts, end, smallCaps })
  }
  if (proved.some(({ smallCaps }) => smallCaps)) {
    for (const { match, parts, end } of proved) {
      if (
        groups.some((group) =>
          group.sourceIndices.some((i) => parts.some((part) => part.sourceIndices[0] === i))
        )
      )
        continue
      addNativeGroup(match.index, end, parts, parts[0], true)
    }
  }
  return groups
}

// These markers come from verified PDF objects, not from guesses about translated prose.
// Equal occurrence counts allow each proven occurrence to retain its own styling.
// Extra target occurrences need consistent evidence for every source occurrence.
export const resolveScientificScriptSpans = (source, translation, markers) => {
  // Two Latin indices separated by a comma require the native lowered-index witness below.
  const tokens = (text) => [
    ...identifiers(text),
    ...text.matchAll(
      /(?<![A-Za-z\p{Script=Greek}\d])[A-Za-z]{2},[A-Za-z](?![A-Za-z\p{Script=Greek}\d])/gu
    )
  ]
  const sourceTokens = tokens(source),
    targetTokens = tokens(translation),
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
      (!/^[A-Za-z\p{Script=Greek}\d′∈<>≤≥×−+()[\],:=.-]+[,.;:]*$/u.test(marker.label) &&
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
  // Prove the lowered index against its complete native base.
  const hasNativeLoweredIndex = (match, run) => {
    if (
      run.rise >= 0 ||
      !/^(?:[A-Za-z\p{Script=Greek}\d]{1,3}|[A-Za-z],[A-Za-z])$/u.test(run.label)
    )
      return false
    const bases = markers.filter(
      (base) =>
        base.sourceOffset === match.index &&
        base.sourceOffset + base.label.length === run.sourceOffset &&
        /^[A-Za-z\p{Script=Greek}∆]$/u.test(base.label) &&
        source.slice(base.sourceOffset, run.sourceOffset) === base.label &&
        base.scale >= 0.9 &&
        base.scale <= 1.1 &&
        Math.abs(base.rise) < 0.01
    )
    if (bases.length !== 1) return false
    const base = bases[0]
    if (
      ![base, run].every(
        (part) =>
          part.sourceIndices.length === 1 &&
          Number.isInteger(part.sourceIndices[0]) &&
          part.sourceIndices[0] >= 0 &&
          part.bounds?.length === 4 &&
          part.bounds.every(Number.isFinite) &&
          part.bounds[0] < part.bounds[2] &&
          part.bounds[1] < part.bounds[3]
      ) ||
      base.sourceIndices[0] + 1 !== run.sourceIndices[0]
    )
      return false
    const h = base.bounds[3] - base.bounds[1]
    return (
      run.scale >= base.scale * 0.5 &&
      run.scale < base.scale * 0.85 &&
      run.rise >= -h * 0.6 &&
      run.rise <= -h * 0.05 &&
      run.bounds[0] > base.bounds[0] &&
      run.bounds[0] >= base.bounds[2] - h * 0.2 &&
      run.bounds[0] <= base.bounds[2] + h * 0.5 &&
      run.bounds[1] + run.bounds[3] < base.bounds[1] + base.bounds[3] &&
      run.bounds[3] > base.bounds[1] &&
      run.bounds[3] <= base.bounds[3]
    )
  }
  for (const run of runs) {
    const token = sourceTokens.find(
      (match) =>
        (match.index < run.sourceOffset ||
          (match.index === run.sourceOffset &&
            run.rise > 0 &&
            /^\([A-Za-z\p{Script=Greek}]{1,3}\)$/u.test(run.label))) &&
        (match.index + match[0].length === run.sourceOffset + run.label.length ||
          ((/^′{1,3}$/u.test(run.label) ||
            (run.rise < 0 && /^[\p{Script=Greek}]+(?:,[\p{Script=Greek}]+)+$/u.test(run.label)) ||
            hasNativeLoweredIndex(match, run)) &&
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
    if (/^[A-Za-z],[A-Za-z]$/u.test(run.label) && !hasNativeLoweredIndex(token, run)) continue
    const prefixLength = run.sourceOffset - token.index,
      prefix = token[0].slice(0, prefixLength).trimEnd(),
      nativeDifferenceIndex = prefix === '∆' && hasNativeLoweredIndex(token, run),
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
      !nativeDifferenceIndex &&
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
      !nativeDifferenceIndex &&
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
