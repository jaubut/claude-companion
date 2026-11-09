import { guardFetch, testDbUrl } from "./turso-test-guard.test-util"

// bunfig.toml [test] preload: runs before any test file evaluates, for every file under --isolate. A throw
// here fails the run with no test file loaded. Bypass ceiling: the wrap covers globalThis.fetch, the only
// transport turso.ts uses (pinned by a test). Bun.fetch is read-only, so it can't be wrapped; it, node:https
// or a spawned curl would go around this, and CI holds no production credential.

const { TURSO_TEST_URL: url, TURSO_TEST_AUTH_TOKEN: token, TURSO_TEST_REQUIRED: required } = process.env
if (url) testDbUrl(url)
if (required && (!url || !token)) throw new Error("refused: TURSO_TEST_URL and TURSO_TEST_AUTH_TOKEN are missing; the PR that added the integration job has the commands that set them")

// Production's env never reaches a test or its children, and a set token keeps turso.ts off the agent token file.
process.env.TURSO_AUTH_TOKEN = "test-token"
delete process.env.TURSO_DATABASE_URL
globalThis.fetch = guardFetch(globalThis.fetch)
