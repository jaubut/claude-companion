import { describe, expect, test } from "bun:test"
import { localizeCwd } from "./body-fix"

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

  test("leaves non-home paths alone", () => {
    expect(localizeCwd("/opt/app", "/Users/jeremieaubut", none)).toBe("/opt/app")
  })
})
