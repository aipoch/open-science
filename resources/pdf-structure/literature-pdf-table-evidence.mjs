/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { inside } from './literature-pdf-table-geometry.mjs'

// Detection confidence alone also accepts affiliations and prose. Like the upstream
// content-supported row/column refinement, require evidence from source text.
// ponytail: uncaptioned single-column or single-row tables remain ambiguous with lists;
// retain them only with a reliable table caption until richer layout evidence is available.
export function hasTableEvidence(table, caption, pageItems = []) {
  const populatedRows = table.grid.map((row) => row.filter((text) => text.trim()).length)
  if (!populatedRows.some((count) => count > 0)) return false
  // A supplementary-materials directory names several external tables. Its
  // neighboring entry is not a caption for the directory or nearby references.
  if (
    /^Supplementary Table/i.test(caption?.lines?.[0] ?? '') &&
    [...table.grid.map((row) => row.join(' ')), ...(table.unassigned ?? [])].filter((text) =>
      /^Supplementary Table S?\d+\s*[|:]/i.test(text)
    ).length >= 2
  )
    return false
  // A contents list has repeated numbered captions followed by page numbers.
  // A caption association to its first entry must not turn the list into a table.
  const contentsRows = table.grid.map((row) => row.join(' ').trim())
  if (
    contentsRows.filter((text) => /^(?:TABLE|FIGURE)\s+\d+\b.*\s\d+$/i.test(text)).length >= 3 &&
    table.grid.every((row) => row.filter((text) => text.trim()).length <= 3)
  )
    return false
  if (caption) return true
  if (
    table.repairs?.some((r) =>
      ['closed-numeric-grid-recovered', 'wrapped-count-grid-recovered'].includes(r)
    )
  )
    return true
  const sourceText = pageItems.map((item) => item.text).join(' ')
  const cropText = [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
  const compactText = cropText.replace(/\s/g, '')
  if (
    /\bAuthor contributions\b/i.test(sourceText) &&
    table.grid.every((row) => row.length === 2) &&
    table.grid[0].some((text) => /^Author Initials$/i.test(text.trim())) &&
    /conception|design|final approval/i.test(cropText)
  )
    return false
  const measurement = (text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())
  // Disclosure directories align names and relationship labels in columns.
  // Require several explicit relationship labels and no measurement columns;
  // a captioned research table has already been accepted above.
  if (
    table.grid.every((row) => row.length <= 2 && !row.some(measurement)) &&
    (
      cropText.match(
        /\b(?:Consulting or Advisory Role|Research Funding|Honoraria|Speakers[’'] Bureau|Uncompensated Relationships|Travel, Accommodations, Expenses)\s*:/g
      ) ?? []
    ).length >= 3
  )
    return false
  if (
    table.grid.every((row) => row.filter(measurement).length <= 1) &&
    ((/Published Online:/i.test(cropText) && /doi:\s*10\./i.test(cropText)) ||
      ((cropText.match(/\bDepartment of\b/gi) ?? []).length >= 3 &&
        table.grid.every((row) => row.length <= 3)) ||
      (/\b(?:PhD|MD)\b/.test(cropText) &&
        /\bJournal of\b/.test(cropText) &&
        /\bDOI:\s*10\./i.test(sourceText) &&
        /©/.test(sourceText) &&
        table.grid.length <= 3 &&
        table.grid.every((row) => row.length <= 2)))
  )
    return false
  if (
    /Corresponding Author\s*:/i.test(cropText) &&
    /E-mail\s*:\s*\S+@\S+/i.test(cropText) &&
    /doi\s*:\s*10\./i.test(cropText) &&
    /(?:Creative Commons|Published by)/i.test(cropText)
  )
    return false
  if (
    /Reprints and permission/i.test(cropText) &&
    /DOI:\s*10\./i.test(cropText) &&
    /https?:\/\//.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Citation prose may use volume, page range and a parenthesized year instead of semicolons.
  if (
    (cropText.match(/\d+,?\s+\d+[–-]\d+\s*\((?:19|20)\d{2}\)/g) ?? []).length >= 2 &&
    /\bet al\b/i.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Small fragments of a bibliography may contain only one citation. Require
  // multiple complete journal references in the source and no numeric columns.
  const journalReference = /\b(?:19|20)\d{2}\s*;\s*\d+\s*:\s*\d+/g
  if (
    table.grid.length <= 3 &&
    table.grid.every((r) => r.length <= 2) &&
    (sourceText.match(journalReference) ?? []).length >= 3 &&
    journalReference.test(cropText) &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.some((c) => /^[-−+]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(c.trim())))
  )
    return false

  if (
    /Updated version/i.test(sourceText) &&
    /Reprints and/i.test(sourceText) &&
    /Permissions/i.test(sourceText) &&
    /(?:most recent version|free email-alerts)/i.test(cropText)
  )
    return false
  if (
    /Search (?:profile|strategy)/i.test(sourceText) &&
    (cropText.match(/\d+\s+(?:OR|AND)\s+\d+/g) ?? []).length >= 2 &&
    table.grid.every((row) => row.length <= 2)
  )
    return false
  // Structured abstracts align section labels with prose, not measurements.
  const abstractLabels =
    /^(?:background|purpose|objectives?|patients and methods|methods|results|conclusions?)\s*:?$/i
  const sections = pageItems.filter((item) => abstractLabels.test(item.text.trim()))
  if (
    sections.length >= 3 &&
    sections.some((item) => /conclusion/i.test(item.text)) &&
    table.grid.every((row) => row.length <= 3) &&
    table.grid.some((row) => row.some((text) => text.length > 100)) &&
    sections.some((item) => inside(table.cropRect, item))
  )
    return false
  if (
    /\b(?:Tel\.|Telephone|Fax)\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((text) => /^[-+−]?\d+(?:\.\d+)?$/.test(text.trim())).length >= 2
    )
  )
    return false
  if (
    /ARTICLE TOOLS/i.test(cropText) &&
    /PERMISSIONS/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  if (
    /Email alerting service/i.test(cropText) &&
    /Receive free email alerts/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  // R/knitr console output is preformatted statistical text, not a predicted
  // cell grid. Keep it in the original PDF instead of publishing a broken grid.
  if (pageItems.filter((i) => /^##/.test(i.text.trim())).length >= 3) return false
  if (/\bAbstract\b/i.test(cropText) && /\bK\s*E\s*Y\s*W\s*O\s*R\s*D\s*S\b/i.test(sourceText))
    return false
  if (
    (cropText.match(/\b(?:19|20)\d{2}\s*;/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.filter((c) => /^\d+(?:\.\d+)?$/.test(c.trim())).length >= 2)
  )
    return false
  if (
    table.grid.length <= 4 &&
    table.grid.every((r) => r.length >= 2) &&
    /\b(?:ethics committee|ethics decision|ethics decisi-)\b/i.test(cropText) &&
    /\b(?:approval|approved)\b/i.test(sourceText)
  )
    return false
  if (
    /(?:通讯作者|通訊作者)/.test(compactText) &&
    /(?:收到|收稿|修订|接受|电子邮[件箱]|電子郵件|orcid\.org)/i.test(compactText)
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    (compactText.match(/\p{Script=Han}/gu) ?? []).length > 30 &&
    (/(?:参考文献|參考文獻|orcid\.org)/i.test(compactText) ||
      (compactText.match(/(?:19|20)\d{2}[；;年]/g) ?? []).length >= 2)
  )
    return false
  if (
    /\bPII\s*:/i.test(cropText) &&
    /\bDOI\s*:/i.test(cropText) &&
    /\b(?:Reference|To appear in)\s*:/i.test(cropText)
  )
    return false
  if (
    /\S+@\S+/.test(cropText) &&
    table.grid.length <= 6 &&
    table.grid.every(
      (row) =>
        row.length === 2 &&
        /^\d+$/.test(row[0]) &&
        /\b(?:Department|Division|University|Hospital|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    (cropText.match(/\[\d+\]/g) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}[;:]/g) ?? []).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((cell) => /^[-−+]?\d+(?:\.\d+)?$/.test(cell.trim())).length >= 2
    )
  )
    return false
  if (
    /Edited by\s*:/i.test(sourceText) &&
    /Reviewed by\s*:/i.test(sourceText) &&
    /(?:Reviewed by|University|Correspondence|Received|doi\s*:)/i.test(cropText)
  )
    return false
  if (
    /Academic Editor\s*:/i.test(sourceText) &&
    /Received\s*:/i.test(sourceText) &&
    /(?:doi\.org|Keywords\s*:|Academic Editor)/i.test(cropText)
  )
    return false
  const columnText = pageItems
    .filter(
      (item) =>
        !table.cropRect ||
        (item.rect?.[0] >= table.cropRect[0] &&
          item.rect?.[2] <= table.cropRect[2] &&
          item.rect[1] <= table.cropRect[1] + (item.rect[3] - item.rect[1]) * 2 &&
          item.rect[3] >= table.cropRect[1] - (item.rect[3] - item.rect[1]) * 6)
    )
    .map((item) => item.text)
    .join(' ')
  if (
    /A\s*R\s*T\s*I\s*C\s*L\s*E\s+I\s*N\s*F\s*O/i.test(columnText) &&
    /A\s*B\s*S\s*T\s*R\s*A\s*C\s*T/i.test(columnText) &&
    /Keywords\s*:/i.test(cropText)
  )
    return false
  if (
    table.grid[0]?.length === 2 &&
    table.grid.some((row) => /^\s*\*\s*$/.test(row[0]) && /\S+@\S+/.test(row[1])) &&
    table.grid.some(
      (row) => /^\d+$/.test(row[0]) && /\b(?:Department|University|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    /\b(?:Abbreviations|Nomenclature)\b/i.test(sourceText + ' ' + cropText) &&
    table.grid.length >= 4 &&
    table.grid.every((row) => row.length === 2 && row[0].length < 35) &&
    table.grid.filter(
      ([key, value]) => /^[A-Z][A-Za-z\d-]{1,15}$/.test(key) && /\p{L}/u.test(value)
    ).length >= 4 &&
    !table.grid.some((row) => row.some((value) => /^[-−+]?\d+(?:\.\d+)?$/.test(value.trim())))
  )
    return false
  // Publishers lay out abbreviation keys in two parallel key/description lists.
  // Require the heading and repeated acronym pairs, not merely a four-column grid.
  if (
    /\bAbbreviations\b/i.test(cropText) &&
    table.grid.every((row) => row.length === 4) &&
    table.grid
      .flatMap((row) => [
        [row[0], row[1]],
        [row[2], row[3]]
      ])
      .filter(([key, value]) => /^[A-Z][A-Z\d–-]{1,15}$/.test(key) && /\p{L}/u.test(value))
      .length >= 6 &&
    !table.grid.some((row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value)).length >= 2)
  )
    return false
  if (
    pageItems.some((item) => /^Affiliations\s*$/i.test(item.text)) &&
    (cropText.match(/\b(?:University|Hospital|College|Department)\b/g) ?? []).length >= 4 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid.length >= 3 &&
    table.grid.filter((row) => row.some((text) => /^\[\d+\]$/.test(text.trim()))).length >=
      table.grid.length * 0.7 &&
    /(?:Data availability|Informed consent)/i.test(cropText)
  )
    return false
  if (
    populatedRows.filter((n) => n === 0).length >= table.grid.length / 2 &&
    table.grid.some((row) => row.some((text) => /\bFig\.\s*\d/.test(text)))
  )
    return false
  // Parallel correspondence blocks are metadata even when addresses contain numbers.
  if (
    /\bCorresponding author[.:]/i.test(cropText) &&
    /\bE-?mail(?: address)?\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    /\b(?:Department|University|Hospital|Oncology|Therapy)\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Some journals print author initials and years without DOI links. Require
  // repeated citation anchors, volume/page ranges and long prose, not bare dates.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\b[A-Z]{1,3}\s+(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    (cropText.match(/\b\d+\s+\d+[–-]\d+/g) ?? []).length >= 2 &&
    table.grid.flat().filter((text) => text.split(/\s+/).length >= 8).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Author-year reference lists may have no numbered margin. Repeated DOI
  // anchors and publication years distinguish them from uncaptained data.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\bdoi\s*:\s*10\./gi) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    table.grid[0].every((_, column) => {
      const text = table.grid.map((row) => row[column]).join(' ')
      return /\bE-?mail\s*:/i.test(text) && /\b(?:Tel\.?|Telephone|Fax)\s*:/i.test(text)
    })
  )
    return false
  // Inspect source citation anchors as well as the reconstructed grid: a poor
  // grid can absorb the numbers into author names or lose whole reference rows.
  const cropItems = pageItems.filter((item) => table.cropRect && inside(table.cropRect, item))
  const possibleNumbers = cropItems.filter(
    (item) =>
      /^\d+$/.test(item.text.trim()) &&
      item.rect[0] < table.cropRect[0] + (table.cropRect[2] - table.cropRect[0]) * 0.12
  )
  const numberLeft = Math.min(...possibleNumbers.map((item) => item.rect[0]))
  const marginNumbers = possibleNumbers
    .filter((item) => Math.abs(item.rect[0] - numberLeft) < item.height * 0.3)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    marginNumbers.length >= 5 &&
    marginNumbers.every(
      (item, i) => !i || Number(item.text) === Number(marginNumbers[i - 1].text) + 1
    ) &&
    marginNumbers.filter((number) => {
      const text = cropItems
        .filter(
          (item) =>
            item.horizontal &&
            item.rect[0] > number.rect[2] &&
            item.height >= number.height * 0.9 &&
            Math.abs(item.baseline - number.baseline) < number.height * 0.4
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text)
        .join(' ')
      return text.length >= 40 && text.split(/\s+/).length >= 8
    }).length >=
      marginNumbers.length * 0.6
  )
    return false
  const possibleAnchors = cropItems.filter((item) => /^\d+\.$/.test(item.text.trim()))
  const anchorLeft = Math.min(...possibleAnchors.map((item) => item.rect[0]))
  const citationAnchors = possibleAnchors
    .filter((item) => Math.abs(item.rect[0] - anchorLeft) < item.height * 0.5)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    citationAnchors.length >= 3 &&
    citationAnchors.every(
      (item, i) =>
        !i ||
        (Math.abs(item.rect[0] - citationAnchors[0].rect[0]) < item.height &&
          Number.parseInt(item.text) === Number.parseInt(citationAnchors[i - 1].text) + 1)
    ) &&
    (
      cropItems
        .map((item) => item.text)
        .join(' ')
        .match(/\b(?:19|20)\d{2}\./g) ?? []
    ).length >= 3
  )
    return false
  // Publisher disclosure forms contain aligned fields and checklists, not research
  // tables. Require the template marker and a form section, not common row labels.
  if (
    pageItems.some((item) =>
      /^nature(?: portfolio)?\s*\|\s*reporting summary$/i.test(item.text.trim())
    ) &&
    pageItems.some((item) =>
      /^(?:Field-specific reporting|Life sciences study design|Reporting for specific materials, systems and methods)$/i.test(
        item.text.trim()
      )
    )
  )
    return false
  if (table.issues.includes('overlapping-predicted-columns')) return false
  // Parallel prose columns also produce confident multi-column predictions. A crop cutting
  // through paragraph text, with long prose in most cells of most rows, lacks row evidence.
  // Keep captioned tables and tables with short row labels/numeric or sequence values.
  const words = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0)
  if (
    (table.unassigned ?? []).some((text) => /^abbreviations\s*:?$/i.test(text.trim())) &&
    table.grid.length >= 3 &&
    table.grid.every(
      (row) => row.length === 2 && /^[\p{L}\d‒–-]+$/u.test(row[0]) && words(row[1]) >= 2
    )
  )
    return false
  const publicationSidebar = table.grid.map((row) => row[0] ?? '')
  if (
    publicationSidebar.some((text) => /^Received:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^Accepted:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^(?:Published online:|Check for updates)/i.test(text)) &&
    table.grid.some((row) => row.slice(1).some((text) => words(text) >= 60))
  )
    return false
  // Bibliography continuations may have no section heading. Their numbered entries
  // form a hanging-indent list, with publication years/author citations in prose.
  const referenceNumber = (row) => row[0]?.trim().match(/^[-–−]?\s*(\d+)[.)]?(?:\s+\p{L}+)?$/u)?.[1]
  const numbered = table.grid.filter((row) => referenceNumber(row))
  if (
    numbered.length >= 3 &&
    numbered.length >= populatedRows.filter((count) => count >= 2).length * 0.7 &&
    numbered.every(
      (row, i) => !i || Number(referenceNumber(row)) > Number(referenceNumber(numbered[i - 1]))
    ) &&
    numbered.filter(
      (row, i) => i && Number(referenceNumber(row)) === Number(referenceNumber(numbered[i - 1])) + 1
    ).length >=
      (numbered.length - 1) * 0.7 &&
    numbered.filter((row) => words(row.slice(1).join(' ')) >= 12).length >= numbered.length * 0.7 &&
    (
      [...numbered.flatMap((row) => row.slice(1)), ...(table.unassigned ?? [])]
        .join(' ')
        .match(/(?:\bet al\.|\((?:19|20)\d{2}\)|\b(?:19|20)\d{2};\d)/g) ?? []
    ).length >= 3 &&
    !table.grid
      .slice(0, table.grid.indexOf(numbered[0]))
      .some((row) => row.filter((text) => /\p{L}/u.test(text)).length >= 2)
  )
    return false
  // A ruled article-info/abstract panel is not a table, even when the whole prose
  // fits inside the crop. Require both the keyword sidebar and a nearby ABSTRACT
  // heading. A heading clipped by the upper edge also needs its paired ARTICLE
  // INFO label, so a cell mentioning an abstract remains valid.
  const keywordColumn = table.grid[0]?.findIndex((text) => /^key\s*words?\s*:?$/i.test(text.trim()))
  if (
    keywordColumn >= 0 &&
    table.grid.some((row) =>
      row.some((text, column) => column !== keywordColumn && words(text) >= 80)
    ) &&
    pageItems.some(
      (item) =>
        /^abstract:?$/i.test(item.text.replace(/\s+/g, '')) &&
        table.cropRect &&
        item.rect[0] >= table.cropRect[0] &&
        item.rect[2] <= table.cropRect[2] &&
        ((item.rect[3] <= table.cropRect[1] &&
          table.cropRect[1] - item.rect[3] <= 4 * (item.rect[3] - item.rect[1])) ||
          (Math.abs(item.rect[1] - table.cropRect[1]) <= item.rect[3] - item.rect[1] &&
            pageItems
              .filter(
                (other) =>
                  other.rect[0] >= table.cropRect[0] &&
                  other.rect[2] < item.rect[0] &&
                  Math.abs(other.rect[3] - item.rect[3]) < (item.rect[3] - item.rect[1]) * 0.5
              )
              .sort((a, b) => a.rect[0] - b.rect[0])
              .map((other) => other.text.replace(/\s+/g, ''))
              .join('')
              .toLowerCase() === 'articleinfo'))
    )
  )
    return false
  // A standalone bibliography heading plus a numbered, linked citation is prose,
  // even when the detector splits just one reference across several short columns.
  // A References column beside other headers is not a section heading.
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.some(
      (row) =>
        row.filter((text) => text.trim()).length === 1 &&
        row.some((text) => /^(?:references|bibliography)\s*:?$/i.test(text.trim()))
    ) &&
    table.grid.some((row) =>
      /^\s*(?:\d+[.)]|\[\d+\])\s+\p{L}/u.test(row.find((text) => text.trim()) ?? '')
    ) &&
    [...table.grid.flat(), ...(table.unassigned ?? [])].some((text) => /https?:\/\//i.test(text))
  )
    return false
  const mostlyUnassigned =
    words((table.unassigned ?? []).join(' ')) > words(table.grid.flat().join(' '))
  // A predicted divider through an ordinary paragraph has word-sized gaps on
  // both sides, not a stable column gutter. Require repeated prose rows and actual
  // source positions, so compact numeric tables and captioned prose tables survive.
  // Whole source lines can cross both the crop edge and its first divider.
  // Two such prose lines prove that a narrow three-column prediction cuts
  // ordinary paragraphs; do not reject captioned tables or numeric records.
  if (
    table.cropRect &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length === 3 && !row.some(measurement)) &&
    (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            words(item.text) >= 5 &&
            inside(cell.rect, item) &&
            item.rect[0] < table.cropRect[0] - item.height &&
            item.rect[2] > cell.rect[2] + item.height
        )
    ).length >= 2
  )
    return false
  const proseRecords = table.grid.filter((row) => row.filter((text) => text.trim()).length >= 2)
  const dividedProse =
    proseRecords.length >= 2 &&
    table.grid.every(
      (row) => row.filter((text) => text.trim()).length <= 2 && !row.some(measurement)
    ) &&
    proseRecords.filter(
      (row) =>
        row.some((text) => /\p{L}/u.test(text)) && row.reduce((n, text) => n + words(text), 0) >= 7
    ).length >=
      proseRecords.length * 0.6
  if (dividedProse) {
    const crossed = (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (a) =>
            a.rect &&
            inside(cell.rect, a) &&
            pageItems.some(
              (b) =>
                b.rect &&
                (b.rect[0] + b.rect[2]) / 2 >= cell.rect[2] &&
                b.rect[0] - a.rect[2] >= 0 &&
                b.rect[0] - a.rect[2] < a.height * 1.5 &&
                Math.abs(a.baseline - b.baseline) < a.height * 0.35
            )
        )
    )
    if (crossed.length >= 2 && crossed.length >= proseRecords.length * 0.6) return false
    // A detector can start in the tail of the neighboring prose column. The
    // apparent stub continues text outside the crop rather than naming a row.
    const paragraphTails = (table.cells ?? []).filter(
      (cell) =>
        table.cropRect &&
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            inside(cell.rect, item) &&
            pageItems.some(
              (before) =>
                before.rect &&
                before.rect[0] < table.cropRect[0] - item.height * 2 &&
                before.rect[2] <= item.rect[0] &&
                item.rect[0] - before.rect[2] < item.height * 1.5 &&
                Math.abs(before.baseline - item.baseline) < item.height * 0.35 &&
                /\p{L}/u.test(before.text)
            )
        )
    )
    if (paragraphTails.length >= 2 && paragraphTails.length >= proseRecords.length * 0.6)
      return false
  }
  const proseRows = table.grid.filter((row) => {
    const counts = row.map(words)
    return (
      row.length >= 2 &&
      (counts.every((count) => count >= 6) ||
        (mostlyUnassigned &&
          !row.some((text) => /^\s*[<>≤≥~±+−-]?(?:\d|[.,]\d)/u.test(text)) &&
          // A detached citation number is a prose continuation, not a numeric data column.
          counts.every((count, index) => count >= 2 || /^\[\d+\]$/.test(row[index].trim())) &&
          counts.some((count) => count >= 6) &&
          counts.reduce((sum, count) => sum + count, 0) >= 8))
    )
  })
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    proseRows.length > table.grid.length / 2
  )
    return false
  return populatedRows.filter((count) => count >= 2).length >= 2
}
