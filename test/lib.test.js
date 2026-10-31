import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listProviderModels, applyExclude, baseURL, buildProviders, centralDir, userHome, centralStatus, NEED_CENTRAL, fetchModels, modelMap, readProxy, CentralNotReadyError } from "../lib.js"
import { ICONS } from "../icons.js"

const proxy = { port: 19516, secret: "abc123" }

test("base URLs match the proxy URL scheme", () => {
  expect(baseURL(proxy, "anthropic")).toBe("http://127.0.0.1:19516/wire/abc123/claude-code/anthropic/v1")
  expect(baseURL(proxy, "openai")).toBe("http://127.0.0.1:19516/wire/abc123/codex/openai/v1")
  expect(baseURL(proxy, "vertex")).toBe("http://127.0.0.1:19516/wire/abc123/gemini-cli/vertex/v1beta1/projects/wire-project/locations/wire-location/publishers/google")
})

const down = async () => { throw new Error("down") }
const json = (body, ok = true) => async () => ({ ok, json: async () => body })

test("falls back to static models when /models fails; dummy key is set", async () => {
  const p = await buildProviders(proxy, {}, down)
  expect(Object.keys(p)).toEqual(["central-anthropic", "central-openai", "central-vertex"])
  expect(p["central-openai"].options.apiKey).toBe("wire-proxy")
  expect(p["central-anthropic"].npm).toBe("@ai-sdk/anthropic")
  expect(Object.keys(p["central-anthropic"].models).length).toBeGreaterThan(0)
})

test("uses live models and shows everything by default (no filtering)", async () => {
  const f = json({ data: [{ id: "claude-x-eap", display_name: "X EAP" }, { id: "text-embedding-3" }] })
  const p = await buildProviders(proxy, { routes: ["anthropic"] }, f)
  expect(Object.keys(p["central-anthropic"].models)).toEqual(["claude-x-eap", "text-embedding-3"])
  expect(p["central-anthropic"].models["claude-x-eap"].name).toBe("X EAP")
})

test("exclude option drops matching ids", async () => {
  const f = json({ data: [{ id: "a-eap" }, { id: "b" }] })
  const p = await buildProviders(proxy, { routes: ["anthropic"], exclude: ["-eap$"] }, f)
  expect(Object.keys(p["central-anthropic"].models)).toEqual(["b"])
  expect(applyExclude([{ id: "q" }])).toEqual([{ id: "q" }])
})

test("fetchModels paginates; unknown route has no listing", async () => {
  const pages = [{ data: [{ id: "a" }], has_more: true, last_id: "a" }, { data: [{ id: "b" }], has_more: false }]
  const urls = []
  const f = async (u) => { urls.push(u); return { ok: true, json: async () => pages.shift() } }
  expect((await fetchModels(proxy, "anthropic", f)).map((m) => m.id)).toEqual(["a", "b"])
  expect(urls[1]).toContain("after_id=a")
  expect(await fetchModels(proxy, "nope", f)).toBeNull()
  expect(await fetchModels(proxy, "openai", json({}, false))).toBeNull()
})

test("vertex lists via the publisher endpoint and follows nextPageToken", async () => {
  const pages = [
    { publisherModels: [{ name: "publishers/google/models/g-a", versionId: "g-a" }], nextPageToken: "t1" },
    { publisherModels: [{ name: "publishers/google/models/g-b" }] },
  ]
  const urls = []
  const f = async (u, init) => { urls.push([u, init.headers]); return { ok: true, json: async () => pages.shift() } }
  expect((await fetchModels(proxy, "vertex", f)).map((m) => m.id)).toEqual(["g-a", "g-b"])
  expect(urls[0][0]).toContain("/wire/abc123/gemini-cli/vertex/v1beta1/publishers/google/models?")
  expect(urls[0][0]).not.toContain("projects/")
  expect(urls[1][0]).toContain("pageToken=t1")
  expect(urls[0][1]["x-goog-api-key"]).toBe("wire-proxy")
})

test("overrides win; dynamic:false skips the network; routes filters", async () => {
  let calls = 0
  const f = async () => { calls++; throw new Error("no") }
  const p = await buildProviders(proxy, { routes: ["openai", "anthropic"], models: { openai: ["x"] }, dynamic: false }, f)
  expect(Object.keys(p)).toEqual(["central-anthropic", "central-openai"].filter((k) => k in p))
  expect(Object.keys(p["central-openai"].models)).toEqual(["x"])
  expect(calls).toBe(0)
  expect(modelMap("openai", { y: { name: "Y" } })).toEqual({ y: { name: "Y" } })
})

