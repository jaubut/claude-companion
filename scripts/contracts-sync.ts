#!/usr/bin/env bun
// Copies contracts/feed-events/*.json and contracts/brain/*.json into the iOS repo's test fixtures so
// both sides decode the same bytes. Refuses when the iOS repo is absent —
// never creates a stray "~/apps/claude companion" tree on a host without it.
// Usage: bun run contracts:sync [--to <dir>]   (--to: e.g. a worktree of the iOS repo)

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CONTRACT_FIXTURES_DIR = join(import.meta.dir, "..", "contracts", "feed-events")
export const IOS_REPO_DIR = join(homedir(), "apps", "claude companion")
export const IOS_FIXTURES_DIR = join(IOS_REPO_DIR, "claude companionTests", "Fixtures", "feed-events")
/** brain-v2 frames (docs/brain-api.md) → `Fixtures/brain/`. */
export const BRAIN_FIXTURES_DIR = join(import.meta.dir, "..", "contracts", "brain")

export function listFixtures(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
}

export function fixturesDirFor(iosRepoDir: string, set = "feed-events"): string {
  return join(iosRepoDir, "claude companionTests", "Fixtures", set)
}

/** Mirror one fixture set: same file names, same bytes; a fixture we no longer ship is removed. */
function syncSet(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  const ours = listFixtures(source)
  // Drop fixtures we no longer ship so the file sets stay identical — say which.
  for (const f of listFixtures(target)) {
    if (!ours.includes(f)) {
      rmSync(join(target, f))
      console.log(`contracts:sync — removed stale ${f}`)
    }
  }
  for (const f of ours) copyFileSync(join(source, f), join(target, f))
  console.log(`contracts:sync — ${ours.length} fixtures → ${target}`)
}

function sync(args: string[]): void {
  const toIdx = args.indexOf("--to")
  const iosRepo = toIdx >= 0 ? args[toIdx + 1] : IOS_REPO_DIR
  if (!iosRepo || !existsSync(iosRepo)) {
    console.error(`contracts:sync — iOS repo not found at ${iosRepo ?? "(--to needs a value)"}; refusing.`)
    process.exit(1)
  }
  syncSet(CONTRACT_FIXTURES_DIR, fixturesDirFor(iosRepo))
  syncSet(BRAIN_FIXTURES_DIR, fixturesDirFor(iosRepo, "brain"))
}

if (import.meta.main) sync(process.argv.slice(2))
