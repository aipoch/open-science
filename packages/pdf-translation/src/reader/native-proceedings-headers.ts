import type { PdfLayoutPage, PdfLayoutTextItem } from './layout.js'
import {
  nativeContentsUpright,
  nativeHorizontalSourceItem,
  samePageSize,
  sameUnrotatedPageSize
} from './layout-evidence.js'
import { standaloneContactLine, wordCount } from './layout-text.js'

const x = (item: PdfLayoutTextItem): number => item.transform[4]
const y = (item: PdfLayoutTextItem): number => item.transform[5]
const right = (item: PdfLayoutTextItem): number => x(item) + item.width

const outsideProceedingsTopBand = (height: number, baseline: number): boolean =>
  height - baseline < height * 0.065 || height - baseline > height * 0.11
const outsideProceedingsSideMargin = (width: number, left: number): boolean =>
  left < width * 0.05 || left > width * 0.12

function hasProceedingsFooter(
  cover: PdfLayoutPage,
  text: string,
  imprint: PdfLayoutTextItem,
  near: (a: number, b: number) => boolean,
  left?: number
): boolean {
  return (
    cover.items.filter(
      (item) =>
        item.str === text &&
        nativeHorizontalSourceItem(item) &&
        (left === undefined || near(x(item), left)) &&
        near(item.height, imprint.height) &&
        y(item) < cover.height * 0.18
    ).length === 1
  )
}

export function nativeCoverPairedProceedingsHeaders(
  pages: PdfLayoutPage[],
  pageCount: number | undefined
): string[] {
  if (pageCount !== 2 || pages.length !== 2) return []
  const [cover, second] = pages
  if (cover.page !== 1 || second.page !== 2 || !sameUnrotatedPageSize(cover, second)) return []
  const front = cover.items.filter((item) => item.str.trim())
  const [title, first, , , email, next, , , otherEmail] = front
  const [event, space, authors] = second.items
  if (
    ![title, first, next, email, otherEmail, event, authors].every(nativeHorizontalSourceItem) ||
    ![email, otherEmail].every((item) => standaloneContactLine.test(item.str)) ||
    email.str === otherEmail.str ||
    authors.str !== first.str + ' and ' + next.str
  )
    return []
  const date =
    / [’'](?<short>\d{2}), [A-Z][a-z]+ \d{1,2}\s*[-–]\s*(?:[A-Z][a-z]+ )?\d{1,2}, (?<year>(?:19|20)\d{2}), \p{Lu}/u.exec(
      event.str
    )?.groups
  const em = event.height
  const left = x(event),
    top = y(event),
    rowRight = right(authors)
  const near = (a: number, b: number): boolean => Math.abs(a - b) < em * 0.15
  if (
    !date ||
    date.short !== date.year.slice(-2) ||
    !hasProceedingsFooter(cover, event.str, event, near, left) ||
    outsideProceedingsSideMargin(cover.width, left) ||
    outsideProceedingsTopBand(cover.height, top) ||
    authors.height !== em ||
    authors.fontName !== event.fontName ||
    y(authors) !== top ||
    space?.str !== ' ' ||
    space.height !== 0 ||
    space.fontName !== event.fontName ||
    y(space) !== top ||
    space.width < cover.width * 0.18 ||
    !near(x(space), left + event.width) ||
    !near(right(space), x(authors)) ||
    title.height < em * 2 ||
    !near(x(title), left) ||
    !near(right(title), rowRight) ||
    !near(left + rowRight, cover.width) ||
    !near(y(first), y(next)) ||
    x(first) > cover.width * 0.4 ||
    x(next) < cover.width * 0.6 ||
    second.items.slice(3).some((item) => item.str.trim() && top - y(item) - item.height < em * 2)
  )
    return []
  return ['2:0', '2:2']
}