test("centralDir falls back to legacy ~/.wire only when the new dir is empty", async () => {
  const home = await mkdtemp(join(tmpdir(), "home-"))
  const fs = await import("node:fs/promises")
  expect(centralDir({}, home)).toBe(join(home, ".jetbrains-central"))
  await fs.mkdir(join(home, ".wire"))
  expect(centralDir({}, home)).toBe(join(home, ".wire"))
  await fs.mkdir(join(home, ".jetbrains-central"))
  expect(centralDir({}, home)).toBe(join(home, ".wire"))
  await writeFile(join(home, ".jetbrains-central", "config.json"), "{}")
  expect(centralDir({}, home)).toBe(join(home, ".jetbrains-central"))
  expect(centralDir({ CENTRAL_HOME: "/x" }, home)).toBe("/x")
})

test("readProxy reads config.json and fails clearly when not ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-"))
  await expect(readProxy(dir)).rejects.toBeInstanceOf(CentralNotReadyError)
  await writeFile(join(dir, "config.json"), JSON.stringify({ proxy_port: 1234 }))
  await expect(readProxy(dir)).rejects.toThrow(/proxy_secret/)
  await writeFile(join(dir, "config.json"), JSON.stringify({ proxy_port: 1234, proxy_secret: "s" }))
  expect(await readProxy(dir)).toMatchObject({ port: 1234, secret: "s" })
})

test("each route has its own data:image icon Magpie accepts", () => {
  expect(Object.keys(ICONS)).toEqual(["anthropic", "openai", "vertex"])
  for (const v of Object.values(ICONS)) {
    expect(v).toMatch(/^data:image\//)
    expect(v.length).toBeLessThan(3 << 19)
  }
  expect(new Set(Object.values(ICONS)).size).toBe(3)
})

test("centralStatus: not ready without config or without a live proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-"))
  expect(await centralStatus(dir, down)).toMatchObject({ ready: false })
  await writeFile(join(dir, "config.json"), JSON.stringify({ proxy_port: 1234, proxy_secret: "s" }))
  const dead = await centralStatus(dir, down)
  expect(dead.ready).toBe(false)
  expect(dead.reason).not.toContain('"s"')
  const up = await centralStatus(dir, async () => ({ ok: true }))
  expect(up).toMatchObject({ ready: true, proxy: { port: 1234 } })
  expect(NEED_CENTRAL).toBe("需要运行登录 central-cli")
})

test("package.json carries the plugin's own icon as a data:image URI", async () => {
  const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text())
  expect(pkg.magpie.icon).toMatch(/^data:image\/png;base64,/)
  expect(pkg.magpie.icon.length).toBeLessThan(3 << 19)
})

test("provider.models hook lists live models in Magpie's full shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-"))
  await writeFile(join(dir, "config.json"), JSON.stringify({ proxy_port: 19516, proxy_secret: "abc123" }))
  const f = async (url) => (String(url).includes("/models") ? { ok: true, json: async () => ({ data: [{ id: "m1", display_name: "M One" }] }) } : { ok: true })
  const kept = { id: "m1", name: "user" }
  const out = await listProviderModels("anthropic", { models: { m1: kept } }, {}, dir, f)
  expect(out.m1).toBe(kept)
  const fresh = await listProviderModels("anthropic", { models: {} }, {}, dir, f)
  expect(fresh.m1.name).toBe("M One")
  expect(fresh.m1.api.url).toBe("http://127.0.0.1:19516/wire/abc123/claude-code/anthropic/v1")
  expect(fresh.m1.capabilities.toolcall).toBe(true)
})

test("provider.models hook throws when central is not ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-"))
  await expect(listProviderModels("openai", { models: {} }, {}, dir, down)).rejects.toThrow()
})

test("WIRE_PROXY_PORT overrides proxy_port like central does; bad values are ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-"))
  await writeFile(join(dir, "config.json"), JSON.stringify({ proxy_port: 20000, proxy_secret: "s" }))
  expect((await readProxy(dir, {})).port).toBe(20000)
  expect((await readProxy(dir, { WIRE_PROXY_PORT: "23456" })).port).toBe(23456)
  expect((await readProxy(dir, { WIRE_PROXY_PORT: "abc" })).port).toBe(20000)
})

test("config.json with a UTF-8 BOM (Windows editors) still parses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-"))
  await writeFile(join(dir, "config.json"), "\uFEFF" + JSON.stringify({ proxy_secret: "s" }))
  expect(await readProxy(dir, {})).toMatchObject({ port: 19516, secret: "s" })
})

test("home follows the platform: USERPROFILE on Windows, HOME elsewhere", () => {
  expect(userHome({ USERPROFILE: "C:\\Users\\a", HOME: "/h" }, "win32")).toBe("C:\\Users\\a")
  expect(userHome({ USERPROFILE: "C:\\Users\\a", HOME: "/h" }, "darwin")).toBe("/h")
})

test("an unreadable data dir does not crash centralDir", () => {
  expect(centralDir({}, "/nonexistent-home-dir")).toBe(join("/nonexistent-home-dir", ".jetbrains-central"))
})
