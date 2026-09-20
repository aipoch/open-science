// A real one-page PDF with a byte-accurate cross-reference table, parsed by production PDF.js.
export const createTestPdf = (label = 'first'): Buffer => {
  let text = `%PDF-1.4\n%${label}\n`
  const offsets = [0]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>'
  ]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(text))
    text += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 4\n0000000000 65535 f \n'
  text += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  text += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}
