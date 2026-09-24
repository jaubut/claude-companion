#!/usr/bin/env bun
// Copies contracts/feed-events/*.json into the iOS repo's test fixtures so
// both sides decode the same bytes. Refuses when the iOS repo is absent —
// never creates a stray "~/apps/claude companion" tree on a host without it.
// Usage: bun run contracts:sync [--to <dir>]   (--to: e.g. a worktree of the iOS repo)

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CONTRACT_FIXTURES_DIR = join(import.meta.dir, "..", "contracts", "feed-events")
export const IOS_REPO_DIR = join(homedir(), "apps", "claude companion")
export const IOS_FIXTURES_DIR = join(IOS_REPO_DIR, "claude companionTests", "Fixtures", "feed-events")

export function listFixtures(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
}

export function fixturesDirFor(iosRepoDir: string): string {
  return join(iosRepoDir, "claude companionTests", "Fixtures", "feed-events")
}

function sync(args: string[]): void {
  const toIdx = args.indexOf("--to")
  const iosRepo = toIdx >= 0 ? args[toIdx + 1] : IOS_REPO_DIR
  if (!iosRepo || !existsSync(iosRepo)) {
    console.error(`contracts:sync — iOS repo not found at ${iosRepo ?? "(--to needs a value)"}; refusing.`)
    process.exit(1)
  }
  const target = fixturesDirFor(iosRepo)
  mkdirSync(target, { recursive: true })
  const ours = listFixtures(CONTRACT_FIXTURES_DIR)
  // Drop fixtures we no longer ship so the file sets stay identical — say which.
  for (const f of listFixtures(target)) {
    if (!ours.includes(f)) {
      rmSync(join(target, f))
      console.log(`contracts:sync — removed stale ${f}`)
    }
  }
  for (const f of ours) copyFileSync(join(CONTRACT_FIXTURES_DIR, f), join(target, f))
  console.log(`contracts:sync — ${ours.length} fixtures → ${target}`)
}

if (import.meta.main) sync(process.argv.slice(2))
