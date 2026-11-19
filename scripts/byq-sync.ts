#!/usr/bin/env bun
// Regenerate canvas-lib/byq/manifest.json from the slugs it lists, and copy
// those BYQ sources into the gitignored canvas-lib/byq/src/<slug>/ (canvas
// auto-layout S1, server/lib/byq.ts). Reads the private mirror ($BYQ_LIB or
// ~/work/byq-lib); a slug missing there must be fetched into it first
// (BYQ Supply MCP get_byq_component / get_byq_gem, see the mirror's README).
// Add a section: append {"slug", "kind"} to items, run `bun scripts/byq-sync.ts`.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BYQ_MANIFEST, BYQ_MANIFEST_PATH, type ByqManifestItem, byqIndex, byqLibDir, byqThumb, thumbHash } from "../server/lib/byq"

const SRC_DIR = join(import.meta.dir, "../canvas-lib/byq/src")
const lib = byqLibDir()
const failures: string[] = []

const items: ByqManifestItem[] = []
for (const { slug, kind } of BYQ_MANIFEST.items) {
  const thumb = `${kind}-${slug}`
  const entry = byqIndex().get(thumb)
  if (!entry?.path) { failures.push(`${slug}: not in ${lib} (fetch it first)`); continue }
  const dir = join(lib, entry.path)
  const tsx = readdirSync(dir).filter((f) => f.endsWith(".tsx"))
  if (tsx.length !== 1) { failures.push(`${slug}: expected one .tsx, found ${tsx.length}`); continue }
  const file = tsx[0]!
  const src = readFileSync(join(dir, file), "utf8")
  const deps = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((d) => d !== "react")
  if (deps.length) { failures.push(`${slug}: imports ${deps.join(", ")} (react only in v1)`); continue }
  let meta: { name?: string; category?: string[]; componentName?: string }
  try { meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) } catch { failures.push(`${slug}: unreadable meta.json`); continue }
  const out = join(SRC_DIR, slug)
  mkdirSync(out, { recursive: true })
  copyFileSync(join(dir, file), join(out, file))
  if (existsSync(join(dir, "item.md"))) copyFileSync(join(dir, "item.md"), join(out, "item.md"))
  const t = await byqThumb(thumb)
  if (!t) failures.push(`${slug}: no thumbnail (kept, thumbHash null)`)
  items.push({
    slug,
    kind,
    name: meta.name ?? slug,
    category: meta.category?.[0] ?? "",
    component: meta.componentName ?? file.replace(/\.tsx$/, ""),
    file,
    fonts: [...src.matchAll(/@fonts\s+(.+)/g)].map((m) => m[1]!.trim()),
    thumb,
    thumbHash: t ? thumbHash(t.path) : null,
  })
}

writeFileSync(BYQ_MANIFEST_PATH, `${JSON.stringify({ ...BYQ_MANIFEST, items }, null, 2)}\n`)
console.log(`byq-sync: ${items.length}/${BYQ_MANIFEST.items.length} items → ${BYQ_MANIFEST_PATH}, sources → ${SRC_DIR}`)
for (const f of failures) console.error(`  ! ${f}`)
if (items.length < BYQ_MANIFEST.items.length) process.exit(1)
