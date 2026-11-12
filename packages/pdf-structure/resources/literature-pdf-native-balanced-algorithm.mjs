/* eslint-disable @typescript-eslint/explicit-function-return-type */

// This grammar consumes already bound, whole native records. It never supplies
// Source or crop evidence: the caller still proves every glyph, rail and foreign
// paint, including scripts and comments that do not participate in the grammar.
export function hasBalancedNativeAlgorithmBody(body, titleHeight, captionFont) {
  const h = titleHeight,
    near = (a, b) => Math.abs(a - b) < h * 0.02,
    rows = []
  if (!body?.length || body.length > 4096 || !Number.isFinite(h) || h <= 0) return false
  for (const record of body) {
    if (!near(record.r.height, h)) continue
    const baseline = record.vBaseline ?? record.rect[3]
    let row = rows.find((r) => near(r.baseline, baseline))
    if (!row) rows.push((row = { baseline, records: [] }))
    row.records.push(record)
  }
  rows.sort((a, b) => a.baseline - b.baseline)
  if (rows.length < 6 || rows.length > 256) return false
  for (const row of rows) {
    row.records.sort((a, b) => a.rect[0] - b.rect[0] || a.index - b.index)
    row.first = row.records[0]
    row.x = row.first.rect[0]
    row.text = row.records
      .map((r) => r.r.str.trim())
      .join(' ')
      .trim()
  }
  const controls = rows.filter((row) =>
      row.records.some(
        (record) =>
          record.r.fontName === captionFont &&
          /^(?:Init:|Input:|while\b|for\b|if\b|end\b)/u.test(record.r.str)
      )
    ),
    first = controls[0],
    stack = [],
    starts = /^(?:while|for|if)\b/u,
    ends = /^end\s+(while|for|if)$/u
  if (
    !first ||
    !/^(?:Init|Input):\s*\S/u.test(first.text) ||
    first.first.r.fontName !== captionFont
  )
    return false
  let loops = 0,
    closed = 0
  for (const [i, row] of controls.entries()) {
    if (i === 0) continue
    const close = ends.exec(row.text)
    if (close) {
      const open = stack.pop()
      if (!open || open.kind !== close[1] || !near(open.x, row.x)) return false
      const interior = rows.filter(
        (r) => r.baseline > open.baseline + h * 0.1 && r.baseline < row.baseline - h * 0.1
      )
      if (!interior.length || interior.some((r) => r.x < open.x + h * 0.5)) return false
      if (row.first.r.fontName !== captionFont) return false
      closed++
      continue
    }
    if (stack.length) {
      const open = stack.at(-1)
      if (row.x < open.x + h * 0.5) return false
      open.body = true
    } else if (row.x < first.x - h * 0.02) return false
    if (!starts.test(row.text)) {
      if (/^(?:end|else|repeat|until|Algorithm|Table|Figure)\b/u.test(row.text)) return false
      continue
    }
    if (row.first.r.fontName !== captionFont) return false
    const loop = /^(while|for)\b.+\bdo$/u.exec(row.text)
    if (loop) {
      stack.push({ kind: loop[1], x: row.x, baseline: row.baseline, body: false })
      loops++
      continue
    }
    const conditional = /^if\b.+\bthen(?:\s+(.+))?$/u.exec(row.text)
    if (!conditional) return false
    // An inline conditional owns its statement on the same baseline; only a
    // block conditional creates a scope that must close at the same indentation.
    if (!conditional[1]) stack.push({ kind: 'if', x: row.x, baseline: row.baseline, body: false })
  }
  return !stack.length && loops >= 1 && closed >= 2 && ends.test(rows.at(-1).text)
}

