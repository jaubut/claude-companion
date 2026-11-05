import { expect, test } from "bun:test"
import { BadJsonBody, jsonObject } from "./json-body"

const req = (body: string): Request => new Request("http://x/", { method: "POST", body })

test("a JSON object comes back as is", async () => {
  expect(await jsonObject(req('{"a":1}'))).toEqual({ a: 1 })
  expect(await jsonObject(req("{}"))).toEqual({})
})

test.each(["null", "[]", "[1]", "7", '"x"', "true"])("%s throws, with or without a malformed fallback", async (body) => {
  expect(jsonObject(req(body))).rejects.toBeInstanceOf(BadJsonBody)
  expect(jsonObject(req(body), {})).rejects.toBeInstanceOf(BadJsonBody)
})

test("malformed or empty: throws, unless the route gave a fallback", async () => {
  for (const body of ["{bad", ""]) {
    expect(jsonObject(req(body))).rejects.toBeInstanceOf(BadJsonBody)
    expect(await jsonObject(req(body), { fallback: true })).toEqual({ fallback: true })
  }
})
