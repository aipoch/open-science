/* eslint-disable @typescript-eslint/explicit-function-return-type */

const inside = (rect, item) =>
  Array.isArray(rect) &&
  Array.isArray(item?.rect) &&
  item.rect[0] >= rect[0] &&
  item.rect[2] <= rect[2] &&
  item.rect[1] >= rect[1] &&
  item.rect[3] <= rect[3]

const textOf = (item) =>
  String(item?.text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const numeric = /^[-+−]?\d+(?:[.,]\d+)?(?:%|[a-z])?$/i
const affiliation =
  /\b(?:University|Universit[ée]?|College|School|Department|Division|Institute|Laboratory|Lab|Hospital|Center|Centre|Clinic|Faculty)\b/i
const authorLike = /^(?:\d+(?:st|nd|rd|th)?\s+)?[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){1,5}$/u

const authorListLike = (value) => {
  const text = textOf({ text: value })
  if (!text.includes(',') || text.split(',').length < 2) return false
  const names =
    text.match(/(?:\d+(?:st|nd|rd|th)?\s+)?[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){1,5}/gu) ?? []
  return names.length >= 2
}

const hasAuthorListGrid = (table) => {
  const rows = Array.isArray(table?.grid) ? table.grid : []
  const values = rows
    .flat()
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  if (rows.length < 1 || rows.length > 3 || values.length < 4 || values.length > 12) return false
  if (rows.some((row) => !Array.isArray(row) || row.length < 2 || row.length > 4)) return false
  return values.filter(authorListLike).length >= Math.max(4, Math.ceil(values.length * 0.6))
}

const hasNumericRecord = (table, source) => {
  const rows = Array.isArray(table?.grid) ? table.grid : []
  if (
    rows.some(
      (row) =>
        Array.isArray(row) &&
        row.filter((value) => numeric.test(String(value ?? '').trim())).length >= 2
    )
  )
    return true
  const numericItems = source.filter((item) => numeric.test(textOf(item)))
  if (numericItems.length < 4) return false
  const baselines = []
  for (const item of numericItems) {
    const baseline = Number.isFinite(item.baseline) ? item.baseline : item.rect?.[3]
    const line = baselines.find((value) => Math.abs(value - baseline) < (item.height ?? 10) * 0.35)
    if (line) line.count += 1
    else baselines.push({ value: baseline, count: 1 })
  }
  return baselines.some((line) => line.count >= 2)
}

const hasClosedNativeFrame = (rules, box, height) => {
  if (!Array.isArray(rules) || !Array.isArray(box)) return false
  const horizontal = rules.filter(
    (rule) =>
      Array.isArray(rule) &&
      rule[1] === rule[3] &&
      Math.min(rule[2], box[2]) - Math.max(rule[0], box[0]) >= (box[2] - box[0]) * 0.65
  )
  if (horizontal.length < 2) return false
  const top = Math.min(...horizontal.map((rule) => rule[1]))
  const bottom = Math.max(...horizontal.map((rule) => rule[1]))
  const tolerance = Math.max(height * 1.5, 3)
  return (
    rules.some(
      (rule) =>
        Array.isArray(rule) &&
        rule[0] === rule[2] &&
        Math.abs(rule[0] - box[0]) <= tolerance &&
        Math.abs(rule[1] - top) <= tolerance &&
        Math.abs(rule[3] - bottom) <= tolerance
    ) &&
    rules.some(
      (rule) =>
        Array.isArray(rule) &&
        rule[0] === rule[2] &&
        Math.abs(rule[0] - box[2]) <= tolerance &&
        Math.abs(rule[1] - top) <= tolerance &&
        Math.abs(rule[3] - bottom) <= tolerance
    )
  )
}

// First-page author/affiliation/abstract bands are frequently mistaken for
// borderless tables. Reject only when source ink independently proves metadata:
// repeated contact addresses, institutional labels, and either author names or
// an abstract heading/prose block. Numeric records and a closed native frame keep
// a genuine data table eligible even when its labels resemble affiliations.
export function isNativeFrontMatterRegion(table, items, pageNumber, caption, rules = []) {
  if (pageNumber !== 1 || caption || !Array.isArray(table?.cropRect)) return false
  const source = (Array.isArray(items) ? items : []).filter(
    (item) => item?.horizontal !== false && inside(table.cropRect, item) && textOf(item)
  )
  if (source.length < 4) return false
  const emails = source.filter((item) => email.test(textOf(item)))
  const institutions = source.filter((item) => affiliation.test(textOf(item)))
  const authors = source.filter((item) => authorLike.test(textOf(item)))
  const abstract = source.some((item) => /^abstract\s*:?\s*$/i.test(textOf(item)))
  const prose = source.filter((item) => textOf(item).split(/\s+/).length >= 12)
  if (hasNumericRecord(table, source)) return false
  const height =
    source
      .map((item) => item.height)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[Math.floor(source.length / 2)] || 10
  if (hasClosedNativeFrame(rules, table.cropRect, height)) return false
  // Some two-column papers place only a compact, comma-separated author list
  // inside the detector crop. There may be no email, affiliation, or Abstract
  // token in that band, so the contact-based checks below cannot identify it.
  // Require a small grid whose cells independently look like author lists; this
  // keeps ordinary borderless comparison tables eligible.
  if (hasAuthorListGrid(table)) return true
  const repeatedContacts = emails.length >= 2 && institutions.length >= 2
  const contactWithAbstract =
    emails.length >= 1 && institutions.length >= 1 && abstract && prose.length >= 1
  const authorAbstract =
    abstract && authors.length >= 2 && prose.length >= 1 && institutions.length >= 1
  const authorInstitution = emails.length >= 1 && authors.length >= 2 && institutions.length >= 2
  return repeatedContacts || contactWithAbstract || authorAbstract || authorInstitution
}
