import { expect, test } from "bun:test"
import { maskToken } from "./auth"

test("maskToken keeps only a 4-char hint of the bearer", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"
  const masked = maskToken(token)
  expect(masked).toBe("AbCd…")
  expect(masked).not.toContain(token.slice(4, 12))
  expect(maskToken("  ")).toBe("(none)")
})

test("the boot banner in cli.ts never prints the raw token", async () => {
  const src = await Bun.file(new URL("../../cli.ts", import.meta.url)).text()
  const banner = src.slice(src.indexOf("${bold}Pairing${reset}"), src.indexOf("Paste both into"))
  expect(banner).toContain("maskToken(token)")
  expect(banner).not.toMatch(/\$\{token\}/)
})
