/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Offline geometry heuristic; a caption candidate is not a semantic classification.
import assert from 'node:assert/strict'

// A PDF stream may paint a small script after the rest of its physical line.
// Move it only when exactly one earlier token adjoins it and all intervening
// text lies beyond its right edge on the anchor baseline. Preserve all glyphs.
function orderDelayedInlineScripts(items) {
  const ordered = [...items]
  for (const item of items) {
    if (!/^[a-zA-Z0-9]{1,2}$/.test(item.str) || item.height <= 0) continue
    const index = ordered.indexOf(item)
    if (index < 2) continue
    const anchors = ordered.slice(0, index - 1).filter((anchor, n) => {
      if (
        !anchor.str.trim() ||
        item.height >= anchor.height * 0.7 ||
        [anchor, item].some((part) => part.transform[0] <= 0 || part.transform[1] !== 0)
      )
        return false
      const gap = item.transform[4] - anchor.transform[4] - anchor.width
      const offset = Math.abs(item.transform[5] - anchor.transform[5])
      const middle = ordered.slice(n + 1, index).filter((part) => part.str.trim())
      return (
        gap >= -anchor.height * 0.1 &&
        gap <= anchor.height * 0.35 &&
        offset > anchor.height * 0.08 &&
        offset <= anchor.height * 0.5 &&
        middle.length > 0 &&
        middle.every(
          (part) =>
            part.transform[1] === 0 &&
            part.transform[0] > 0 &&
            Math.abs(part.transform[5] - anchor.transform[5]) <= anchor.height * 0.1 &&
            part.transform[4] >= item.transform[4] + item.width
        )
      )
    })
    if (anchors.length !== 1) continue
    ordered.splice(index, 1)
    ordered.splice(ordered.indexOf(anchors[0]) + 1, 0, item)
  }
  return ordered
}

// PDF.js can insert a zero-height space when small caps change font size even
// though the next glyph starts at the previous glyph's advance. Join only that
// typographic pattern; ordinary word spaces and raised/lowered text stay intact.
export function joinPdfSmallCapsLine(items) {
  items = orderDelayedInlineScripts(items)
  return items
    .map((item, index) => {
      const before = items[index - 1],
        after = items[index + 1]
      if (
        item.str === ' ' &&
        item.height === 0 &&
        item.width <= 0.02 &&
        before &&
        after &&
        ((/(?:^|[\s-])[A-Z]$|^-$/.test(before.str) &&
          /^[A-Z]+$/.test(after.str) &&
          after.height >= before.height * 0.65 &&
          after.height <= before.height * 0.85) ||
          (/^[A-Z]+$/.test(before.str) &&
            /^[-.,*]+(?:\s?[A-Z])?$/.test(after.str) &&
            before.height >= after.height * 0.65 &&
            before.height <= after.height * 0.85)) &&
        before.fontName === after.fontName &&
        before.transform[1] === 0 &&
        before.transform[2] === 0 &&
        after.transform[1] === 0 &&
        after.transform[2] === 0 &&
        before.transform[0] > 0 &&
        after.transform[0] > 0 &&
        Math.abs(before.transform[5] - after.transform[5]) <= 0.01 &&
        Math.abs(after.transform[4] - before.transform[4] - before.width) <=
          Math.max(before.height, after.height) * 0.025
      )
        return ''
      return item.str
    })
    .join('')
    .trim()
}

// PDF streams can interleave columns at almost the same baseline without EOL.
// Split at a physical gutter or a backward column jump before concatenating text.
export function startsDetachedTextColumn(pending, item) {
  const before = pending.findLast((part) => part.str.trim() && part.height > 0)
  if (!before || !item.str.trim() || item.height <= 0) return false
  if (
    [before, item].some(
      (part) => part.transform[0] <= 0 || part.transform[1] !== 0 || part.transform[2] !== 0
    )
  )
    return false
  // Limit this repair to different text sizes, such as a small caption beside
  // body prose. Equal-size columns keep their established stream grouping.
  if (Math.min(before.height, item.height) > Math.max(before.height, item.height) * 0.85)
    return false
  const tolerance = Math.max(before.height, item.height) * 2
  return (
    item.transform[4] - before.transform[4] - before.width > tolerance ||
    before.transform[4] - item.transform[4] - item.width > tolerance
  )
}

