import { describe, expect, test } from "bun:test"
import { fixCwd, localizeCwd } from "./body-fix"

const none = () => false
const only = (...paths: string[]) => (p: string) => paths.includes(p)

describe("localizeCwd", () => {
  test("expands ~ and ~/ against this host's home", () => {
    expect(localizeCwd("~", "/Users/jeremieaubut", none)).toBe("/Users/jeremieaubut")
    expect(localizeCwd("~/.claude", "/Users/jeremieaubut", none)).toBe("/Users/jeremieaubut/.claude")
  })

  test("re-roots the other host's home when the path doesn't exist here", () => {
    expect(localizeCwd("/home/aubut/.claude", "/Users/jeremieaubut", none)).toBe("/Users/jeremieaubut/.claude")
    expect(localizeCwd("/Users/jeremieaubut/tls-dashboard-v2", "/home/aubut", none)).toBe("/home/aubut/tls-dashboard-v2")
    expect(localizeCwd("/home/aubut", "/Users/jeremieaubut", none)).toBe("/Users/jeremieaubut")
  })

  test("keeps a path that exists on this host", () => {
    expect(localizeCwd("/home/aubut/.claude", "/Users/x", only("/home/aubut/.claude"))).toBe("/home/aubut/.claude")
  })

  test("default home honours process.env.HOME", () => {
    const saved = process.env.HOME
    process.env.HOME = "/tmp/cc-fake-home"
    try {
      expect(localizeCwd("~/.claude")).toBe("/tmp/cc-fake-home/.claude")
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
    }
  })

  test("leaves non-home paths alone", () => {
    expect(localizeCwd("/opt/app", "/Users/jeremieaubut", none)).toBe("/opt/app")
  })
})

describe("fixCwd", () => {
  const H = "/Users/jeremieaubut"

  test("a cwd inside an app bundle runs in home", () => {
    const bundle = `${H}/Library/Application Support/Google/GoogleUpdater/150.0/GoogleUpdater.app/Contents/MacOS`
    expect(fixCwd(bundle, H)).toEqual({ cwd: H, replaced: true })
    expect(fixCwd("/Applications/Foo.app", H)).toEqual({ cwd: H, replaced: true })
  })

  test("segment match only: webapp / app / .application paths pass", () => {
    for (const p of ["/x/webapp/y", "/x/app/y", "/x/app", "/x/my.application/y", "/x/foo.apps/y"]) expect(fixCwd(p, H)).toEqual({ cwd: p, replaced: false })
  })

  test("applied after localizeCwd: a Zettlab-home bundle path is re-rooted, then replaced", () => {
    const localized = localizeCwd("/home/aubut/tools/X.app/Contents/MacOS", H, none)
    expect(localized).toBe(`${H}/tools/X.app/Contents/MacOS`)
    expect(fixCwd(localized, H)).toEqual({ cwd: H, replaced: true })
  })
})

describe("fixCwd: what counts as a bundle", () => {
  const H = "/Users/jeremieaubut"

  test("case-insensitive: X.APP/contents and an Applications folder", () => {
    expect(fixCwd("/x/Foo.APP/contents/MacOS", H, none)).toEqual({ cwd: H, replaced: true })
    expect(fixCwd(`${H}/Applications/Tool.App`, H, none)).toEqual({ cwd: H, replaced: true })
  })

  test("a repo dir named like an app passes: no Contents segment, no Contents/ dir", () => {
    for (const p of [`${H}/code/tls.app`, `${H}/code/tls.app/src`, `${H}/code/TLS.App/server`]) expect(fixCwd(p, H, none)).toEqual({ cwd: p, replaced: false })
  })

  test("a .app dir with a Contents/ dir on disk is a bundle, also with no Contents segment in the path", () => {
    const exists = only(`${H}/Downloads/Thing.app/Contents`)
    expect(fixCwd(`${H}/Downloads/Thing.app`, H, exists)).toEqual({ cwd: H, replaced: true })
    expect(fixCwd(`${H}/Downloads/Thing.app/Resources`, H, exists)).toEqual({ cwd: H, replaced: true })
    expect(fixCwd(`${H}/code/tls.app`, H, exists)).toEqual({ cwd: `${H}/code/tls.app`, replaced: false })
  })
})
