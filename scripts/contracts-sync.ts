#!/usr/bin/env bun
// Copies contracts/feed-events/*.json into the iOS repo's test fixtures so
// both sides decode the same bytes. Refuses when the iOS repo is absent —
// never creates a stray "~/apps/claude companion" tree on a host without it.
// Usage: bun run contracts:sync

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CONTRACT_FIXTURES_DIR = join(import.meta.dir, "..", "contracts", "feed-events")
export const IOS_REPO_DIR = join(homedir(), "apps", "claude companion")
export const IOS_FIXTURES_DIR = join(IOS_REPO_DIR, "claude companionTests", "Fixtures", "feed-events")

export function listFixtures(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
}

function sync(): void {
  if (!existsSync(IOS_REPO_DIR)) {
    console.error(`contracts:sync — iOS repo not found at ${IOS_REPO_DIR}; refusing.`)
    process.exit(1)
  }
  mkdirSync(IOS_FIXTURES_DIR, { recursive: true })
  const ours = listFixtures(CONTRACT_FIXTURES_DIR)
  // Drop fixtures we no longer ship so the file sets stay identical.
  for (const f of listFixtures(IOS_FIXTURES_DIR)) {
    if (!ours.includes(f)) rmSync(join(IOS_FIXTURES_DIR, f))
  }
  for (const f of ours) copyFileSync(join(CONTRACT_FIXTURES_DIR, f), join(IOS_FIXTURES_DIR, f))
  console.log(`contracts:sync — ${ours.length} fixtures → ${IOS_FIXTURES_DIR}`)
}

if (import.meta.main) sync()
