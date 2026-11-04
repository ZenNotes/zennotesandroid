import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'

/** The alpha channel of an 8-bit RGBA PNG, row by row. */
function alphaRows(file: Buffer): Uint8Array[] {
  const width = file.readUInt32BE(16)
  const height = file.readUInt32BE(20)
  assert.deepEqual([file[24], file[25], file[28]], [8, 6, 0], '8-bit RGBA, not interlaced')
  const idat: Buffer[] = []
  for (let at = 8; at < file.length; at += 12 + file.readUInt32BE(at)) {
    if (file.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(file.subarray(at + 8, at + 8 + file.readUInt32BE(at)))
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0
      const b = y ? pixels[(y - 1) * stride + x]! : 0
      const c = x >= 4 && y ? pixels[(y - 1) * stride + x - 4]! : 0
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + predicted) & 255
    }
  }
  return Array.from({ length: height }, (_, y) => Uint8Array.from({ length: width }, (_, x) => pixels[(y * width + x) * 4 + 3]!))
}

const rows = alphaRows(readFileSync(new URL('../assets/enso.png', import.meta.url)))

test('the ensō has nothing above its ring: a faint band there showed on light themes', () => {
  for (const row of rows.slice(0, 16)) assert.ok(row.every((alpha) => alpha === 0))
})

test('the ring itself is still there', () => {
  const solid = rows.flatMap((row) => [...row].filter((alpha) => alpha === 255)).length
  assert.ok(solid > 5000, `${solid} opaque pixels`)
})
