import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsDevCatalog, inferPiApi, toThinkingLevelMap, toPiProviderConfig, type CatalogUpdateInfo, type ModelsDevProvider } from "../src/models-dev/catalog.ts";

test("toThinkingLevelMap generates a level map from effort reasoning_options", () => {
  const model = { id: "m", reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }] };
  assert.deepEqual(toThinkingLevelMap(model), {
    off: "none",
    low: "low",
    high: "high",
    max: "max",
    minimal: null,
    medium: null,
    xhigh: null
  });
});

test("toThinkingLevelMap skips unknown effort values and noise", () => {
  const model = { id: "m", reasoning_options: [{ type: "effort", values: ["default", null, "medium"] }] };
  assert.deepEqual(toThinkingLevelMap(model), {
    medium: "medium",
    off: null,
    minimal: null,
    low: null,
    high: null,
    xhigh: null,
    max: null
  });
});

test("toThinkingLevelMap omits the map for toggle, budget-token, and missing options", () => {
  assert.equal(toThinkingLevelMap({ id: "m", reasoning_options: [{ type: "toggle" }] }), undefined);
  assert.equal(toThinkingLevelMap({ id: "m", reasoning_options: [{ type: "budget_tokens", min: 1024 }] }), undefined);
  assert.equal(toThinkingLevelMap({ id: "m", reasoning_options: [{ type: "effort", values: [] }] }), undefined);
  assert.equal(toThinkingLevelMap({ id: "m" }), undefined);
});

test("toPiProviderConfig attaches the generated thinking level map to models", () => {
  const provider: ModelsDevProvider = {
    id: "zhipuai",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.3": { id: "glm-5.3", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
      "glm-4.6v": { id: "glm-4.6v", reasoning: true, reasoning_options: [{ type: "toggle" }] }
    }
  };
  const config = toPiProviderConfig(provider);
  const glm53 = config.models.find((model) => model.id === "glm-5.3");
  const glm46 = config.models.find((model) => model.id === "glm-4.6v");
  assert.deepEqual(glm53?.thinkingLevelMap, { low: "low", high: "high", max: "max", off: null, minimal: null, medium: null, xhigh: null });
  assert.equal(glm46?.thinkingLevelMap, undefined);
});

test("models.dev npm packages map to KnownApi by exact package name", () => {
  const provider = (npm?: string): ModelsDevProvider =>
    ({ id: "x", npm, models: {} }) as ModelsDevProvider;

  assert.equal(inferPiApi(provider("@ai-sdk/anthropic")), "anthropic-messages");
  assert.equal(inferPiApi(provider("@ai-sdk/amazon-bedrock")), "bedrock-converse-stream");
  assert.equal(inferPiApi(provider("@ai-sdk/google-vertex")), "google-vertex");
  assert.equal(inferPiApi(provider("@ai-sdk/google")), "google-generative-ai");
  assert.equal(inferPiApi(provider("@ai-sdk/azure")), "azure-openai-responses");
  assert.equal(inferPiApi(provider("@ai-sdk/mistral")), "mistral-conversations");
  assert.equal(inferPiApi(provider("@ai-sdk/openai")), "openai-responses");

  assert.equal(inferPiApi(provider("@ai-sdk/openai-compatible")), "openai-completions", "exact match only");
  assert.equal(inferPiApi(provider("@ai-sdk/google-vertex/anthropic")), "openai-completions", "subpaths are not matched");
  assert.equal(inferPiApi(provider("@openrouter/ai-sdk-provider")), "openai-completions");
  assert.equal(inferPiApi(provider(undefined)), "openai-completions");

  assert.equal(inferPiApi(provider("@ai-sdk/openai-compatible"), "pi-messages"), "pi-messages", "override wins");
});

interface CatalogServer {
  url: string;
  requests: number;
  payload: string;
  close(): Promise<void>;
}

