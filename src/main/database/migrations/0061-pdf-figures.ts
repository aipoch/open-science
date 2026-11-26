// Immutable additive snapshot. Figures share the owning annotation's deletion lifecycle.
const pdfFiguresMigration = {
  id: '0061_pdf_figures',
  statements: [
    `CREATE TABLE IF NOT EXISTS "PdfFigure" (
      "annotationId" TEXT NOT NULL PRIMARY KEY,
      "literatureVersionId" TEXT NOT NULL,
      "imageData" TEXT NOT NULL,
      "figureNumber" TEXT NOT NULL DEFAULT '',
      "caption" TEXT NOT NULL DEFAULT '',
      CONSTRAINT "PdfFigure_literatureVersionId_fkey" FOREIGN KEY ("literatureVersionId") REFERENCES "LiteratureAttachmentVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "PdfFigure_annotationId_fkey" FOREIGN KEY ("annotationId") REFERENCES "PdfAnnotation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`
  ],
  operations: [],
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'PdfFigure' },
    { kind: 'foreign-key-integrity', version: 1 }
  ]
} as const
export { pdfFiguresMigration }
