import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Directory name under the platform's per-user data location. */
const APP_NAME = "pi-swarm";

/**
 * Per-platform user data directory, following each OS convention:
 * - win32: %APPDATA%\pi-swarm
 * - darwin: ~/Library/Application Support/pi-swarm
 * - linux and others: $XDG_CONFIG_HOME/pi-swarm, defaulting to ~/.config/pi-swarm
 *
 * PI_SWARM_USERDATA overrides everything (used by tests to stay hermetic).
 */
export function getUserDataDir(): string {
  const override = process.env.PI_SWARM_USERDATA;
  if (override) return resolve(override);
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_NAME);
}

/** Location of the module registry shared by the CLI entrypoints. */
export function moduleRegistryFile(): string {
  return join(getUserDataDir(), "module-registry.json");
}