async function startCatalogServer(initialPayload: string): Promise<CatalogServer> {
  let payload = initialPayload;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no listen address");
  return {
    url: `http://127.0.0.1:${address.port}/api.json`,
    get requests() {
      return requests;
    },
    set payload(value: string) {
      payload = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

interface EtagServer {
  url: string;
  requests: number;
  conditionalRequests: number;
  notModifiedResponses: number;
  set payload(value: string);
  set etag(value: string);
  close(): Promise<void>;
}

/** models.dev stand-in that serves an ETag and answers matching If-None-Match with 304. */
async function startEtagServer(initialPayload: string, initialEtag: string): Promise<EtagServer> {
  let payload = initialPayload;
  let etag = initialEtag;
  let requests = 0;
  let conditionalRequests = 0;
  let notModifiedResponses = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      conditionalRequests += 1;
      notModifiedResponses += 1;
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    if (typeof ifNoneMatch === "string") conditionalRequests += 1;
    response.writeHead(200, { "content-type": "application/json", etag });
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no listen address");
  return {
    url: `http://127.0.0.1:${address.port}/api.json`,
    get requests() {
      return requests;
    },
    get conditionalRequests() {
      return conditionalRequests;
    },
    get notModifiedResponses() {
      return notModifiedResponses;
    },
    set payload(value: string) {
      payload = value;
    },
    set etag(value: string) {
      etag = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const payloadV1 = JSON.stringify({
  anthropic: { name: "Anthropic", npm: "@anthropic-ai/sdk", models: { "claude-sonnet-4": { id: "claude-sonnet-4" } } }
});
const payloadV2 = JSON.stringify({
  anthropic: { name: "Anthropic", npm: "@anthropic-ai/sdk", models: { "claude-sonnet-4": { id: "claude-sonnet-4" } } },
  openai: { name: "OpenAI", npm: "openai", models: { "gpt-4o": { id: "gpt-4o" } } }
});

async function makeCacheFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "modelsdev-")), "models-dev.json");
}

test("first load fetches from the network and writes the cache", async () => {
  const server = await startCatalogServer(payloadV1);
  const cacheFile = await makeCacheFile();
  try {
    const catalog = new ModelsDevCatalog({ endpoint: server.url, cacheFile });
    const providers = await catalog.load();
    assert.deepEqual(providers.map((provider) => provider.id), ["anthropic"]);
    assert.equal(server.requests, 1);

    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { providers: { id: string }[] };
    assert.deepEqual(cached.providers.map((provider) => provider.id), ["anthropic"]);
  } finally {
    await server.close();
  }
});

test("cached load returns instantly and revalidates in the background", async () => {
  const server = await startCatalogServer(payloadV1);
  const cacheFile = await makeCacheFile();
  const updates: CatalogUpdateInfo[] = [];
  try {
    await new ModelsDevCatalog({ endpoint: server.url, cacheFile }).load();
    server.payload = payloadV2;

    const catalog = new ModelsDevCatalog({ endpoint: server.url, cacheFile, onUpdate: (info) => updates.push(info) });
    const served = await catalog.load();
    assert.deepEqual(served.map((provider) => provider.id), ["anthropic"], "cache must be served without waiting");

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const current = await catalog.load();
      if (current.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual((await catalog.load()).map((provider) => provider.id), ["anthropic", "openai"]);
    assert.equal(server.requests, 2, "background revalidation should hit the server exactly once");
    assert.ok(updates.some((info) => info.source === "cache" && !info.updated));
    assert.ok(updates.some((info) => info.source === "refresh" && info.updated && info.count === 2));

    const third = new ModelsDevCatalog({ endpoint: server.url, cacheFile });
    assert.deepEqual((await third.load()).map((provider) => provider.id), ["anthropic", "openai"], "disk cache is updated");
  } finally {
    await server.close();
  }
});

test("identical payloads are not reported as updates", async () => {
  const server = await startCatalogServer(payloadV1);
  const cacheFile = await makeCacheFile();
  const updates: CatalogUpdateInfo[] = [];
  try {
    await new ModelsDevCatalog({ endpoint: server.url, cacheFile }).load();
    const catalog = new ModelsDevCatalog({ endpoint: server.url, cacheFile, onUpdate: (info) => updates.push(info) });
    await catalog.load();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !updates.some((info) => info.source === "refresh")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const refresh = updates.find((info) => info.source === "refresh");
    assert.ok(refresh && !refresh.updated, "unchanged payload must not count as an update");
  } finally {
    await server.close();
  }
});

test("network failure falls back to the cache instead of throwing", async () => {
  const server = await startCatalogServer(payloadV1);
  const cacheFile = await makeCacheFile();
  await new ModelsDevCatalog({ endpoint: server.url, cacheFile }).load();
  await server.close();

  const catalog = new ModelsDevCatalog({ endpoint: server.url, cacheFile });
  const providers = await catalog.load();
  assert.deepEqual(providers.map((provider) => provider.id), ["anthropic"]);
});

test("revalidation sends If-None-Match and settles on 304 without a body", async () => {
  const server = await startEtagServer(payloadV1, '"v1"');
  const cacheFile = await makeCacheFile();
  const updates: CatalogUpdateInfo[] = [];
  try {
    await new ModelsDevCatalog({ endpoint: server.url, cacheFile }).load();
    assert.equal(server.requests, 1, "initial fetch has no conditional header");

    const catalog = new ModelsDevCatalog({ endpoint: server.url, cacheFile, onUpdate: (info) => updates.push(info) });
    assert.deepEqual((await catalog.load()).map((provider) => provider.id), ["anthropic"]);

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !updates.some((info) => info.source === "refresh")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(server.requests, 2, "one background revalidation");
    assert.ok(server.notModifiedResponses >= 1, "server answered with 304");
    assert.ok(updates.some((info) => info.source === "refresh" && !info.updated), "304 means no update");
    assert.deepEqual((await catalog.load()).map((provider) => provider.id), ["anthropic"]);

    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { etag?: string };
    assert.equal(cached.etag, '"v1"', "etag is persisted for the next run");
  } finally {
    await server.close();
  }
});

test("a changed etag with identical content updates the cache but is not a data update", async () => {
  const server = await startEtagServer(payloadV1, '"v1"');
  const cacheFile = await makeCacheFile();
  const updates: CatalogUpdateInfo[] = [];
  try {
    await new ModelsDevCatalog({ endpoint: server.url, cacheFile }).load();
    server.etag = '"v1-regenerated"';

    const catalog = new ModelsDevCatalog({ endpoint: server.url, cacheFile, onUpdate: (info) => updates.push(info) });
    await catalog.load();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !updates.some((info) => info.source === "refresh")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(updates.some((info) => info.source === "refresh" && !info.updated), "same content is not an update");

    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { etag?: string };
    assert.equal(cached.etag, '"v1-regenerated"', "new etag is persisted so future checks stay cheap");
  } finally {
    await server.close();
  }
});

test("etag rollover: 304 short-circuits, then a real change comes through", async () => {
  const server = await startEtagServer(payloadV1, '"v1"');
  const cacheFile = await makeCacheFile();
  try {
    await new ModelsDevCatalog({ endpoint: server.url, cacheFile }).load();

    const second = new ModelsDevCatalog({ endpoint: server.url, cacheFile });
    await second.load();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && server.requests < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(server.notModifiedResponses, 1);

    server.payload = payloadV2;
    server.etag = '"v2"';
    const third = new ModelsDevCatalog({ endpoint: server.url, cacheFile });
    assert.deepEqual((await third.load()).map((provider) => provider.id), ["anthropic"], "still served from cache");
    const deadline2 = Date.now() + 2000;
    while (Date.now() < deadline2 && (await third.load()).length !== 2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual((await third.load()).map((provider) => provider.id), ["anthropic", "openai"], "200 payload replaces the cache");

    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { etag?: string };
    assert.equal(cached.etag, '"v2"');
  } finally {
    await server.close();
  }
});