export function captionKind(text) {
  if (
    /^(?:Table|Fig\.?|Figure)\s+[AS]?\d+\s+(?:shows?|shown|presents?|presented|illustrates?|depicts?|reiterates?)\b/i.test(
      text ?? ''
    )
  )
    return undefined
  // Some appendices label the diagram directly instead of assigning a figure number.
  if (/^Appendix\s+[A-Z][.:]\s+(?:CONSORT\s+)?(?:flow diagram|flowchart)\.?$/i.test(text ?? ''))
    return 'figure'
  // Single-table articles can use an explicit label without a sequence number.
  if (/^Table[.:]\s+\p{Lu}\p{L}/u.test(text ?? '')) return 'table'
  if (/^Figure\s+(?:[n▪■]\s+)?(?:Flow diagram|Flowchart)\b/.test(text ?? '')) return 'figure'
  // Pathology journals use decorated Image labels; a closing marker followed
  // by a period is an inline reference, not a caption heading.
  if (/^(?:❚Image\s+\d+❚\s+[A-Z]|Image\s+\d+[.:]\s+)/.test(text ?? '')) return 'figure'
  if (/^(?:Table|Fig\.?|Figure)\s*\(\d+\)\s*[:.]/i.test(text ?? ''))
    return /^Table/i.test(text) ? 'table' : 'figure'
  if (/^(?:Fig\.?|Figure)\s+\d+[A-Z][.:]\s/i.test(text ?? '')) return 'figure'
  if (/^(?:Table|Tab\.)\s+[IVXLCDM]+(?=[\s.:：．、]|$)/i.test(text ?? '')) return 'table'
  const match =
    /^(?:(?:Supplementary|Supplemental|Supplement|Extended\s+Data)\s+)?(F\s*I\s*G\s*U\s*R\s*E|F\s*I\s*G\.?|T\s*A\s*B\s*L\s*E|T\s*A\s*B\.?|图|圖|表)\s*[AS]?\d+(?:[.-]\d+)*(?=[\s.:：．、。]|$)/i.exec(
      text ?? ''
    )
  return match
    ? /^(?:Table|Tab\.?|表)$/i.test(match[1].replace(/\s/g, ''))
      ? 'table'
      : 'figure'
    : undefined
}

// Keep the original lines separately. A visible line-end hyphen can be reflowed
// only when an independent, unbroken spelling occurs on the same source page;
// competing hyphenated spellings retain the original text.
export function joinCaptionLines(lines, pageWords) {
  return lines.reduce((text, line) => {
    const next = line.trim()
    if (!next) return text
    if (text.endsWith('\u00ad')) return text.slice(0, -1) + next
    const prefix = /(\p{L}+)-$/u.exec(text)?.[1]
    const suffix = /^(\p{Ll}+)/u.exec(next)?.[1]
    if (
      prefix &&
      suffix &&
      pageWords?.has((prefix + suffix).toLowerCase()) &&
      !pageWords.has((prefix + '-' + suffix).toLowerCase())
    )
      return text.slice(0, -1) + next
    return text + (text && !/[-\u2010\u2011]$/.test(text) ? ' ' : '') + next
  }, '')
}