// Match complete alternating proceedings margins to the cover title, bylines and dated footer.
export function nativeCompleteProceedingsMargins(
  pages: PdfLayoutPage[],
  pageCount: number | undefined
): string[] {
  if (pages.length !== pageCount || (pageCount !== 4 && pageCount !== 5)) return []
  const [cover, ...body] = pages
  if (
    !pages.every(
      (page, index) =>
        page.page === index + 1 &&
        page.rotation === 0 &&
        samePageSize(cover, page) &&
        page.width > 0 &&
        page.height > 0
    )
  )
    return []
  const front = cover.items.filter((item) => item.str.trim())
  const splitTitle = pageCount === 4,
    titleRunCount = splitTitle ? 3 : 2,
    title = front.slice(0, titleRunCount),
    em = title[0]?.height
  const centered = (first: PdfLayoutTextItem, last: PdfLayoutTextItem): boolean =>
    Math.abs(x(first) + right(last) - cover.width) < em * 0.15
  if (
    title.length !== titleRunCount ||
    !title.every((item) => nativeHorizontalSourceItem(item) && item.height === em) ||
    (splitTitle
      ? !centered(title[0], title[2]) ||
        !title.every(
          (item, index) =>
            y(item) === y(title[0]) &&
            (!index ||
              (x(item) > right(title[index - 1]) && x(item) - right(title[index - 1]) < em * 0.5))
        )
      : !title.every((item) => centered(item, item)) ||
        title[0].fontName !== title[1].fontName ||
        y(title[0]) - y(title[1]) < em ||
        y(title[0]) - y(title[1]) > em * 1.4)
  )
    return []
  const articleTitle = title.map((item) => item.str).join(' ')
  const abstract = front.findIndex((item) => /^Abstract[.:]?$/iu.test(item.str))
  const authorCells = front.slice(title.length, abstract)
  if (
    abstract < title.length ||
    (splitTitle
      ? authorCells.length !== 4
      : authorCells.length < 12 || authorCells.length > 32 || authorCells.length % 4 !== 0)
  )
    return []
  const firstByline = authorCells[0]
  const titleBottom = y(title.at(-1)!)
  if (titleBottom - y(firstByline) < em || titleBottom - y(firstByline) > em * 1.6) return []
  const names: string[] = []
  for (let index = 0; index < authorCells.length; index += 4) {
    const [name, institute, city, contact] = authorCells.slice(index, index + 4)
    const size = name.height
    if (
      ![name, institute, city, contact].every(nativeHorizontalSourceItem) ||
      !/^\p{Lu}[\p{L}. ’'-]+$/u.test(name.str) ||
      wordCount(name.str) < 2 ||
      size >= em ||
      !standaloneContactLine.test(contact.str) ||
      ![institute, city, contact].every(
        (item, n) =>
          item.fontName === name.fontName &&
          item.height < size &&
          Math.abs(x(item) + right(item) - x(name) - right(name)) < size * 0.24 &&
          Math.abs(y(name) - y(item) - size * (n + 1)) < size * 0.08
      )
    )
      return []
    names.push(name.str)
  }
  if (new Set(names).size !== names.length) return []
  const author = splitTitle ? names[0] : names.slice(0, -1).join(', ') + ', and ' + names.at(-1)
  const imprint = body[0].items[0]
  if (!nativeHorizontalSourceItem(imprint)) return []
  const date =
    /^[A-Z][A-Z0-9&.-]+(?: [A-Z][a-z]+){0,3} [’'](?<short>\d{2}), [A-Z][a-z]+ \d{1,2}(?:[–-]\d{1,2})?, (?<year>(?:19|20)\d{2}), \p{Lu}/u.exec(
      imprint.str
    )?.groups
  const height = imprint.height,
    top = y(imprint)
  const near = (a: number, b: number): boolean => Math.abs(a - b) < height * 0.08
  if (
    !date ||
    date.short !== date.year.slice(-2) ||
    outsideProceedingsTopBand(cover.height, top) ||
    !hasProceedingsFooter(cover, imprint.str, imprint, near)
  )
    return []
  const keys: string[] = []
  for (const page of body) {
    const even = page.page % 2 === 0,
      count = !even && splitTitle ? 4 : 2,
      row = Array.from({ length: count }, (_, index) => page.items[index * 2]),
      event = even ? row[0] : row.at(-1)!,
      peer = even ? row.slice(1) : row.slice(0, -1)
    if (
      !row.every(nativeHorizontalSourceItem) ||
      event.str !== imprint.str ||
      event.fontName !== imprint.fontName ||
      peer.map((item) => item.str).join(' ') !== (even ? author : articleTitle) ||
      outsideProceedingsSideMargin(page.width, x(row[0])) ||
      !near(x(row[0]), x(imprint)) ||
      !near(x(row[0]) + right(row.at(-1)!), page.width) ||
      row.some((item, index) => {
        if (y(item) !== top || item.height !== height) return true
        if (!index) return item.fontName !== imprint.fontName
        const previous = row[index - 1],
          gap = page.items[index * 2 - 1],
          interColumn = even ? index === 1 : index === row.length - 1
        return (
          gap?.str !== ' ' ||
          gap.height !== 0 ||
          y(gap) !== top ||
          gap.fontName !== previous.fontName ||
          !near(x(gap), right(previous)) ||
          !near(right(gap), x(item)) ||
          (interColumn ? gap.width < height * 3 : gap.width > height * 0.5) ||
          (interColumn && item.fontName !== imprint.fontName)
        )
      }) ||
      page.items
        .slice(row.length * 2 - 1)
        .some(
          (item) => item.str.trim() && top - y(item) - Math.abs(item.transform[3]) <= height * 2
        )
    )
      return []
    keys.push(...row.map((_, index) => `${page.page}:${index * 2}`))
  }
  return keys
}

// A dated submission imprint swaps rails beside a short title and grouped surnames.
export function nativeSubmissionProceedingsHeaders(
  pages: PdfLayoutPage[],
  pageCount: number | undefined
): string[] {
  if (pages.length < 7 || pages.length !== pageCount) return []
  const [cover, ...body] = pages
  if (
    !pages.every(
      (page, index) => page.page === index + 1 && page.rotation === 0 && samePageSize(cover, page)
    )
  )
    return []
  const [imprint, , byline] = body[0].items
  const [shortTitle] = body[1].items
  if (![imprint, byline, shortTitle].every(nativeContentsUpright)) return []
  const date =
    /^(?<label>Submitted to (?:[A-Z][A-Z0-9&.-]* ){1,4}[’'](?<short>\d{2})), \p{Lu}\p{Ll}+ \d{1,2}[–-]\d{1,2}, (?<year>(?:19|20)\d{2}), (?<place>\p{Lu}[\p{L} ,.'’-]+)$/u.exec(
      imprint.str
    )?.groups
  const names = byline.str.split(', ')
  const title = shortTitle.str.match(/^[\p{Lu}][\p{L}-]+(?: [\p{Lu}][\p{L}-]+){1,5}$/u)
  const h = imprint.height
  const near = (a: number, b: number): boolean => Math.abs(a - b) < h * 0.1
  const left = x(imprint),
    top = y(imprint)
  if (
    !date ||
    date.short !== date.year.slice(-2) ||
    !title ||
    names.length < 3 ||
    names.length > 8 ||
    new Set(names).size !== names.length ||
    names.some((name) => !/^\p{Lu}[\p{L}'’-]+$/u.test(name)) ||
    outsideProceedingsSideMargin(cover.width, left) ||
    outsideProceedingsTopBand(cover.height, top)
  )
    return []
  const front = cover.items.filter((item) => item.str.trim()),
    [first, second] = front,
    abstract = front.findIndex((item) => /^Abstract[.:]?$/iu.test(item.str))
  if (
    ![first, second].every(nativeHorizontalSourceItem) ||
    first.height < 2 * h ||
    second.height !== first.height ||
    first.fontName !== second.fontName ||
    y(first) - y(second) < first.height ||
    y(first) - y(second) > first.height * 1.4 ||
    ![first, second].every((item) => near(x(item) + right(item), cover.width)) ||
    abstract < 3
  )
    return []
  const coverWords = new Set(`${first.str} ${second.str}`.toLowerCase().match(/\p{L}+/gu))
  if (
    shortTitle.str.split(' ').some((word) => !coverWords.has(word.toLowerCase())) ||
    !names.every((name) =>
      front
        .slice(2, abstract)
        .some(
          (item) =>
            nativeHorizontalSourceItem(item) &&
            item.height > h * 1.5 &&
            item.height < first.height &&
            /^[\p{Lu}][\p{L}'’-]+(?: [\p{Lu}][\p{L}'’-]+)+$/u.test(item.str) &&
            item.str.endsWith(' ' + name)
        )
    ) ||
    !hasProceedingsFooter(cover, `${date.label}, ${date.place}`, imprint, near, left)
  )
    return []
  return body.every((page, index) => {
    const [first, gap, last] = page.items
    const event = index % 2 === 0 ? first : last
    const expectedPeer = index % 2 === 0 ? byline : shortTitle
    const peer = index % 2 === 0 ? last : first
    return (
      [first, last].every(nativeContentsUpright) &&
      event.str === imprint.str &&
      peer.str === expectedPeer.str &&
      near(event.width, imprint.width) &&
      near(peer.width, expectedPeer.width) &&
      [first, last].every(
        (item) => item.fontName === imprint.fontName && near(y(item), top) && near(item.height, h)
      ) &&
      near(x(first), left) &&
      near(right(last), page.width - left) &&
      gap?.str === ' ' &&
      gap.height === 0 &&
      gap.fontName === first.fontName &&
      near(y(gap), top) &&
      near(x(gap), right(first)) &&
      gap.width > 3 * h &&
      x(last) - right(first) > page.width * 0.2 &&
      page.items
        .slice(3)
        .every((item) => !item.str.trim() || top - y(item) - Math.abs(item.transform[3]) > h * 2)
    )
  })
    ? body.flatMap((page) => [`${page.page}:0`, `${page.page}:2`])
    : []
}
