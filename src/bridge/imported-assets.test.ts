import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assetUploadOptions } from './remote-client.ts'
import { importedAssetMarkdown, importedAssetRelPath } from './imported-assets.ts'

describe('importedAssetRelPath', () => {
  it('puts an attached file in assets/, never the vault root', () => {
    // The bug: attach wrote to the vault root, scattering images among the
    // notes, while paste and the cloud upload both used assets/.
    assert.equal(importedAssetRelPath('shape_image 18.jpg'), 'assets/shape_image 18.jpg')
    assert.equal(importedAssetRelPath('report.pdf'), 'assets/report.pdf')
  })
})

describe('importedAssetMarkdown', () => {
  it('links an image the same way a pasted image is linked', () => {
    const rel = importedAssetRelPath('diagram.png')
    assert.equal(importedAssetMarkdown(rel, 'diagram.png', 'image'), '![[assets/diagram.png]]')
  })

  it('never emits a note-relative ../ path', () => {
    const markdown = importedAssetMarkdown(
      importedAssetRelPath('shape_image 18.jpg'),
      'shape_image 18.jpg',
      'image'
    )
    assert.equal(markdown, '![[assets/shape_image 18.jpg]]')
    assert.ok(!markdown.includes('../'))
  })

  it('angle-brackets a non-image link so a space cannot break it', () => {
    const rel = importedAssetRelPath('year end.pdf')
    assert.equal(importedAssetMarkdown(rel, 'year end.pdf', 'pdf'), '[year end.pdf](<assets/year end.pdf>)')
  })

  it('escapes a closing angle bracket in the path', () => {
    assert.equal(
      importedAssetMarkdown('assets/we>ird.zip', 'we>ird.zip', 'file'),
      '[we>ird.zip](<assets/we%3Eird.zip>)'
    )
  })
})

describe('assetUploadOptions', () => {
  const options = assetUploadOptions({
    url: 'https://notes.example.test/api/assets/upload',
    fileName: 'diagram.png',
    base64Data: 'AQID',
    targetDir: 'assets'
  })

  it('sends the file as a native base64File part, not as base64 text in the body', () => {
    // The bug: the body was hand-built with `Content-Transfer-Encoding: base64`,
    // which multipart/form-data parsers ignore (RFC 7578), so Go wrote the
    // base64 TEXT to disk as the file's bytes and every attachment was corrupt.
    assert.equal(options.dataType, 'formData')
    assert.deepEqual(options.data, [
      { type: 'string', key: 'dir', value: 'assets' },
      {
        type: 'base64File',
        key: 'file',
        fileName: 'diagram.png',
        contentType: 'application/octet-stream',
        value: 'AQID'
      }
    ])
    assert.equal(typeof options.data, 'object')
  })

  it('declares the boundary its body will be written with', () => {
    const contentType = options.headers['Content-Type']
    assert.match(contentType, /^multipart\/form-data; boundary=----ZenNotesUpload[0-9a-f]+$/)
  })

  it('strips quotes from the filename so the part header cannot be broken', () => {
    const quoted = assetUploadOptions({
      url: 'https://notes.example.test/api/assets/upload',
      fileName: 'we"ird".png',
      base64Data: 'AQID'
    })
    const file = quoted.data[1] as { fileName: string }
    assert.equal(file.fileName, 'weird.png')
  })

  it('defaults the target directory to empty rather than sending undefined', () => {
    const bare = assetUploadOptions({
      url: 'https://notes.example.test/api/assets/upload',
      fileName: 'a.png',
      base64Data: 'AQID'
    })
    assert.deepEqual(bare.data[0], { type: 'string', key: 'dir', value: '' })
  })
})
