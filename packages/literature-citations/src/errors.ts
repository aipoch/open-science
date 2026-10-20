/** Domain validation failure. The application maps this code at its command boundary. */
export class CitationStyleError extends Error {
  constructor(
    readonly code:
      | 'csl-file-too-large'
      | 'csl-invalid-xml'
      | 'csl-unsupported-doctype'
      | 'csl-unsupported-style'
      | 'csl-missing-metadata'
      | 'csl-dependent-style'
      | 'csl-undefined-macro'
      | 'csl-missing-sections',
    message: string,
    readonly parameters?: Readonly<{ macro: string }>
  ) {
    super(message)
    this.name = 'CitationStyleError'
  }
}
