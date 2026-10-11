/* eslint-disable @typescript-eslint/explicit-function-return-type -- Worker-only native helper. */
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from 'pdf-lib'

// Publishers sometimes wrap an entire page in one scaled Form. Expose only
// unambiguous page containers; ordinary figures and transparency groups stay Forms.
export async function unwrapPageContainers(e, doc, data, pageCount, selectedPages) {
  const p = e.p
  let metadata
  const at = e.alloc(24)
  try {
    for (let index = 0; index < pageCount; index++) {
      if (selectedPages && !selectedPages.has(index + 1)) continue
      const page = p.FPDF_LoadPage(doc, index)
      if (!page) throw Error('Could not open PDF page container')
      try {
        const objects = e.objects(page),
          forms = objects.filter((o) => o.type === 5)
        if (forms.length !== 1) continue
        metadata ??= await PDFDocument.load(data, { updateMetadata: false })
        const node = metadata.getPages()[index].node,
          resources = node.Resources()
        const xobjects = resources?.lookup(PDFName.of('XObject'))
        if (
          !(xobjects instanceof PDFDict) ||
          xobjects.entries().length !== 1 ||
          (resources.lookup(PDFName.of('ExtGState'))?.entries?.().length ?? 0) > 0
        )
          continue
        const raw = metadata.context.lookup(xobjects.entries()[0][1])
        if (
          !(raw instanceof PDFRawStream) ||
          raw.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form' ||
          raw.dict.has(PDFName.of('OC'))
        )
          continue
        const group = raw.dict.lookup(PDFName.of('Group'))
        if (
          group &&
          (!(group instanceof PDFDict) ||
            group.lookup(PDFName.of('S'))?.toString() !== '/Transparency' ||
            group.lookup(PDFName.of('I'))?.toString() === 'true' ||
            group.lookup(PDFName.of('K'))?.toString() === 'true' ||
            group.toString() !== node.lookup(PDFName.of('Group'))?.toString())
        )
          continue
        const bbox = raw.dict
          .lookup(PDFName.of('BBox'))
          ?.asArray?.()
          .map((v) => v.asNumber?.())
        if (
          !bbox ||
          bbox.length !== 4 ||
          !bbox.every(Number.isFinite) ||
          bbox[2] <= bbox[0] ||
          bbox[3] <= bbox[1]
        )
          continue
        const form = forms[0]
        if (
          p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(form.obj)) !== -1 ||
          !p.FPDFPageObj_GetMatrix(form.obj, at)
        )
          continue
        const matrix = [...e.m.HEAPF32.slice(at / 4, at / 4 + 6)]
        if (
          !matrix.every(Number.isFinite) ||
          matrix[0] <= 0 ||
          matrix[3] <= 0 ||
          matrix[1] !== 0 ||
          matrix[2] !== 0
        )
          continue
        const clip = [
          bbox[0] * matrix[0] + matrix[4],
          bbox[1] * matrix[3] + matrix[5],
          bbox[2] * matrix[0] + matrix[4],
          bbox[3] * matrix[3] + matrix[5]
        ]
        // Only a page-sized wrapper is eligible. An isolated chart or logo keeps
        // its own paint and clipping boundary even when it contains native labels.
        if (
          clip[2] - clip[0] < p.FPDF_GetPageWidthF(page) * 0.7 ||
          clip[3] - clip[1] < p.FPDF_GetPageHeightF(page) * 0.7
        )
          continue
        // Page-level clipping must not hide a sibling (e.g. an arXiv margin label).
        if (
          objects.some(
            (o) =>
              o !== form &&
              (o.bounds[0] < clip[0] ||
                o.bounds[1] < clip[1] ||
                o.bounds[2] > clip[2] ||
                o.bounds[3] > clip[3])
          )
        )
          continue
        const count = p.FPDFFormObj_CountObjects(form.obj)
        if (count <= 0 || count > 100000) continue
        const children = Array.from({ length: count }, (_, i) =>
          p.FPDFFormObj_GetObject(form.obj, i)
        )
        // A page container contains native body text; a lone chart/image stays protected.
        if (children.filter((o) => p.FPDFPageObj_GetType(o) === 1).length < 2) continue
        for (const object of objects)
          if (!p.FPDFPage_RemoveObject(page, object.obj))
            throw Error('Could not detach PDF container')
        for (const object of objects) {
          if (object !== form) {
            p.FPDFPage_InsertObject(page, object.obj)
            continue
          }
          for (const child of children) {
            if (!p.FPDFFormObj_RemoveObject(form.obj, child))
              throw Error('Could not detach PDF content')
            p.FPDFPageObj_Transform(child, ...matrix)
            p.FPDFPageObj_TransformClipPath(child, ...matrix)
            p.FPDFPage_InsertObject(page, child)
          }
          p.FPDFPageObj_Destroy(form.obj)
        }
        if (!p.FPDFPage_GenerateContent(page)) throw Error('Could not generate PDF page content')
        const path = p.FPDF_CreateClipPath(...clip)
        if (!path) throw Error('Could not preserve PDF page clip')
        try {
          p.FPDFPage_InsertClipPath(page, path)
        } finally {
          p.FPDF_DestroyClipPath(path)
        }
      } finally {
        p.FPDF_ClosePage(page)
      }
    }
  } finally {
    e.free(at)
  }
}