export function groupPageLines(page) {
  const rows = []
  // Join nearby fragments on the same visual line, including superscripts split by the first probe.
  for (const line of page.lines
    .filter((line) => !/^[◂◀◃]$/.test(line.text.trim()))
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    assert([line.x, line.y, line.width, line.height, line.fontSize].every(Number.isFinite))
    const row = rows.find((entry) => Math.abs(entry.y - line.y) <= 2)
    if (row) row.parts.push(line)
    else rows.push({ y: line.y, parts: [line] })
  }
  const runs = []
  // A raised numeric reference or lowered subscript can sit outside the normal line tolerance.
  // Require text tightly adjoining both sides on one baseline, rather than
  // widening that tolerance and absorbing the next physical line.
  for (const row of rows) {
    for (const part of [...row.parts]) {
      if (!/^(?:[\p{L}\d]{1,5},?|\d[\d–−/∞ h]{1,7})$/u.test(part.text)) continue
      const target = rows.find((other) => {
        if (other === row) return false
        const before = other.parts.find((p) => Math.abs(part.x - p.x - p.width) <= p.fontSize * 0.2)
        const after = other.parts.find(
          (p) => Math.abs(p.x - part.x - part.width) <= p.fontSize * 0.4
        )
        return (
          before &&
          after &&
          part.fontSize <= before.fontSize * 0.8 &&
          Math.abs(before.y - after.y) <= 1 &&
          Math.abs(before.fontSize - after.fontSize) <= 0.5 &&
          ((part.y > before.y + 2 &&
            part.y + part.height > before.y + before.height &&
            part.y + part.height - before.y - before.height <= before.fontSize * 0.5) ||
            (/^\d+$/.test(part.text) &&
              part.y < before.y &&
              before.y + before.height - part.y - part.height >= before.fontSize * 0.2 &&
              before.y + before.height - part.y - part.height <= before.fontSize * 0.8))
        )
      })
      if (target) {
        row.parts.splice(row.parts.indexOf(part), 1)
        target.parts.push({ ...part, inlineSubscript: part.y > target.y })
      }
    }
  }
  for (const row of rows) {
    let run
    let previous
    for (const part of row.parts.sort((a, b) => a.x - b.x)) {
      // Geometry only: permit nearby fragments, but do not bridge a typical column gutter.
      // A narrow gutter or unusually wide within-caption gap still needs layout-level evidence.
      if (run && part.x - run.right <= Math.max(run.fontSize, part.fontSize) * 0.8) {
        // Preserve numeric superscripts in the shared plain-text result. A smaller font alone
        // is not evidence: require a raised baseline and tight attachment to preceding text.
        const rise = run.bottom - (part.y + part.height)
        const superscript =
          /^\d+$/.test(part.text) &&
          part.fontSize <= run.fontSize * 0.8 &&
          rise >= run.fontSize * 0.2 &&
          rise <= run.fontSize * 0.8 &&
          part.x - run.right >= -run.fontSize * 0.1 &&
          part.x - run.right <= run.fontSize * 0.3
        run.text += superscript
          ? part.text.replace(/\d/g, (digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)])
          : (part.inlineSubscript ||
            (previous?.inlineSubscript && part.x - run.right <= part.fontSize * 0.2)
              ? ''
              : ' ') + part.text
        run.y = Math.min(run.y, part.y)
        run.right = Math.max(run.right, part.x + part.width)
        run.bottom = Math.max(run.bottom, part.y + part.height)
        run.fontSize = Math.max(run.fontSize, part.fontSize)
      } else {
        run = {
          text: part.text,
          x: part.x,
          y: part.y,
          right: part.x + part.width,
          bottom: part.y + part.height,
          fontSize: part.fontSize
        }
        runs.push(run)
      }
      previous = part
    }
  }
  return runs
}

