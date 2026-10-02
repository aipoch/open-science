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

it('extracts a structured abstract without an Abstract heading and stops before the body', () => {
  const text =
    'A publication\n\nBackground: We assessed measured responses in a controlled experiment.\n\nMethods: Samples were compared with controls.\n\nResults: Responses increased in the study group.\n\nConclusions: These observations support the proposed mechanism.\n\nBody paragraphs describe the full experiment.'
  const result = parseLiteraturePdfMetadata({}, text)
  expect(result.abstract).toContain('Background:')
  expect(result.abstract).toContain('Conclusions:')
  expect(result.abstract).not.toContain('Body paragraphs')
})

it('extracts a headed abstract with an explicit introduction boundary', () => {
  const text =
    'Abstract\nWe measured a series of samples and compared their responses with a control group. The results support a reproducible association.\n1. Introduction\nThis is body text.'
  expect(parseLiteraturePdfMetadata({}, text).abstract).toBe(
    'We measured a series of samples and compared their responses with a control group. The results support a reproducible association.'
  )
})

it('does not fabricate an abstract from an unbounded heading or DOI from References', () => {
  expect(
    parseLiteraturePdfMetadata(
      {},
      'Abstract\nAmbiguous body text without an end boundary.\nReferences\n10.1234/cited'
    )
  ).toEqual({})
})

it('does not turn a PDF creation date or filename title into publication metadata', () => {
  expect(
    parseLiteraturePdfMetadata(
      { Title: 'article.pdf', CreationDate: 'D:20260101', ModDate: 'D:20260102' },
      ''
    )
  ).toEqual({})
  expect(parseLiteraturePdfMetadata({ PublicationDate: '2018-01-25' }, '')).toMatchObject({
    issuedYear: 2018,
    issuedText: '2018'
  })
})
