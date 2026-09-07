import { describe, expect, it } from 'vitest'

import { parseLiteraturePdfMetadata } from './literature-pdf-metadata'

describe('parseLiteraturePdfMetadata', () => {
  it('prefers embedded metadata and extracts stable literature identifiers from page text', () => {
    expect(
      parseLiteraturePdfMetadata(
        {
          Title: 'Mapping cancer origins',
          Author: 'Richard J Gilbertson; Jane Doe',
          CreationDate: 'D:20110401',
          Custom: { Journal: 'Cell', DOI: '10.1234/example' }
        },
        'https://doi.org/10.1234/ignoredCopyright PMID: 21458665'
      )
    ).toEqual({
      title: 'Mapping cancer origins',
      creators: [
        {
          nameMode: 'person',
          givenName: '',
          familyName: 'Richard J Gilbertson',
          creatorType: 'author'
        },
        {
          nameMode: 'person',
          givenName: '',
          familyName: 'Jane Doe',
          creatorType: 'author'
        }
      ],
      containerTitle: 'Cell',
      issuedYear: 2011,
      issuedText: '2011',
      url: 'https://doi.org/10.1234/example',
      identifiers: [
        { scheme: 'doi', value: '10.1234/example', isPrimary: true },
        { scheme: 'pmid', value: '21458665', isPrimary: false }
      ]
    })
  })

  it('does not include adjacent copyright text in an extracted DOI', () => {
    expect(parseLiteraturePdfMetadata({}, '10.1234/exampleCopyright 2020 Publisher')).toMatchObject(
      {
        url: 'https://doi.org/10.1234/example',
        identifiers: [{ scheme: 'doi', value: '10.1234/example', isPrimary: true }]
      }
    )
  })
})
