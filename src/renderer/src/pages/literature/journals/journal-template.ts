export const downloadJournalTemplate = async (fail: (error: unknown) => void): Promise<void> => {
  try {
    const spreadsheet = await import('styled-exceljs')
    const workbook = spreadsheet.utils.book_new()
    spreadsheet.utils.book_append_sheet(
      workbook,
      spreadsheet.utils.aoa_to_sheet([
        [
          'Journal name',
          'Alias',
          'ISSN',
          'eISSN',
          'Custom attribute 1',
          'Custom attribute 2',
          'Custom attribute 3'
        ]
      ]),
      'Journal data'
    )
    spreadsheet.utils.book_append_sheet(
      workbook,
      spreadsheet.utils.aoa_to_sheet([
        ['How to fill this template'],
        ['One journal per row. Keep the first row as the header.'],
        ['Journal name', 'Use the journal title when ISSN/eISSN is unavailable.'],
        ['Alias', 'Optional abbreviation or alternate journal title.'],
        ['ISSN / eISSN', 'Use the 8-digit identifier, with or without a hyphen.'],
        ['JIF', 'Enter a number, for example 3.2.'],
        ['JCR quartile / Scopus quartile', 'Use Q1, Q2, Q3 or Q4.'],
        [
          'Custom attributes',
          'Rename the custom attribute columns or add more columns using the names from your source.'
        ],
        ['Categorical values', 'Values such as Q1–Q4 or 1区–4区 can be color-tagged after import.'],
        [
          'External provider IDs',
          'Optional advanced fields. They only match records that already contain the same ID; no ID is looked up automatically.'
        ],
        ['Notes', 'Optional free text; it is not used for matching.'],
        ['Metric year', 'Choose the year in the import screen; it applies to the whole file.'],
        [
          'Matching order',
          'External ID when both sides have it → ISSN/eISSN → journal name and aliases.'
        ],
        ['Before importing', 'Remove any example rows and review the column mapping.']
      ]),
      'Instructions'
    )
    spreadsheet.utils.book_append_sheet(
      workbook,
      spreadsheet.utils.aoa_to_sheet([
        [
          'Journal name',
          'Alias',
          'ISSN',
          'eISSN',
          'Custom attribute 1',
          'Custom attribute 2',
          'Custom attribute 3'
        ],
        ['Example Journal Alpha', 'EJA', '1234-5679', '2345-6785', '3.2', 'Q1', '1区']
      ]),
      'Example'
    )
    const bytes = spreadsheet.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    await window.api.saveBlobFile({
      suggestedName: 'journal-attributes-template.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: bytes
    })
  } catch (error) {
    fail(error)
  }
}
