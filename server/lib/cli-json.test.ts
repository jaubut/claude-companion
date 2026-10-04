import { describe, expect, test } from "bun:test"
import { parseCliResult } from "./cli-json"

describe("parseCliResult", () => {
  test("new CLI shape: result field not first (2.1.28x)", () => {
    const out = '{"duration_api_ms":1598,"stop_reason":"end_turn","session_id":"x","result":"ok","type":"result"}\n'
    expect(parseCliResult(out)).toBe("ok")
  })

  test("old CLI shape: type first", () => {
    expect(parseCliResult('{"type":"result","subtype":"success","result":"hello"}')).toBe("hello")
  })

  test("warning lines before the JSON", () => {
    const out = 'Warning: something odd\nanother line\n{"duration_ms":3,"result":"fine"}\n'
    expect(parseCliResult(out)).toBe("fine")
  })

  test("warning prefix on the same line", () => {
    expect(parseCliResult('WARN: x {"result":"same line"}')).toBe("same line")
  })

  test("result containing braces and JSON-looking text", () => {
    const inner = JSON.stringify({ kind: "task", agent: "builder" })
    const out = JSON.stringify({ duration_api_ms: 1, result: inner })
    expect(parseCliResult(out)).toBe(inner)
  })

  test("pretty-printed wrapper", () => {
    const out = JSON.stringify({ duration_api_ms: 1, result: "pretty" }, null, 2)
    expect(parseCliResult(out)).toBe("pretty")
  })

  test("no wrapper / no string result / empty → null", () => {
    expect(parseCliResult("")).toBeNull()
    expect(parseCliResult("not json at all")).toBeNull()
    expect(parseCliResult('{"type":"result","is_error":true}')).toBeNull()
    expect(parseCliResult('{"result":42}')).toBeNull()
  })
})
