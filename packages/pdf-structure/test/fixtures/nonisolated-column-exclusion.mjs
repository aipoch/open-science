/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'
import { PDFDocument, StandardFonts } from 'pdf-lib'

export async function anonymousNonisolatedColumnExclusion(fault = '') {
  const stream = (text, dictionary = '') =>
    `<< ${dictionary} /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`
  const prior =
    fault === 'crossing-path'
      ? '300 350 m 550 350 l'
      : fault.startsWith('wrapped-citation-')
        ? '80 360 m 86 360 l'
        : '80 430 m 86 430 l'
  const form =
    fault === 'empty-canvas'
      ? 'q Q'
      : '0.5 w 320 300 240 160 re S 335 330 m 540 430 l S ' +
        (fault === 'outlined-only'
          ? ''
          : 'BT /R 10 Tf 1 0 0 1 335 435 Tm (Time) Tj ' +
            '1 0 0 1 335 365 Tm (Value) Tj 1 0 0 1 470 320 Tm (Series) Tj ET')
  const paragraph =
    fault === 'three-line-legend'
      ? [280, 294, 308]
      : [
          150,
          fault === 'ambiguous-row' ? 161.5 : 164,
          fault === 'ambiguous-row' ? 173 : 178,
          280,
          294,
          308,
          ...(fault === 'post-caption-body' || fault.startsWith('shared-') ? [] : [460, 474, 488])
        ]
  const text = (value, x, y, font = 'R', size = 11) =>
      `BT /${font} ${size} Tf 1 0 0 1 ${x} ${700 - y} Tm (${value}) Tj ET `,
    ordinary = 'Ordinary narrative continues in this column.',
    section = fault.startsWith('section-'),
    equation = fault.startsWith('equation-'),
    definition = fault.startsWith('definition-')
  let roles = ''
  if (section)
    roles =
      text(ordinary, 50, 215) +
      'BT /I 10 Tf ' +
      (fault === 'section-orphan-child'
        ? ''
        : '1 0 0 1 50 460 Tm (II.) Tj 1 0 0 1 68 460 Tm (BACKGROUND) Tj ') +
      (fault === 'section-roman' || fault === 'section-orphan-roman'
        ? ''
        : `1 0 0 1 50 445 Tm (${fault === 'section-panel' ? '(a)' : 'A.'}) Tj 1 0 0 1 68 445 Tm (Model) Tj `) +
      'ET '
  if (fault === 'section-orphan-roman') roles = text('II.', 100, 240, 'I', 10)
  if (equation) {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica),
      right = 50 + font.widthOfTextAtSize(ordinary, 11),
      tag = (n, y) =>
        text(
          `(${n})`,
          right -
            font.widthOfTextAtSize(`(${n})`, 11) -
            (fault === 'equation-misaligned' && n === 2 ? 5 : 0),
          y
        ),
      math = (y) =>
        ['x', fault === 'equation-no-relation' ? '+' : '=', 'y', '+', 'z']
          .map((s, i) => text(s, 80 + i * 22, y))
          .join('')
    roles =
      text(ordinary, 50, 220) +
      math(240) +
      (fault === 'equation-letter' ? text('(a)', right - 15, 260) : tag(1, 260)) +
      text(ordinary, 50, 280) +
      (fault === 'equation-orphan' ? '' : math(300) + tag(2, 320)) +
      text(ordinary, 50, 340)
  }
  if (definition) {
    const tag2 = fault === 'definition-reordered' ? '3' : fault === 'definition-missing' ? '' : '2',
      tag3 = fault === 'definition-reordered' ? '2' : '3',
      relation = fault === 'definition-no-relation' ? '+' : '>'
    roles =
      text(ordinary, 50, 230) +
      text('(1)', 50, 244) +
      text(`x ${relation} 0 and y ${relation} 0`, 75, 244) +
      text(`(mutual), ${tag2 ? '(' + tag2 + ')' : ''}`, 175, 244) +
      text(`x ${relation} 0 and y ${relation} 0`, 50, 258) +
      text(`(opposed), and (${tag3})`, 159, 258) +
      text(`x ${relation} 0 and y ${relation} 0`, 50, 272) +
      text('(mixed)', 159, 272) +
      text(
        fault === 'definition-annotation'
          ? 'Task: complete measurement labels follow here.'
          : ordinary,
        50,
        286
      )
    if (fault === 'definition-unbracketed') roles = roles.replace(text(ordinary, 50, 230), '')
  }
  const prose = paragraph
    .map(
      (y, index) =>
        ((equation || definition) && index >= 3 && index <= 5
          ? index === 3
            ? roles
            : ''
          : (index === 3 && section ? roles : '') +
            (index === 3 && fault.startsWith('wrapped-citation-')
              ? text('Ordinary body prose continues', 50, y) +
                text(fault === 'wrapped-citation-no-relation' ? '+' : '=', 205, y, 'I')
              : index === 4 && fault.startsWith('wrapped-citation-')
                ? `BT /I 11 Tf 1 0 0 1 50 ${700 - y} Tm (W) Tj /R 11 Tf <28> Tj /I 11 Tf (x) Tj /R 11 Tf <29> Tj ET ` +
                  text('[38],', 85, y) +
                  text('ordinary prose follows.', 120, y)
                : index === 4 &&
                    (fault.startsWith('argument-') || fault.startsWith('math-citation-'))
                  ? text(fault === 'math-citation-annotation' ? 'Task:' : 'For', 50, y) +
                    `BT /I 11 Tf 1 0 0 1 80 ${700 - y} Tm ` +
                    (fault === 'argument-standalone' || fault === 'math-citation-standalone'
                      ? ''
                      : '(x) Tj ') +
                    (fault === 'argument-wide-gap' ? '10 0 Td ' : '') +
                    '/R 11 Tf ((0)) Tj ' +
                    (fault === 'argument-standalone' || fault === 'math-citation-standalone'
                      ? ''
                      : '/I 11 Tf (|) Tj /R 11 Tf ' +
                        `(${fault === 'argument-no-relation' || fault === 'math-citation-no-relation' ? '+' : '='} y) Tj `) +
                    'ET ' +
                    (fault.startsWith('math-citation-')
                      ? text('[38],', 120, y) + text('ordinary prose follows.', 151, y)
                      : text('ordinary prose follows.', 125, y))
                  : index === 4 &&
                      [
                        'inline-italic',
                        'italic-task',
                        'split-task',
                        'split-legend',
                        'inline-parenthetical',
                        'standalone-parenthetical',
                        'inline-emphasis',
                        'isolated-emphasis',
                        'citation-list',
                        'citation-range',
                        'citation-line-end',
                        'citation-letter',
                        'citation-standalone'
                      ].includes(fault)
                    ? `BT /R 11 Tf 1 0 0 1 50 ${700 - y} Tm ` +
                      (fault === 'inline-italic'
                        ? '(Ordinary body prose continues ) Tj /I 11 Tf (the tail) Tj '
                        : fault === 'inline-emphasis' || fault === 'isolated-emphasis'
                          ? '(Ordinary prose ) Tj /I 11 Tf (the phrase) Tj '
                          : fault === 'inline-parenthetical'
                            ? '(Ordinary body prose continues ) Tj ET ' +
                              text('(mutual), (2)', 201, y) +
                              'BT '
                            : fault === 'standalone-parenthetical'
                              ? '((value)) Tj '
                              : fault.startsWith('citation-')
                                ? (fault === 'citation-standalone'
                                    ? ''
                                    : '(Ordinary body prose continues ) Tj ET ') +
                                  text(
                                    fault === 'citation-range'
                                      ? '[12-14]'
                                      : fault === 'citation-letter'
                                        ? '[a]'
                                        : '[12, 14]',
                                    fault === 'citation-standalone' ? 100 : 202,
                                    y
                                  ) +
                                  'BT '
                                : fault === 'italic-task'
                                  ? '/I 11 Tf (Task: ordinary prose continues here.) Tj '
                                  : fault === 'split-task'
                                    ? '(Ta) Tj /I 11 Tf (sk: ordinary prose continues here.) Tj '
                                    : '(Leg) Tj /I 11 Tf (end: ordinary prose continues here.) Tj ') +
                      'ET'
                    : `BT /R 11 Tf 1 0 0 1 50 ${700 - y} Tm (` +
                      (index === 4 && /^(?:Task|Legend|Prediction|Target|Panel)$/u.test(fault)
                        ? `${fault}: Ordinary labels continue in this column.`
                        : 'Ordinary narrative continues in this column.') +
                      ') Tj ET ')) +
        (index === 5
          ? (fault.startsWith('wrapped-citation-')
              ? 'BT /R 7 Tf 1 0 0 1 80 363 Tm (a) Tj 1 0 0 1 80 350 Tm (b) Tj ET '
              : 'BT /R 7 Tf 1 0 0 1 80 433 Tm (a) Tj 1 0 0 1 80 420 Tm (b) Tj ET ') +
            (fault === 'external-marker' ? 'BT /R 10 Tf 1 0 0 1 70 390 Tm (Value) Tj ET ' : '')
          : '')
    )
    .join(' ')
    .replace(fault === 'isolated-emphasis' ? text(ordinary, 50, 280) : '\u0000', '')
    .replace(fault === 'isolated-emphasis' ? text(ordinary, 50, 308) : '\u0000', '')
  const body =
    prose +
    (fault === 'ambiguous-row' ? 'BT /R 7 Tf 1 0 0 1 80 544.25 Tm (x) Tj ET ' : '') +
    (fault === 'gutter-annotation' ? 'BT /R 10 Tf 1 0 0 1 280 420 Tm (key) Tj ET ' : '') +
    `q ${fault === 'wide-path' ? 80 : 0.5} w ${prior} S Q q /Picture Do Q ` +
    (fault === 'between-group-caption'
      ? 'BT /R 11 Tf 1 0 0 1 50 406 Tm (Task: complete external measurement labels.) Tj ET '
      : '') +
    'BT /R 10 Tf 1 0 0 1 320 280 Tm (Figure 1. Complete measured sample responses.) Tj ' +
    (fault.startsWith('shared-')
      ? (fault === 'shared-no-font' ? '' : '/R 11 Tf ') +
        [460, 474, 488]
          .map(
            (y, index) =>
              (fault === 'shared-no-position' && index === 0 ? '' : `1 0 0 1 50 ${700 - y} Tm `) +
              '(' +
              (fault === 'shared-nonbody'
                ? 'Task: measurement labels continue in this column.'
                : 'Ordinary narrative continues in this column.') +
              ') Tj '
          )
          .join('') +
        'ET '
      : 'ET ') +
    (fault === 'post-caption-body'
      ? [460, 474, 488]
          .map(
            (y) =>
              `BT /R 11 Tf 1 0 0 1 50 ${700 - y} Tm (Ordinary narrative continues in this column.) Tj ET`
          )
          .join(' ')
      : '')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R /I 7 0 R >> /XObject << /Picture 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(body),
    stream(
      form,
      '/Type /XObject /Subtype /Form /BBox [320 300 560 460] /Group << /S /Transparency /I false /K false >> /Resources << /Font << /R 4 0 R >> >>'
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>'
  ]
  return captureAnonymousVerticalFigure(objects)
}