// A numbered Procedure has implicit dedent closures instead of explicit end
// tokens. This consumes only complete, already source-bound whole records; it
// cannot create or widen a Source packet.
export function hasCompleteNativeProcedureBody(body, titleHeight) {
  const h = titleHeight,
    tolerance = h * 0.15,
    sameIndent = (a, b) => Math.abs(a - b) <= tolerance,
    baselineOf = (record) => record.vBaseline ?? record.rect?.[3]
  if (
    !Array.isArray(body) ||
    body.length < 16 ||
    body.length > 4096 ||
    !Number.isFinite(h) ||
    h <= 0
  )
    return false
  if (
    body.some(
      (record, i) =>
        !record ||
        !Number.isSafeInteger(record.index) ||
        (i > 0 && record.index <= body[i - 1].index) ||
        typeof record.r?.str !== 'string' ||
        !record.r.str.trim() ||
        typeof record.r.fontName !== 'string' ||
        !Number.isFinite(record.r.height) ||
        record.r.height <= 0 ||
        !Array.isArray(record.rect) ||
        record.rect.length !== 4 ||
        !record.rect.every(Number.isFinite) ||
        record.rect[2] <= record.rect[0] ||
        record.rect[3] <= record.rect[1] ||
        !Number.isFinite(baselineOf(record))
    )
  )
    return false

  const ordinals = body.filter((record) => /^[1-9]\d*:$/.test(record.r.str.trim()))
  if (
    ordinals.length < 8 ||
    ordinals.length > 128 ||
    ordinals[0] !== body[0] ||
    ordinals.some(
      (record, i) =>
        Number(record.r.str.trim().slice(0, -1)) !== i + 1 ||
        record.r.fontName !== ordinals[0].r.fontName ||
        Math.abs(record.r.height - ordinals[0].r.height) > h * 0.001 ||
        (i > 0 && baselineOf(record) <= baselineOf(ordinals[i - 1]))
    )
  )
    return false

  const statements = []
  for (const [i, ordinal] of ordinals.entries()) {
    const next = ordinals[i + 1],
      packet = body.filter(
        (record) => record.index > ordinal.index && (!next || record.index < next.index)
      ),
      ordinalBaseline = baselineOf(ordinal),
      core = packet.filter((record) => record.r.height >= h * 0.85)
    if (!packet.length || !core.length) return false

    const lines = []
    for (const record of core) {
      const baseline = baselineOf(record)
      let line = lines.find((candidate) => Math.abs(candidate.baseline - baseline) <= h * 0.02)
      if (!line) lines.push((line = { baseline, records: [] }))
      line.records.push(record)
    }
    lines.sort((a, b) => a.baseline - b.baseline)
    for (const line of lines) {
      line.records.sort((a, b) => a.index - b.index)
      line.text = line.records
        .map((record) => record.r.str.trim())
        .join(' ')
        .trim()
      line.indent = line.records[0].rect[0]
    }
    const primary = lines.find((line) => Math.abs(line.baseline - ordinalBaseline) <= h * 0.15)
    if (!primary) return false
    const following = lines.filter((line) => line !== primary)
    let previous = primary
    for (const continuation of following) {
      if (
        continuation.baseline <= previous.baseline ||
        continuation.baseline - previous.baseline < h * 0.75 ||
        continuation.baseline - previous.baseline > h * 1.75 ||
        !/[\p{L}\p{N}]-\s*$/u.test(previous.text) ||
        !/^\p{Ll}/u.test(continuation.text) ||
        continuation.text.length < 2
      )
        return false
      previous = continuation
    }
    statements.push({
      ordinal: i + 1,
      sourceIndex: ordinal.index,
      text: primary.text,
      indent: primary.indent
    })
  }

  const signature = statements[0],
    signatureMatch = /^procedure\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(/iu.exec(signature.text)
  if (!signatureMatch) return false
  let depth = 0
  for (const character of signature.text.slice(signatureMatch[0].length - 1)) {
    if (character === '(') depth++
    else if (character === ')' && --depth < 0) return false
  }
  if (depth !== 0 || !signature.text.trimEnd().endsWith(')')) return false

  const baseIndent = statements[1]?.indent,
    stack = [],
    starts = /^(for)\b.+\bdo\s*$/iu,
    conditional = /^if\b.+\bthen\s*$/iu
  if (!Number.isFinite(baseIndent) || !sameIndent(statements.at(-1).indent, baseIndent))
    return false

  let loops = 0,
    returnCount = 0
  for (const [i, statement] of statements.entries()) {
    if (i === 0) continue
    const { text, indent } = statement
    if (indent < baseIndent - tolerance) return false

    if (/^else\s*$/iu.test(text)) {
      while (stack.length && stack.at(-1).indent > indent + tolerance) {
        const closed = stack.pop()
        if (!closed.body) return false
      }
      const target = stack.at(-1)
      if (
        !target ||
        target.kind !== 'if' ||
        !sameIndent(target.indent, indent) ||
        !target.body ||
        target.alternate
      )
        return false
      target.alternate = true
      target.body = false
      continue
    }

    while (stack.length && indent <= stack.at(-1).indent + tolerance) {
      const closed = stack.pop()
      if (!closed.body) return false
    }
    if (stack.length && indent - stack.at(-1).indent < h * 0.5) return false
    if (!stack.length && !sameIndent(indent, baseIndent)) return false
    if (stack.length) stack.at(-1).body = true

    if (/^return\b\s+\S/iu.test(text)) {
      if (i !== statements.length - 1 || stack.length || returnCount++) return false
      continue
    }
    if (/^(?:end|until|repeat|else|return|procedure|algorithm)\b/iu.test(text)) return false

    const openLoop = starts.exec(text)
    if (openLoop) {
      stack.push({ kind: 'for', indent, body: false, alternate: false })
      loops++
      continue
    }
    if (conditional.test(text)) {
      stack.push({ kind: 'if', indent, body: false, alternate: false })
      continue
    }
    if (/^(?:for|if)\b/iu.test(text)) return false
  }

  while (stack.length) {
    const closed = stack.pop()
    if (!closed.body) return false
  }
  return loops > 0 && returnCount === 1
}
