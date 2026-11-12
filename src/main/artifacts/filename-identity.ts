// Used for logical lineage and write serialization, never for on-disk metadata keys.
// JavaScript has no native toCaseFold. These additional folds cover sharp-s and final sigma.
const normalizeArtifactFilename = (filename: string): string =>
  filename
    .normalize('NFC')
    .toLocaleLowerCase('und')
    .replace(/\u00df/gu, 'ss')
    .replace(/\u03c2/gu, '\u03c3')

export { normalizeArtifactFilename }