// A PDF stream may omit EOL between prose and a numbered caption in the other
// column. Invisible spacing tokens must not bridge that physical gutter.
export function startsDetachedTableCaption(pending, item) {
  const previous = pending.findLast((i) => i.str.trim())
  return Boolean(
    previous &&
    /^(?:Table(?:\s+\d+)?|(?:Fig\.?|Figure)\s+\d+[.:]?)$/i.test(item.str.trim()) &&
    previous.transform[1] === 0 &&
    item.transform[1] === 0 &&
    Math.max(
      item.transform[4] - previous.transform[4] - previous.width,
      previous.transform[4] - item.transform[4] - item.width
    ) >
      Math.max(previous.height, item.height) * 2
  )
}

export function findCaptionCandidates(pages, rulesByPage = new Map()) {
  // Table borders are often painted one segment per column. Treat subpixel
  // joints as one separator without connecting unrelated rules across gutters.
  const separators = new Map(
    [...rulesByPage].map(([page, rules]) => {
      const joined = []
      for (const r of rules
        .filter((r) => r[1] === r[3])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
        const last = joined.at(-1)
        if (last && Math.abs(last[1] - r[1]) < 0.01 && r[0] <= last[2] + 0.75)
          last[2] = Math.max(last[2], r[2])
        else joined.push([...r])
      }
      return [page, joined]
    })
  )
  const candidates = []
  for (const page of pages) {
    const runs = groupPageLines(page)
    for (const start of runs.filter(({ text }) => captionKind(text))) {
      // A reference wrapped after "listed in" is part of the same paragraph.
      // Require its preceding source line, matching typography and tight leading.
      if (
        /^Table\s+\d+\s+for\s+[a-z]/.test(start.text) &&
        runs.some(
          (line) =>
            /\b(?:listed|shown|provided|presented|reported) in$/.test(line.text) &&
            Math.abs(line.x - start.x) <= 2 &&
            Math.abs(line.fontSize - start.fontSize) <= 0.5 &&
            line.bottom <= start.y &&
            start.y - line.bottom <= start.fontSize * 0.5
        )
      )
        continue
      const lines = [start]
      const legendPage =
        captionKind(start.text) === 'figure' &&
        runs.some(
          (line) =>
            /^(?:FIGURE )?LEGENDS$/i.test(line.text.trim()) &&
            line.y < start.y &&
            Math.abs(line.x - start.x) <= 2
        )
      // A double-spaced manuscript title can end with a marked, lowercase
      // continuation just above its table border. Require the complete border
      // across both lines; alignment and extra whitespace alone are insufficient.
      if (/^Table\s*\d+[.:]\s+[\p{L}]+(?:\s+[\p{L}]+)?$/u.test(start.text)) {
        const tail = runs.find((line) => line.y > start.bottom)
        if (
          tail &&
          /^[a-z][\p{L}\s-]{7,100}[*†]$/u.test(tail.text) &&
          Math.abs(tail.x - start.x) <= 2 &&
          Math.abs(tail.fontSize - start.fontSize) <= 0.7 &&
          tail.y - start.y <= start.fontSize * 2.5
        ) {
          const borders = []
          for (const rule of (rulesByPage.get(page.pageNumber) ?? [])
            .filter(
              (r) => r[1] === r[3] && r[1] >= tail.bottom && r[1] - tail.bottom <= start.fontSize
            )
            .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
            const prior = borders.at(-1)
            if (
              prior &&
              Math.abs(prior[1] - rule[1]) < 0.01 &&
              rule[0] - prior[2] <= start.fontSize * 0.05
            )
              prior[2] = Math.max(prior[2], rule[2])
            else borders.push([...rule])
          }
          if (borders.some((r) => r[0] <= start.x + 2 && r[2] >= Math.max(start.right, tail.right)))
            lines.push(tail)
        }
      }
      // Hanging legends align their continuation with the title after the figure
      // number. Require two adjacent prose lines at that indent before adopting it.
      const hangingTableTitle =
        captionKind(start.text) === 'table' && /\b(?:of|with|for|and)$/i.test(start.text)
      const hanging =
        (captionKind(start.text) === 'figure' || hangingTableTitle) &&
        runs.find(
          (line) =>
            line.y > start.y + 2 &&
            line.y - start.y <= start.fontSize * 1.6 &&
            line.x - start.x >= start.fontSize * 2 &&
            line.x - start.x <= start.fontSize * 6 &&
            line.text.length >= (hangingTableTitle ? 12 : 30) &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            !captionKind(line.text) &&
            ((hangingTableTitle && /[.)]$/.test(line.text) && line.right <= start.right + 2) ||
              runs.some(
                (next) =>
                  next.y > line.y + 2 &&
                  next.y - line.y <= start.fontSize * 1.6 &&
                  Math.abs(next.x - line.x) <= 2 &&
                  next.text.length >= 25 &&
                  Math.abs(next.fontSize - start.fontSize) <= 0.7 &&
                  !captionKind(next.text)
              ))
        )
      const sideLegend =
        captionKind(start.text) === 'figure' &&
        (page.graphicsBounds ?? []).some(
          ({ normalizedRect: r }) =>
            (r[2] - r[0]) * (r[3] - r[1]) > 0.03 &&
            r[1] * page.height <= start.y &&
            r[3] * page.height >= start.bottom &&
            ((r[2] * page.width <= start.x && start.x - r[2] * page.width < 60) ||
              (r[0] * page.width >= start.right && r[0] * page.width - start.right < 60))
        )
      // Some journals place the descriptive title in a separate full-width
      // ruled strip below an italic table number. Do not mistake that strip
      // for a header or bridge a rule on an ordinary, already complete caption.
      if (/^Table\s+\d+$/i.test(start.text.trim())) {
        const borders = (rulesByPage.get(page.pageNumber) ?? [])
          .filter((r) => r[1] === r[3] && Math.abs(r[0] - start.x) <= 2 && r[1] >= start.bottom)
          .sort((a, b) => a[1] - b[1])
        const [upper, lower] = borders
        if (
          upper &&
          lower &&
          upper[1] - start.bottom <= start.fontSize &&
          lower[1] - upper[1] <= start.fontSize * 4.5 &&
          Math.abs(upper[2] - lower[2]) <= 2
        ) {
          const strip = runs.filter(
            (line) =>
              line.y >= upper[1] &&
              line.bottom <= lower[1] &&
              line.x >= upper[0] - 2 &&
              line.right <= upper[2] + 2
          )
          if (
            strip.length >= 1 &&
            strip.length <= 3 &&
            strip[0].text.length >= 20 &&
            /\.$/.test(strip.at(-1).text) &&
            strip.every(
              (line, index) =>
                Math.abs(line.x - start.x) <= 2 &&
                Math.abs(line.fontSize - strip[0].fontSize) <= 1 &&
                !captionKind(line.text) &&
                (!index ||
                  (line.y > strip[index - 1].y &&
                    line.y - strip[index - 1].bottom <= line.fontSize))
            )
          )
            lines.push(...strip)
        }
      }
      // A centered, standalone manuscript table number may precede a left-aligned
      // title. Require a single prose block ending at the table's top rule.
      if (/^Table\s+\d+[.:]$/i.test(start.text.trim())) {
        const border = (rulesByPage.get(page.pageNumber) ?? [])
          .filter(
            (r) =>
              r[1] === r[3] &&
              r[1] > start.bottom &&
              r[1] - start.bottom <= start.fontSize * 9 &&
              r[0] < start.x &&
              r[2] - r[0] > start.fontSize * 5
          )
          .sort((a, b) => a[1] - b[1])[0]
        const title =
          border &&
          runs.filter(
            (line) =>
              line.y > start.bottom &&
              line.bottom < border[1] &&
              line.x >= border[0] - 2 &&
              line.bottom - line.y <= line.fontSize * 1.5
          )
        if (
          title?.length &&
          title.length <= 3 &&
          title[0].text.length >= 25 &&
          title.every(
            (line, index) =>
              !captionKind(line.text) &&
              Math.abs(line.x - title[0].x) <= 2 &&
              Math.abs(line.fontSize - start.fontSize) <= 1.5 &&
              line.y - (index ? title[index - 1].bottom : start.bottom) <= start.fontSize * 1.5
          ) &&
          title[0].x < start.x &&
          title.at(-1).bottom >= border[1] - start.fontSize * 2
        ) {
          lines.push(...title)
        }
        if (lines.length === 1 && border) {
          const prose = runs.filter(
            (l) =>
              l.y > start.bottom &&
              l.bottom < border[1] &&
              l.x >= border[0] - start.fontSize &&
              l.fontSize >= start.fontSize - 0.5 &&
              l.text.length >= 25 &&
              !captionKind(l.text)
          )
          if (prose.length === 1) {
            const t = prose[0]
            const columns = runs.filter(
              (l) =>
                l.y > t.bottom &&
                l.bottom < border[1] &&
                l.x >= border[0] &&
                l.right <= border[2] + 2 &&
                l.fontSize < t.fontSize - 1.5
            )
            if (
              t.y - start.bottom <= start.fontSize * 1.5 &&
              t.x < start.x &&
              t.right - t.x > (border[2] - border[0]) * 0.5 &&
              Math.abs((start.x + start.right - border[0] - border[2]) / 2) < start.fontSize &&
              columns.length >= 3 &&
              new Set(columns.map((l) => Math.round(l.x / 30))).size >= 3
            )
              lines.push(t)
          }
        }
      }
      // Decorated table labels may be larger than a hanging descriptive title.
      // A closing sample-size line and full-width rule bound that title block.
      if (lines.length === 1 && /^Table\s+\d+\s*[&•]/.test(start.text)) {
        const border = (rulesByPage.get(page.pageNumber) ?? [])
          .filter(
            (r) =>
              r[1] === r[3] &&
              r[1] >= start.bottom &&
              r[1] - start.bottom <= start.fontSize * 4 &&
              r[0] <= start.x + 2 &&
              r[2] >= start.right - 2
          )
          .sort((a, b) => a[1] - b[1])[0]
        const tail =
          border &&
          runs.filter(
            (line) =>
              line.y > start.y + 2 &&
              line.bottom < border[1] &&
              line.x >= start.x &&
              line.right <= border[2] + 2
          )
        if (
          tail?.length &&
          tail.length <= 3 &&
          /\(N\s*=\s*\d+\)(?:, continued)?$/i.test(tail.at(-1).text) &&
          border[1] - tail.at(-1).bottom <= start.fontSize &&
          tail.every(
            (line, index) =>
              !captionKind(line.text) &&
              Math.abs(line.x - tail[0].x) <= 2 &&
              Math.abs(line.fontSize - tail[0].fontSize) <= 0.7 &&
              Math.abs(line.fontSize - start.fontSize) <= start.fontSize * 0.35 &&
              line.y - (index ? tail[index - 1].bottom : start.bottom) <= start.fontSize
          )
        )
          lines.push(...tail)
      }
      // ponytail: left alignment, font size and line gap cannot distinguish a caption from body text.
      for (let count = 1; count < runs.length; count++) {
        const previous = lines.at(-1)
        const scannedTitle = (line) =>
          (lines.length === 1 || /\b(?:of|and|the)$/i.test(previous.text)) &&
          /^Table\s+\d+$/i.test(start.text.trim()) &&
          line.text.length >= 15 &&
          !/\d/.test(line.text) &&
          line.fontSize < start.fontSize &&
          Math.abs((line.x + line.right - start.x - start.right) / 2) <= 2 &&
          (page.graphicsBounds ?? []).some(
            (g) =>
              g.kind === 'image' &&
              (g.normalizedRect[2] - g.normalizedRect[0]) *
                (g.normalizedRect[3] - g.normalizedRect[1]) >
                0.9
          )
        const participantLine = (line) =>
          lines.length === 1 &&
          /^Table\s+\d+\s*[&•]/.test(start.text) &&
          /^(?:Participants?|Patients?)\s*\(N\s*=\s*\d+\)(?:, continued)?$/i.test(line.text) &&
          line.x >= start.x &&
          line.right <= start.right + start.fontSize * 2
        const next = runs
          .filter(
            (line) =>
              line.y > previous.y + 2 &&
              (Math.abs(line.x - start.x) <= 2 ||
                (hanging && Math.abs(line.x - hanging.x) <= 2) ||
                scannedTitle(line) ||
                participantLine(line) ||
                // Short centered continuation lines need a nearby table-header rule.
                // Alignment alone could otherwise absorb a centered column heading.
                (captionKind(start.text) === 'table' &&
                  Math.abs((line.x + line.right - start.x - start.right) / 2) <= 2 &&
                  (rulesByPage.get(page.pageNumber) ?? []).some(
                    ([x0, y0, x1, y1]) =>
                      y0 === y1 &&
                      y0 >= line.bottom &&
                      y0 - line.bottom <= start.fontSize &&
                      x0 <= Math.min(start.x, line.x) + 2 &&
                      x1 >= Math.max(start.right, line.right) - 2
                  )))
          )
          .sort((a, b) => a.y - b.y)[0]
        const boundedTableTail =
          next &&
          /^Table\s+\d+\s*[.:]\s*\S.{15}/i.test(start.text) &&
          !/[.!?]$/.test(previous.text.trim()) &&
          !/^Tabelle\s+\d+/i.test(next.text) &&
          next.text.length >= 20 &&
          Math.abs(next.x - start.x) <= 2 &&
          (separators.get(page.pageNumber) ?? []).some(
            (r) =>
              r[1] === r[3] &&
              r[1] >= next.bottom &&
              r[1] - start.bottom <= start.fontSize * 16 &&
              r[0] <= start.x + 8 &&
              r[2] - r[0] >= page.width * 0.5
          )
        const centeredTitle =
          next &&
          (scannedTitle(next) ||
            (/^Table\s+\d+$/i.test(start.text.trim()) &&
              Math.abs((next.x + next.right - start.x - start.right) / 2) <= 2 &&
              (rulesByPage.get(page.pageNumber) ?? []).some(
                (r) =>
                  r[1] === r[3] &&
                  r[1] >= next.bottom &&
                  r[1] - next.bottom <= start.fontSize * 2 &&
                  r[0] <= next.x &&
                  r[2] >= next.right
              )))
        if (
          !next ||
          next.y - previous.y >
            start.fontSize * (legendPage || boundedTableTail ? 2.5 : centeredTitle ? 1.8 : 1.6) ||
          Math.abs(next.fontSize - start.fontSize) >
            (participantLine(next)
              ? start.fontSize * 0.35
              : centeredTitle
                ? 1.5
                : sideLegend || /^(?:Fig\.?|Figure)\s+\d+[.:]$/i.test(start.text.trim())
                  ? 1.1
                  : 0.7) ||
          captionKind(next.text) ||
          (captionKind(start.text) === 'table' &&
            (separators.get(page.pageNumber) ?? []).some(
              ([x0, y0, x1, y1]) =>
                y0 === y1 &&
                y0 >= previous.bottom &&
                y0 <= next.y + next.fontSize * 0.1 &&
                x0 <= start.x + 2 &&
                x1 >= Math.max(previous.right, next.right) - 2
            ))
        )
          break
        lines.push(next)
      }
      // Nature-style legends can flow from a left column into a right column.
      // Require a caption separator or an unfinished sentence with consecutive
      // panel labels, plus aligned small type. Ordinary neighboring prose stays separate.
      const lastPanel = [
        ...lines
          .map((l) => l.text)
          .join(' ')
          .matchAll(/(?:Note:|;)\s*([A-Y])\.\s/g)
      ].at(-1)?.[1]
      const continuedPanel =
        captionKind(start.text) === 'figure' &&
        lastPanel &&
        /\b(?:between|and|of|with|for)$/.test(lines.at(-1).text)
          ? String.fromCharCode(lastPanel.charCodeAt(0) + 1)
          : undefined
      if ((start.text.includes('|') || continuedPanel) && lines.length >= 2) {
        const right = runs.find(
          (line) =>
            line.x > Math.max(...lines.map((l) => l.right)) &&
            line.x - Math.max(...lines.map((l) => l.right)) <= start.fontSize * 4 &&
            Math.abs(line.y - start.y) <= 2 &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            line.text.length >= 40 &&
            (start.text.includes('|') ||
              new RegExp(';\\s*' + continuedPanel + '\\.\\s').test(line.text)) &&
            !captionKind(line.text)
        )
        if (right) {
          lines.push(right)
          for (let count = 1; count < runs.length; count++) {
            const previous = lines.at(-1)
            const next = runs
              .filter((line) => line.y > previous.y + 2 && Math.abs(line.x - right.x) <= 2)
              .sort((a, b) => a.y - b.y)[0]
            if (
              !next ||
              next.y - previous.y > start.fontSize * 1.6 ||
              Math.abs(next.fontSize - start.fontSize) > 0.7 ||
              captionKind(next.text)
            )
              break
            lines.push(next)
          }
        }
      }
      // A translated title belongs to the same numbered table, but is usually
      // separated by more space than ordinary wrapped lines. Require its exact
      // number and a closing table rule instead of relaxing prose continuation.
      const tableNumber = /^Table\s+(\d+)\./i.exec(start.text)?.[1]
      if (tableNumber) {
        const previous = lines.at(-1)
        const translated = runs.find(
          (line) =>
            /^Tabelle\s+(\d+)\./i.exec(line.text)?.[1] === tableNumber &&
            Math.abs(line.x - start.x) <= 2 &&
            Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
            line.y > previous.y &&
            line.y - previous.y <= start.fontSize * 2
        )
        const border =
          translated &&
          (rulesByPage.get(page.pageNumber) ?? [])
            .filter(
              ([x0, y0, x1, y1]) =>
                y0 === y1 &&
                y0 >= translated.bottom &&
                y0 - translated.bottom <= start.fontSize * 4 &&
                Math.abs(x0 - start.x) <= 2 &&
                x1 >= Math.max(start.right, translated.right) - 2
            )
            .sort((a, b) => a[1] - b[1])[0]
        if (border) {
          const parts = runs
            .filter(
              (line) =>
                line.y >= translated.y &&
                line.bottom <= border[1] &&
                line.x >= border[0] - 2 &&
                line.right <= border[2] + 2
            )
            .sort((a, b) => a.y - b.y)
          if (
            parts[0] === translated &&
            parts.length <= 4 &&
            /\.$/.test(parts.at(-1).text) &&
            border[1] - parts.at(-1).bottom <= start.fontSize * 1.2 &&
            parts.every(
              (line, i) =>
                Math.abs(line.x - start.x) <= 2 &&
                Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
                (!i ||
                  (!/\.$/.test(parts[i - 1].text) &&
                    !captionKind(line.text) &&
                    !/^Tabelle\s+\d+/i.test(line.text) &&
                    line.y - parts[i - 1].y <= start.fontSize * 1.6))
            )
          )
            lines.push(...parts)
        }
      }
      candidates.push({
        page: page.pageNumber,
        lines: lines.map(({ text }) => text),
        rect: [
          Math.min(...lines.map((line) => line.x)),
          Math.min(...lines.map((line) => line.y)),
          Math.max(...lines.map((line) => line.right)),
          Math.max(...lines.map((line) => line.bottom))
        ]
      })
    }
  }
  return candidates
}
