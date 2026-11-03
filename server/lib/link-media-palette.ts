import sharp from "sharp"

// Dominant colours for bin/media (lib/link-media.ts): every image is shrunk to
// 64x64, the pixels pooled, then k-means (k=6, deterministic init) over RGB.

export interface Swatch { hex: string; share: number }

const SIDE = 64
const ITERATIONS = 12

async function pixels(path: string): Promise<Uint8Array> {
  const { data } = await sharp(path).removeAlpha().resize(SIDE, SIDE, { fit: "fill", kernel: "nearest" }).raw().toBuffer({ resolveWithObject: true })
  return new Uint8Array(data)
}

const hex = (c: number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`

/** k-means over packed RGB triples; returns swatches sorted by share, biggest first. */
export function kmeans(px: Uint8Array, k = 6): Swatch[] {
  const n = px.length / 3
  if (!n) return []
  // Init: k pixels spread evenly through the luma-sorted list.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => luma(px, a) - luma(px, b))
  let centres = Array.from({ length: k }, (_, j) => {
    const i = order[Math.floor(((j + 0.5) * n) / k)]! * 3
    return [px[i]!, px[i + 1]!, px[i + 2]!]
  })
  const label = new Int32Array(n)
  for (let it = 0; it < ITERATIONS; it++) {
    const sum = centres.map(() => [0, 0, 0, 0])
    for (let p = 0; p < n; p++) {
      const r = px[p * 3]!, g = px[p * 3 + 1]!, b = px[p * 3 + 2]!
      let best = 0, bestD = Infinity
      for (let c = 0; c < centres.length; c++) {
        const cc = centres[c]!
        const d = (r - cc[0]!) ** 2 + (g - cc[1]!) ** 2 + (b - cc[2]!) ** 2
        if (d < bestD) { bestD = d; best = c }
      }
      label[p] = best
      const s = sum[best]!
      s[0]! += r; s[1]! += g; s[2]! += b; s[3]! += 1
    }
    centres = sum.map((s, c) => (s[3]! ? [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] : centres[c]!))
  }
  const counts = new Array<number>(centres.length).fill(0)
  for (let p = 0; p < n; p++) counts[label[p]!]! += 1
  // Merge clusters that land on the same hex (flat images).
  const byHex = new Map<string, number>()
  centres.forEach((c, i) => { if (counts[i]) byHex.set(hex(c), (byHex.get(hex(c)) ?? 0) + counts[i]!) })
  return [...byHex].map(([h, cnt]) => ({ hex: h, share: Math.round((cnt / n) * 1000) / 1000 })).sort((a, b) => b.share - a.share)
}

function luma(px: Uint8Array, i: number): number {
  return 0.299 * px[i * 3]! + 0.587 * px[i * 3 + 1]! + 0.114 * px[i * 3 + 2]!
}

/** Six dominant colours across all the given image files. */
export async function palette(paths: string[], k = 6): Promise<Swatch[]> {
  const parts = await Promise.all(paths.map(pixels))
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let off = 0
  for (const p of parts) { all.set(p, off); off += p.length }
  return kmeans(all, k)
}
