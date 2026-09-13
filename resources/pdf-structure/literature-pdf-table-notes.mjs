/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind, joinCaptionLines, groupPageLines } from './literature-pdf-caption-group.mjs'
import { union, intersection, lineRect } from './literature-pdf-page-geometry.mjs'

// A note must begin with a footnote marker or explicit notes label and have one
// nearest preceding table. Continuations retain their original source region.
export function associateTableNotes(page, tables, rules = []) {
  const notes = tables.map(() => [])
  const symbolDefinitions = (text) =>
    /^[α-ωΑ-Ω]\s+\p{L}/u.test(text.trim()) &&
    (text.match(/,\s*[A-Z]{2,4}\s+[a-z]/g) ?? []).length >= 3
  const statisticDefinition = (text) =>
    /^(?:Baseline\s+)?Data are means?\s*±\s*SD(?:[;,.]|$)/i.test(text.trim())
  const abbreviationPrefix = (text) =>
    /^[A-Z][A-Z0-9.-]*[:,]\s*\p{L}/u.test(text) || /^[A-Z]{2,8}\s+indicates\s+\p{L}/u.test(text)
  const comparisonNote = (text) =>
    /^Compared (?:with|to) (?:the )?[\p{L}\d -]{1,60} group,\s*p\s*[=<>≤≥]\s*(?:0?\.\d+|1(?:\.0+)?)\.?$/iu.test(
      text.trim()
    )
  // Expansion-first keys need several explicit acronym pairs, not parenthesized
  // measurements or one ordinary prose definition.
  const expandedDefinitions = (text) => {
    const pairs = [
      ...text
        .trim()
        .matchAll(
          /(?:^|;\s*)\p{L}[\p{L} /–-]{1,79}\s+\((?=[A-Za-z -]*[A-Z])[A-Za-z][A-Za-z -]{1,15}\)(?=[;,.]|$)/gu
        )
    ]
    return pairs.length >= 3 && pairs[0].index === 0
  }
  // Commas and periods may separate colon definitions as well as semicolons.
  // Require multiple acronym keys; ordinary section headings are not a glossary.
  const colonDefinitions = (text) => {
    if (!/^[A-Z][A-Za-z0-9.+-]{0,7}:\s*\p{L}/u.test(text.trim())) return false
    const pairs = [
      ...text.trim().matchAll(/(?:^|[;,.]\s+)([A-Za-z][A-Za-z0-9.+-]{0,7}):\s*\p{L}/gu)
    ]
    return pairs.length >= 3 && pairs.filter((p) => /^[A-Z]{2,8}$/.test(p[1])).length >= 2
  }
  const definitionList = (text) =>
    expandedDefinitions(text) ||
    /^(?:[+^#$&]\s*\p{L}[\p{L}\s%-]*(?:\([\p{L}\d\s%.-]+\))?(?:,\s*|$)){3,}$/u.test(text.trim()) ||
    (/^[A-Z][A-Za-z0-9-]{1,7}\s*=\s*\p{L}/u.test(text.trim()) &&
      (text.match(/(?:^|[;,]\s*)[A-Z][A-Za-z0-9-]{1,7}\s*=\s*\p{L}/gu) ?? []).length >= 2) ||
    (/^[\p{L}][\p{L}\d+-]{1,11};\s*\p{L}/u.test(text.trim()) &&
      (text.match(/(?:^|,\s*)[\p{L}][\p{L}\d+-]{1,11};\s*\p{L}/gu) ?? []).length >= 3)
  const sourceCredit = (text) =>
    /^Data (?:taken|adapted|reproduced) from \[\d+(?:\s*[,–-]\s*\d+)*\]\.$/i.test(text.trim())
  const startsNote = (text) =>
    /^(?:[*⁎†‡§¶‖]|(?:Notes?|Abbreviations?|Annotations?|Sources?)\s*[:：]|注\s*[:：]|註\s*[:：])/i.test(
      text.trim()
    ) ||
    sourceCredit(text) ||
    /^P[- ]?values? represent comparisons\b/i.test(text.trim()) ||
    /^\+\s*Standard deviation(?:[;,.]|$)/i.test(text.trim()) ||
    /^Notes?\.$/i.test(text.trim()) ||
    /^Notes?\.?\s+\p{Lu}/u.test(text.trim()) ||
    /^Notes?\.\s*[—–-]\s*\p{L}/iu.test(text.trim()) ||
    // Named bibliographic sources can omit the usual Note: prefix.
    /^Modified from\s+\p{Lu}.*\b(?:18|19|20)\d{2}\b/u.test(text.trim()) ||
    /^No\.\s*=\s*number\b/i.test(text.trim()) ||
    /^NS\s*[:;,]\s*(?:not\s+|non[- ]?)significant\b/i.test(text.trim()) ||
    (/^[A-Z][A-Z0-9-]*:\s*n\s*=\s*\d+/.test(text.trim()) &&
      (text.match(/\bn\s*=\s*\d+/g) ?? []).length >= 2 &&
      /\bNS:\s*not\s+significant\.?$/i.test(text.trim())) ||
    (/^[A-Z][A-Z0-9-]*\s*\(\s*baseline\b/i.test(text.trim()) &&
      (text.match(/\bn\s*=\s*\d+/g) ?? []).length >= 3) ||
    // Unnumbered abbreviation keys below a table need several explicit pairs;
    // a single acronym in ordinary prose does not establish a table note.
    (/^[A-Z][A-Z0-9.-]*[:,]\s*\p{L}/u.test(text.trim()) &&
      (text.match(/(?:^|;\s*)[A-Z][A-Z0-9.-]*[:,]\s*\p{L}/gu) ?? []).length >= 3) ||
    (/^[A-Z]{2,8}\s+indicates\s+\p{L}/u.test(text.trim()) &&
      (text.match(/;\s*[A-Z][A-Za-z0-9/’'.-]{1,11}(?: ratio)?,\s*\p{L}/gu) ?? []).length >= 2) ||
    colonDefinitions(text) ||
    definitionList(text) ||
    /^T\s*\d+-T\s*\d+ was measured between T\s*\d+ and T\s*\d+\./i.test(text.trim()) ||
    (/^MD:\s*mean difference;/i.test(text.trim()) &&
      /95% CI:\s*95% confidence interval;/i.test(text)) ||
    /^(?:The pretreatments in the \d+ phases were|Data are given as geometric mean)\b/i.test(
      text.trim()
    ) ||
    /^Fisher[’']s exact test\.$/i.test(text.trim()) ||
    (/^(?:AUC[\d–∞a-z]*|APA)\b/.test(text.trim()) &&
      /(?:area under the|apalutamide, BCRP)/i.test(text)) ||
    /^Different superscript letters indicate significant difference\b/i.test(text.trim()) ||
    /^Values are mean \(SD\), number \(proportion\), or median \[q1, q3\]\./i.test(text.trim()) ||
    /^A significance level of <0\.01 was chosen considering multiple testing\./i.test(
      text.trim()
    ) ||
    statisticDefinition(text) ||
    /^Data (?:are )?represented as n\s*\(%\) or mean\s*\(SD\)\./i.test(text.trim()) ||
    /^Comparisons between the two study groups were performed using the Student[’']s\b/i.test(
      text.trim()
    ) ||
    /^(?:Data (?:are )?presented as|Estimates are presented as)\s/i.test(text.trim()) ||
    /^.{5,100}\bare expressed as mean\s*±\s*standard deviation\b/i.test(text.trim()) ||
    /^Data are n\s*\(\s*%\s*,\s*95% CI\)\./i.test(text.trim()) ||
    /^Values are (?:number|n)\s*\(%\) unless otherwise indicated\.?$/i.test(text.trim()) ||
    /^Values are presented as (?:number|n)\s*\(%\)(?: unless otherwise indicated)?(?:\.|$)/i.test(
      text.trim()
    ) ||
    symbolDefinitions(text)
  const lines = groupPageLines(page)
    // Diagonal publication watermarks have tall rotated bounds; they are not
    // intervening prose. Ordinary horizontal occurrences remain untouched.
    .filter(
      (line) =>
        !(
          line.bottom - line.y > line.fontSize * 2 &&
          /^(?:ACCEPTED (?:MANUSCRIPT|ARTICLE)|JOURNAL PRE[- ]PROOF|PROOF)$/i.test(line.text.trim())
        )
    )
    .map((line) => ({ ...line, width: line.right - line.x, height: line.bottom - line.y }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const used = new Set()
  const wrappedStatistics = (start) => {
    if (!/^[^.!?]{5,100}\b(?:and|of)\s*$/i.test(start.text)) return undefined
    return lines.find(
      (next) =>
        next.y > start.y + 2 &&
        next.y - start.y <= start.fontSize * 1.8 &&
        Math.abs(next.x - start.x) <= 2 &&
        Math.abs(next.fontSize - start.fontSize) <= 0.8 &&
        !tables.some(({ rect }) => intersection(rect, lineRect(next)) > 0) &&
        /^.{5,160}\bare expressed as mean\s*±\s*standard deviation\b/i.test(
          start.text + ' ' + next.text
        )
    )
  }
  const wrappedAbbreviations = (start) => {
    if (!abbreviationPrefix(start.text) && !/^(?:Ae|AUC)[\d–∞ h]*,/.test(start.text)) return false
    const parts = [start]
    for (const next of lines.filter((line) => line.y > start.y + 2)) {
      if (next.right <= start.x || next.x >= start.right) continue
      if (
        parts.length >= 3 ||
        next.x > start.x + 2 ||
        next.x < start.x - start.fontSize * 1.25 ||
        Math.abs(next.fontSize - start.fontSize) > 0.8 ||
        next.y - parts.at(-1).y > start.fontSize * 1.8 ||
        captionKind(next.text)
      )
        break
      parts.push(next)
    }
    return startsNote(parts.map((line) => line.text).join(' '))
  }
  // A repeated isotope prefix is scientific notation, not a numbered note.
  // The same mass/element must occur elsewhere on this page; ordinary raised
  // numeric footnotes retain the existing geometric checks.
  const repeatedIsotope = (line) => {
    const prefix = /^(\d{2,3})\s*(Zr|Tc|F|Cu|Ga|I|Lu|Y|In)[–-]/.exec(line.text)
    return (
      prefix &&
      lines.filter((other) => new RegExp(`\\b${prefix[1]}\\s*${prefix[2]}[–-]`).test(other.text))
        .length >= 2
    )
  }
  const raisedMarker = (line) =>
    !repeatedIsotope(line) &&
    /^(?:[a-z]|\d{1,2}[a-z]?)(?:\s*,)?\s+\p{L}/u.test(line.text) &&
    page.lines.some(
      (part) =>
        /^(?:[a-z]|\d{1,2}[a-z]?)$/.test(part.text) &&
        Math.abs(part.x - line.x) < 1 &&
        Math.abs(part.y - line.y) < 2 &&
        part.fontSize < line.fontSize * 0.8 &&
        part.y + part.height < line.bottom - line.fontSize * 0.15
    )
  // A neighboring column can put a raised marker in a different grouped row.
  // Recover only a small letter tightly adjoining this note on a raised baseline.
  const detachedMarker = (line) =>
    /^\p{L}/u.test(line.text) &&
    lines.find(
      (part) =>
        !used.has(part) &&
        /^[a-z]$/.test(part.text) &&
        part.fontSize < line.fontSize * 0.8 &&
        (Math.abs(part.right - line.x) < line.fontSize * 0.25 ||
          // A column can split the marker from its note during line grouping.
          // Wider spacing needs the next raised letter in an aligned series.
          (line.x >= part.right &&
            line.x - part.right < line.fontSize * 0.6 &&
            lines.some(
              (next) =>
                raisedMarker(next) &&
                next.text[0] === String.fromCharCode(part.text.charCodeAt(0) + 1) &&
                Math.abs(next.x - part.x) < 1 &&
                Math.abs(next.fontSize - line.fontSize) < 0.5 &&
                next.y >= line.bottom &&
                next.y - line.y < line.fontSize * 2
            ))) &&
        Math.abs(part.y - line.y) < line.fontSize * 0.5 &&
        line.bottom - part.bottom >= line.fontSize * 0.2 &&
        line.bottom - part.bottom <= line.fontSize * 0.8
    )
  const citedSymbol = (line, rect) => {
    const marker = /^[*†‡§¶‖#]/.exec(line.text)?.[0]
    return (
      marker &&
      page.lines.some(
        (part) =>
          part.text.includes(marker) &&
          part.y >= rect[1] &&
          part.y + part.height <= rect[3] &&
          part.x >= rect[0] &&
          part.x + part.width <= rect[2]
      )
    )
  }
  // Two-line notes can touch a manuscript table's bottom rule. Require a
  // comparison or a definition list, with abbreviations cited inside the table,
  // before joining a double-spaced continuation.
  const ruledDefinitionTail = (start, rect) => {
    const comparison =
      /^P\s*[=<>≤≥]\s*(?:0?\.\d+|1(?:\.0+)?)\s+for\b/i.test(start.text) &&
      (start.text.match(/\bp\s*[=<>≤≥]\s*(?:0?\.\d+|1(?:\.0+)?)/gi) ?? []).length === 2
    const definitions = [
      ...start.text.matchAll(/(?:^|;\s*)([A-Z0-9][A-Z0-9-]{1,11})\s*=\s*[a-z0-9]/g)
    ]
    const glossary = definitions.length >= 3 && definitions[0].index === 0
    if ((!comparison && !glossary) || Math.abs(start.y - rect[3]) > start.fontSize * 0.2) return
    const next = lines.find((l) => l.y > start.y + 2 && l.right > start.x && l.x < start.right)
    if (
      !next ||
      !/^[a-z]/.test(next.text) ||
      Math.abs(next.x - start.x) > 2 ||
      Math.abs(next.fontSize - start.fontSize) > 0.7 ||
      next.right > start.right + 2 ||
      next.y - start.y > start.fontSize * 2.5 ||
      next.y - start.y <= start.fontSize * 1.8
    )
      return
    const keys = [...next.text.matchAll(/(?:^|;\s*)([A-Z]{2,8})\s*=\s*\p{L}/gu)].map((m) => m[1])
    const words = page.lines
      .filter(
        (l) =>
          l.y >= rect[1] && l.y + l.height <= rect[3] && l.x >= rect[0] && l.x + l.width <= rect[2]
      )
      .flatMap((l) => l.text.split(/\W+/))
    if (glossary) {
      if (new Set(definitions.map((m) => m[1]).filter((k) => words.includes(k))).size < 2) return
    } else if (new Set(keys).size < 2 || keys.some((k) => !words.includes(k))) return
    return next
  }
  const touchesRuledBottom = (line, rect) => {
    if (
      !(raisedMarker(line) || citedSymbol(line, rect) || ruledDefinitionTail(line, rect)) ||
      line.y > rect[3] ||
      line.y < rect[3] - line.fontSize * 0.2
    )
      return false
    const bottom = rules
      .filter((r) => r[1] === r[3] && Math.abs(r[1] - rect[3]) < 0.5)
      .sort((a, b) => a[0] - b[0])
    return (
      bottom.some(
        (r) => Math.min(r[2], rect[2]) - Math.max(r[0], rect[0]) > (rect[2] - rect[0]) * 0.45
      ) ||
      ((citedSymbol(line, rect) || ruledDefinitionTail(line, rect)) &&
        bottom.length > 1 &&
        bottom.every((r, n) => !n || Math.abs(r[0] - bottom[n - 1][2]) < 1) &&
        Math.min(bottom.at(-1)[2], rect[2]) - Math.max(bottom[0][0], rect[0]) >
          (rect[2] - rect[0]) * 0.85)
    )
  }
  const ruledExplanation = (line, rect) => {
    const abbreviation =
      (/^[A-Z]{2,8} [a-z][a-z -]+(?:, [A-Z]{2,8} [a-z][a-z -]+)+\.?$/.test(line.text) ||
        /^[a-z]?[A-Z]{2,8},\s+[a-z][a-z\s-]+\.$/.test(line.text) ||
        (/^[A-Z][A-Z0-9.-]*,\s*\p{L}/u.test(line.text) &&
          (line.text.match(/(?:^|;\s*)[A-Z][A-Z0-9.-]*,\s*\p{L}/gu) ?? []).length >= 2)) &&
      line.width < (rect[2] - rect[0]) * 0.6
    if (
      line.y - rect[3] < 0 ||
      line.y - rect[3] > line.fontSize * 2 ||
      (line.text.split(/\s+/).length < 5 && !abbreviation)
    )
      return false
    const body = lines.filter(
      (other) =>
        other.y >= rect[1] &&
        other.bottom <= rect[3] &&
        other.y > rect[3] - 30 &&
        other.x >= rect[0] &&
        other.right <= rect[2]
    )
    if (!body.length) return false
    const bodySize = Math.min(...body.map((other) => other.fontSize))
    const countedExplanation =
      line.fontSize <= bodySize * 1.05 &&
      (line.text.match(/\(n\s*=\s*\d+\)/gi) ?? []).length >= 2 &&
      body.filter((other) => (other.text.match(/\d+\s*\([\d.]+\)/g) ?? []).length >= 2).length >= 2
    const referenceLocation =
      line.fontSize <= bodySize * 1.05 &&
      /^(?:The )?(?:reference|source) details\b[^.!?]+\b(?:shown|provided|listed) in (?:Appendix|Supplement(?:ary material)?)\b/i.test(
        line.text
      )
    const statisticalExplanation =
      line.fontSize <= bodySize * 1.05 &&
      /\bp\s*[=<>]\s*0?\.\d+\)/i.test(line.text) &&
      lines.some(
        (next) =>
          symbolDefinitions(next.text) &&
          next.y > line.y &&
          next.y - line.y <= line.fontSize * 1.8 &&
          Math.abs(next.x - line.x) <= 2 &&
          Math.abs(next.fontSize - line.fontSize) <= 0.8
      )
    if (
      line.fontSize >= bodySize * 0.95 &&
      !countedExplanation &&
      !referenceLocation &&
      !statisticalExplanation &&
      !(comparisonNote(line.text) && line.fontSize <= bodySize * 1.05) &&
      !(abbreviation && line.fontSize <= bodySize * 1.05)
    )
      return false
    const borders = rules.filter(
      (r) => Math.abs(r[3] - r[1]) < 1 && r[1] > rect[3] && r[1] < line.y
    )
    return borders.some((border) => {
      const segments = borders
        .filter((r) => Math.abs(r[1] - border[1]) < 1)
        .sort((a, b) => a[0] - b[0])
      return (
        segments.every((r, i) => !i || r[0] - segments[i - 1][2] < 1) &&
        segments.at(-1)[2] - segments[0][0] > (rect[2] - rect[0]) * 0.85 &&
        Math.abs(line.x - segments[0][0]) < (abbreviation ? line.fontSize : 2)
      )
    })
  }
  // A marginal caption can share a column with the table's footnotes. Require
  // an explicit matching source marker or a complete cited abbreviation list,
  // caption alignment and table-height bounds.
  const sideNoteRect = (start, rect) => {
    const marker = /^[#*†‡]\s*\p{L}/u.exec(start.text)?.[0]?.[0]
    if (
      (!marker && !/^[A-Z]{2,8}\s+\p{L}/u.test(start.text)) ||
      start.right >= rect[0] - 2 ||
      start.y < rect[1] ||
      start.bottom > rect[3] + start.fontSize * 2
    )
      return
    const caption = lines.find(
      (line) =>
        captionKind(line.text) === 'table' &&
        Math.abs(line.x - start.x) <= 2 &&
        line.right < rect[0] &&
        Math.abs(line.y - rect[1]) <= line.fontSize * 2
    )
    if (!caption) return
    const tableLines = lines.filter(
      (line) =>
        line.x >= rect[0] &&
        line.right <= rect[2] + 1 &&
        line.y >= rect[1] &&
        line.bottom <= rect[3]
    )
    if (marker) {
      if (!tableLines.some((line) => line.text.includes(marker))) return
    } else {
      // Join only the narrow aligned note column, then verify every explicit
      // acronym/expansion pair against the neighboring table's source text.
      const parts = [start]
      for (const next of lines.filter((line) => line.y > start.y + 2)) {
        if (next.x >= rect[0] || next.right <= start.x) continue
        if (
          next.right >= rect[0] - 2 ||
          Math.abs(next.x - start.x) > 2 ||
          Math.abs(next.fontSize - start.fontSize) > 0.8 ||
          next.y - parts.at(-1).y > start.fontSize * 1.8 ||
          next.bottom > rect[3] + start.fontSize * 2 ||
          captionKind(next.text)
        )
          break
        parts.push(next)
      }
      const definitions = joinCaptionLines(parts.map((line) => line.text)).split(/,\s*/)
      const pairs = definitions.map((text) =>
        /^([A-Z][A-Z0-9]{1,7})\s+(\p{L}[\p{L}\s/-]*)$/u.exec(text)
      )
      const keys = pairs.map((pair) => pair?.[1])
      const citedInTable = (key) => tableLines.some((line) => line.text.split(/\W+/).includes(key))
      // A two-entry list may define the scale named in the marginal caption.
      // Require a second key in the body and reject dangling uppercase keys
      // masquerading as the end of an incomplete expansion.
      const captionWords = lines
        .filter(
          (line) =>
            Math.abs(line.x - caption.x) <= 2 &&
            line.right < rect[0] &&
            line.y >= caption.y &&
            line.y <= caption.y + caption.fontSize * 4
        )
        .flatMap((line) => line.text.split(/\W+/))
      const shortList =
        keys.length === 2 &&
        pairs.every((pair) => pair && !/\b[A-Z]{2,8}\b/.test(pair[2])) &&
        keys.some(citedInTable)
      if (
        (!shortList && keys.length < 3) ||
        keys.some(
          (key) => !key || (!citedInTable(key) && !(shortList && captionWords.includes(key)))
        )
      )
        return
    }
    return [caption.x, rect[1], rect[0] - 4, rect[3]]
  }
  for (const start of lines) {
    const citedDefinitions = tables.some(({ rect }) => {
      if (
        start.y < rect[3] ||
        start.y - rect[3] > start.fontSize ||
        Math.abs(start.x - rect[0]) > 12
      )
        return false
      const pairs = [...start.text.matchAll(/(?:^|;\s*)([A-Za-z][A-Za-z0-9.-]{0,7})[:,]\s*\p{L}/gu)]
      const words = lines
        .filter(
          (l) =>
            l.y >= rect[1] && l.bottom <= rect[3] && l.x >= rect[0] - 2 && l.right <= rect[2] + 2
        )
        .flatMap((l) => l.text.toLowerCase().split(/[^a-z0-9.-]+/))
      return (
        pairs.length >= 2 &&
        pairs[0].index === 0 &&
        pairs.every((p) => words.includes(p[1].toLowerCase()))
      )
    })
    if (
      used.has(start) ||
      !(
        startsNote(start.text) ||
        tables.some(({ rect }) => ruledDefinitionTail(start, rect)) ||
        citedDefinitions ||
        tables.some(({ rect }) => sideNoteRect(start, rect)) ||
        wrappedStatistics(start) ||
        wrappedAbbreviations(start) ||
        raisedMarker(start) ||
        detachedMarker(start) ||
        tables.some(({ rect }) => ruledExplanation(start, rect))
      ) ||
      tables.some(
        ({ rect }) =>
          intersection(rect, lineRect(start)) > 0 &&
          // Raised footnote font boxes can cross a native bottom rule slightly.
          // Keep larger overlaps and unruled data inside the table.
          !touchesRuledBottom(start, rect)
      )
    )
      continue
    const candidates = tables
      .map(({ rect }, index) => {
        const side = sideNoteRect(start, rect)
        return {
          rect: side ?? rect,
          index,
          gap: side ? 0 : start.y - (notes[index].at(-1)?.rect[3] ?? rect[3])
        }
      })
      .filter(
        ({ rect, gap }) =>
          (gap >= 0 || touchesRuledBottom(start, rect)) &&
          gap <= Math.max(36, start.fontSize * 3) &&
          (Math.min(rect[2], start.x + start.width) - Math.max(rect[0], start.x)) /
            Math.min(rect[2] - rect[0], start.width) >=
            0.7
      )
      .sort((a, b) => a.gap - b.gap)
    if (!candidates.length || (candidates[1] && candidates[1].gap - candidates[0].gap < 2)) continue
    const continuation = wrappedStatistics(start)
    const parts = continuation ? [start, continuation] : [start]
    // Some manuscript footnote digits retain a full-size font box despite a
    // raised baseline. Only attach them to this explicit statistical note.
    const marker = /^Values are (?:number|n)\s*\(%\) unless otherwise indicated\.?$/i.test(
      start.text
    )
      ? lines.find(
          (line) =>
            /^\d$/.test(line.text) &&
            !used.has(line) &&
            line.x <= start.x &&
            start.x - line.x <= start.fontSize &&
            Math.abs(line.right - start.x) <= start.fontSize * 0.5 &&
            start.bottom - line.bottom >= start.fontSize * 0.2 &&
            start.bottom - line.bottom <= start.fontSize * 0.8 &&
            line.y >= candidates[0].rect[3]
        )
      : undefined
    const letter =
      detachedMarker(start) ??
      (/^Fisher[’']s exact test\.$/.test(start.text)
        ? lines.find(
            (part) =>
              /^[a-z]$/.test(part.text) &&
              !used.has(part) &&
              part.x < start.x &&
              start.x - part.x < start.fontSize &&
              Math.abs(part.right - start.x) < start.fontSize * 0.5 &&
              start.y - part.y > start.fontSize * 0.4 &&
              start.y - part.y < start.fontSize * 0.8 &&
              part.fontSize < start.fontSize * 1.1
          )
        : undefined)
    if (letter && letter.y >= candidates[0].rect[3]) {
      parts.unshift(letter)
      used.add(letter)
    }
    if (marker) {
      parts.unshift({ ...marker, text: '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(marker.text)] })
      used.add(marker)
    }
    used.add(start)
    if (continuation) used.add(continuation)
    // Some manuscript abbreviation keys use double-spaced prose. Require two
    // equally spaced continuation lines ending the statement, rather than
    // increasing the gap allowance for all notes and nearby body paragraphs.
    const tail = lines.filter((line) => line.y > start.y + 2).slice(0, 2)
    let doubleSpacedTail =
      /^[*†‡]/.test(start.text) &&
      start.text.length >= 60 &&
      !/[.;:]$/.test(start.text) &&
      tail.length === 2 &&
      /^[a-z]/.test(tail[0].text) &&
      /[.;]$/.test(tail[1].text) &&
      tail.every(
        (line, i) =>
          Math.abs(line.x - start.x) <= 2 &&
          Math.abs(line.fontSize - start.fontSize) <= 0.7 &&
          line.y - (i ? tail[0].y : start.y) > start.fontSize * 1.8 &&
          line.y - (i ? tail[0].y : start.y) <= start.fontSize * 2.5 &&
          Math.abs(line.y - (i ? tail[0].y : start.y) - (tail[0].y - start.y)) <= 1
      )
        ? tail
        : []
    const comparison = ruledDefinitionTail(start, candidates[0].rect)
    if (comparison) doubleSpacedTail = [comparison]
    // A cited symbol at the bottom rule may introduce a longer manuscript
    // note. Require one uniform double-spaced block with a short final line;
    // unrelated captions, changed indentation and new notes stop the scan.
    if (
      !doubleSpacedTail.length &&
      start.text.length >= 60 &&
      citedSymbol(start, candidates[0].rect) &&
      touchesRuledBottom(start, candidates[0].rect)
    ) {
      const block = []
      let previous = start,
        spacing
      for (const next of lines.filter((line) => line.y > start.y + 2).slice(0, 12)) {
        const gap = next.bottom - previous.bottom
        if (
          Math.abs(next.x - start.x) > 2 ||
          next.right > start.right + 2 ||
          Math.abs(next.fontSize - start.fontSize) > 0.7 ||
          gap <= start.fontSize * 1.8 ||
          gap > start.fontSize * 2.5 ||
          (spacing !== undefined && Math.abs(gap - spacing) > 1) ||
          captionKind(next.text) ||
          startsNote(next.text)
        )
          break
        spacing ??= gap
        block.push(next)
        if (next.width < start.width * 0.7 && /[.;]$/.test(next.text)) {
          if (block.length >= 3) doubleSpacedTail = block
          break
        }
        previous = next
      }
    }
    for (const next of lines.filter((line) => line.y > parts.at(-1).y + 2)) {
      // A complete comparison/P-value statement is self-contained.
      if (comparisonNote(start.text) || sourceCredit(start.text)) break
      if (
        next.x >= candidates[0].rect[2] + 4 ||
        next.x + next.width <= Math.max(candidates[0].rect[0] - 4, start.x - start.fontSize * 2)
      )
        continue
      const previous = parts.at(-1)
      if (doubleSpacedTail.length && previous === doubleSpacedTail.at(-1)) break
      // A wrapped reference can resemble a caption. Keep only a bare reference
      // completing an explicit "in/see Supplementary" phrase; titled captions stop.
      const referenceContinuation =
        /\b(?:in|see)\s+(?:the\s+)?Supplementary\s*$/i.test(previous.text) &&
        /^(?:Table|Fig\.|Figure)\s+S?\d+[a-z]?\.?$/i.test(next.text.trim())
      if (
        (startsNote(next.text) && !definitionList(next.text)) ||
        raisedMarker(next) ||
        detachedMarker(next) ||
        next.y - previous.y > start.fontSize * (doubleSpacedTail.includes(next) ? 2.5 : 1.8) ||
        Math.abs(next.fontSize - start.fontSize) > 0.8 ||
        next.x <
          (raisedMarker(start) || /^[*†‡§¶‖]/.test(start.text)
            ? // An accepted note may start outside an inset table crop. Its own
              // left edge remains a valid continuation boundary.
              Math.min(
                start.x - 1,
                Math.max(candidates[0].rect[0] - 2, start.x - start.fontSize * 2)
              )
            : wrappedAbbreviations(start) || statisticDefinition(start.text)
              ? start.x - start.fontSize * 1.25
              : start.x - 4) ||
        next.x > start.x + 24 ||
        (captionKind(next.text) && !referenceContinuation)
      )
        break
      if (tables.some(({ rect }) => intersection(rect, lineRect(next)) > 0)) break
      parts.push(next)
      used.add(next)
    }
    notes[candidates[0].index].push({
      text: joinCaptionLines(parts.map((line) => line.text)),
      rect: union(parts.map(lineRect))
    })
  }
  return notes
}
