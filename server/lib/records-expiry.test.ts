import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApnsPayload } from "./apns"
import { alertBody, alertDue, alertsPath, checkRecordExpiry, daysUntil, expiryDeps, startRecordsExpiry } from "./records-expiry"
import { createRecord, deleteRecord, updateRecord } from "./records-store"

// Expiry schedule: window (passport 300 d, licence 60 d) → every 30 d → daily
// in the last 14 d → one alert on expiry → weekly. Clock + push are injected.

const DAY = 86_400_000
const NUM = "EXPIRY-FAKE-NUM-81P"
const DOB = "1902-03-04"
const ORIGIN = { device_claimed: "test", transport: "loopback", peer: "127.0.0.1" }
// Local noon avoids DST edges in the day arithmetic.
const T0 = new Date(2027, 0, 1, 12).getTime()

let home = ""
let now = T0
let pushes: ApnsPayload[] = []
let delivered = 1
let stderr = ""
const realHome = process.env.HOME
const realDeps = { ...expiryDeps }
const realWrite = process.stderr.write.bind(process.stderr)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "records-exp-"))
  process.env.HOME = home
  delete process.env.COMPANION_VAULT_UPSTREAM
  now = T0
  pushes = []
  delivered = 1
  expiryDeps.now = () => now
  expiryDeps.push = async (p) => { pushes.push(p); return { sent: delivered, pruned: 0, total: 1 } }
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(() => {
  process.stderr.write = realWrite
  Object.assign(expiryDeps, realDeps)
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

function dateIn(days: number): string {
  const d = new Date(T0 + days * DAY)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

async function add(type: "passport" | "driver_license", expiry: string, label?: string): Promise<string> {
  const numKey = type === "passport" ? "document_number" : "licence_number"
  const r = await createRecord({ type, label, fields: { [numKey]: NUM, date_of_birth: DOB, expiry_date: expiry } }, ORIGIN)
  if (!r.ok) throw new Error(r.error)
  return r.id
}

/** Run the daily check for `days` consecutive days; returns the day offsets that alerted. */
async function simulate(days: number, start = 0): Promise<number[]> {
  const hits: number[] = []
  for (let d = start; d < start + days; d++) {
    now = T0 + d * DAY
    if ((await checkRecordExpiry()).length) hits.push(d)
  }
  return hits
}

test("daysUntil + alertBody", () => {
  expect(daysUntil(dateIn(287), T0)).toBe(287)
  expect(daysUntil(dateIn(-3), T0)).toBe(-3)
  expect(alertBody("Passport · CA", "2027-07-16", new Date(2026, 9, 2, 12).getTime())).toBe("Passport · CA expires in 287 days (2027-07-16)")
  expect(alertBody("P", dateIn(1), T0)).toBe(`P expires tomorrow (${dateIn(1)})`)
  expect(alertBody("P", dateIn(0), T0)).toBe(`P expires today (${dateIn(0)})`)
  expect(alertBody("P", dateIn(-1), T0)).toBe(`P expired 1 day ago (${dateIn(-1)})`)
  expect(alertBody("P", dateIn(-9), T0)).toBe(`P expired 9 days ago (${dateIn(-9)})`)
})

test("alertDue: window thresholds per type", () => {
  expect(alertDue("passport", dateIn(301), undefined, T0)).toBe(false)
  expect(alertDue("passport", dateIn(300), undefined, T0)).toBe(true)
  expect(alertDue("driver_license", dateIn(61), undefined, T0)).toBe(false)
  expect(alertDue("driver_license", dateIn(60), undefined, T0)).toBe(true)
  // A renewed document (new expiry) outside the window: quiet again.
  const last = { expiry_date: dateIn(10), last_alert_at: new Date(T0).toISOString(), last_days_left: 10 }
  expect(alertDue("passport", dateIn(3000), last, T0)).toBe(false)
  // Timer firing a few minutes early still counts as a day.
  const daily = { expiry_date: dateIn(10), last_alert_at: new Date(T0 - DAY + 5 * 60_000).toISOString(), last_days_left: 11 }
  expect(alertDue("passport", dateIn(10), daily, T0)).toBe(true)
})

test("passport: 300 d window, every 30 d, daily in the last 14 d, once on expiry, then weekly", async () => {
  await add("passport", dateIn(320))
  const hits = await simulate(320 + 30)
  const expected: number[] = []
  for (let d = 20; d < 320 - 14; d += 30) expected.push(d) // 300 d left → every 30 d
  for (let d = 320 - 14; d <= 320; d++) if (!expected.includes(d)) expected.push(d) // last 14 d, daily (0 = expiry day)
  expected.push(321) // expired: one alert
  for (let d = 328; d < 350; d += 7) expected.push(d) // then weekly
  expect(hits).toEqual(expected.sort((a, b) => a - b))
})

test("driver_license: 60 d window", async () => {
  await add("driver_license", dateIn(70), "Driver licence · QC")
  const hits = await simulate(80)
  expect(hits.slice(0, 2)).toEqual([10, 40])
  expect(hits.filter((d) => d >= 56 && d <= 70)).toEqual([56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70])
  expect(hits).toContain(71)
  expect(hits.filter((d) => d > 71)).toEqual([78])
  expect(pushes[0]!.body).toBe(`Driver licence · QC expires in 60 days (${dateIn(70)})`)
})

test("already expired at first sight → one alert, then weekly", async () => {
  await add("passport", dateIn(-100))
  expect(await simulate(15)).toEqual([0, 7, 14])
})

test("push: label + date only, never numbers / DOB; log has id + type only", async () => {
  const id = await add("passport", dateIn(287), "Passport · CA")
  expect(await checkRecordExpiry()).toEqual([id])
  expect(pushes).toHaveLength(1)
  const p = pushes[0]!
  expect(p.body).toBe(`Passport · CA expires in 287 days (${dateIn(287)})`)
  expect(p.collapseId).toBe(`record-${id}`)
  const all = JSON.stringify(p)
  expect(all).not.toContain(NUM)
  expect(all).not.toContain(DOB)
  expect(stderr).toContain(`records alert ${id} passport sent=1`)
  expect(stderr).not.toContain(NUM)
  expect(stderr).not.toContain(DOB)
  expect(stderr).not.toContain("Passport · CA")
})

test("state persists across restart (no re-spam), 0600, deleted records pruned", async () => {
  const id = await add("passport", dateIn(200))
  expect(await checkRecordExpiry()).toEqual([id])
  expect(statSync(alertsPath()).mode & 0o777).toBe(0o600)
  // "Restart": the module keeps nothing in memory; the file is the state.
  now = T0 + 2 * DAY
  expect(await checkRecordExpiry()).toEqual([])
  const doc = JSON.parse(readFileSync(alertsPath(), "utf8"))
  expect(doc.alerts[id]).toMatchObject({ expiry_date: dateIn(200), last_days_left: 200 })
  expect(JSON.stringify(doc)).not.toContain(NUM)
  await deleteRecord(id, ORIGIN)
  await checkRecordExpiry()
  expect(JSON.parse(readFileSync(alertsPath(), "utf8")).alerts).toEqual({})
})

test("renewal resets the schedule; undelivered push is retried next pass", async () => {
  const id = await add("passport", dateIn(100))
  delivered = 0
  expect(await checkRecordExpiry()).toEqual([])
  expect(existsSync(alertsPath())).toBe(false)
  delivered = 1
  now = T0 + DAY
  expect(await checkRecordExpiry()).toEqual([id])
  await updateRecord(id, { fields: { expiry_date: dateIn(3700) } }, ORIGIN)
  now = T0 + 40 * DAY
  expect(await checkRecordExpiry()).toEqual([])
})

test("startRecordsExpiry runs at once, then every interval; stop halts it", async () => {
  await add("passport", dateIn(5))
  const stop = startRecordsExpiry(20)
  await Bun.sleep(5)
  expect(pushes.length).toBe(1)
  now += DAY
  await Bun.sleep(40)
  stop()
  const n = pushes.length
  expect(n).toBeGreaterThanOrEqual(2)
  await Bun.sleep(50)
  expect(pushes.length).toBe(n)
})
