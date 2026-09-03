import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getUserDataDir, moduleRegistryFile } from "../src/core/userdata.ts";

test("PI_SWARM_USERDATA overrides the platform user data dir", () => {
  const previous = process.env.PI_SWARM_USERDATA;
  try {
    const override = join(tmpdir(), "userdata-override-test");
    process.env.PI_SWARM_USERDATA = override;
    assert.equal(getUserDataDir(), resolve(override));
    assert.equal(moduleRegistryFile(), join(resolve(override), "module-registry.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_SWARM_USERDATA;
    else process.env.PI_SWARM_USERDATA = previous;
  }
});

test("the platform dir is used when no override is set", () => {
  const previous = process.env.PI_SWARM_USERDATA;
  delete process.env.PI_SWARM_USERDATA;
  try {
    const dir = getUserDataDir();
    if (process.platform === "win32") assert.match(dir, /[\\/]pi-swarm$/);
    else if (process.platform === "darwin") assert.match(dir, /pi-swarm$/);
    else assert.match(dir, /[\\/]pi-swarm$/);
  } finally {
    if (previous !== undefined) process.env.PI_SWARM_USERDATA = previous;
  }
});
