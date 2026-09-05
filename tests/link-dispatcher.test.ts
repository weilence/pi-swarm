import assert from "node:assert/strict";
import { test } from "node:test";
import { LinkDispatcher, link } from "../src/cli/link-dispatcher.ts";

test("dispatch routes by longest matching prefix and passes the remainder", () => {
  const links = new LinkDispatcher();
  const got: string[] = [];
  links.register("pi-swarm://agent/", (rest) => got.push(`agent:${rest}`));
  links.register("pi-swarm://agent/pinned/", (rest) => got.push(`pinned:${rest}`));

  assert.equal(links.dispatch("pi-swarm://agent/code-writer"), true);
  assert.equal(links.dispatch("pi-swarm://agent/pinned/abc"), true, "nested prefixes go to the longest match");
  assert.deepEqual(got, ["agent:code-writer", "pinned:abc"]);
});

test("dispatch returns false when nothing claims the url", () => {
  const links = new LinkDispatcher();
  assert.equal(links.dispatch("pi-swarm://unrelated/xyz"), false);
});

test("register returns an unregister function", () => {
  const links = new LinkDispatcher();
  const got: string[] = [];
  const unregister = links.register("pi-swarm://session/", (rest) => got.push(rest));
  unregister();
  assert.equal(links.dispatch("pi-swarm://session/s1"), false);
  assert.deepEqual(got, []);
});

test("link wraps text in an OSC 8 hyperlink around the url", () => {
  const raw = link("pi-swarm://session/s1", "会话甲");
  assert.ok(raw.startsWith("\x1b]8;;pi-swarm://session/s1\x07"));
  assert.ok(raw.includes("会话甲"));
  assert.ok(raw.endsWith("\x1b]8;;\x07"));
});
