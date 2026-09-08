import assert from "node:assert/strict";
import { test } from "node:test";
import { fdInstallHint } from "../src/core/install-hint.ts";

test("fd install hint follows the platform", () => {
  assert.match(fdInstallHint("darwin"), /brew install fd/);
  assert.match(fdInstallHint("win32"), /winget install sharkdp\.fd/);
});

test("fd install hint picks the package manager from /etc/os-release", () => {
  const hint = (osRelease?: string): string => fdInstallHint("linux", osRelease);
  // ID 优先
  assert.match(hint("ID=ubuntu\nNAME=\"Ubuntu\""), /apt install fd-find（命令为 fdfind）/);
  assert.match(hint("ID=fedora"), /dnf install fd-find/);
  assert.match(hint("ID=arch"), /pacman -S fd/);
  assert.match(hint("ID=alpine"), /apk add fd/);
  assert.match(hint("ID=nixos"), /nix-env -iA nixpkgs\.fd/);
  // ID_LIKE 兜底（衍生发行版）
  assert.match(hint("ID=linuxmint\nID_LIKE=\"debian debian_sid\""), /apt install fd-find/);
  assert.match(hint("ID=rocky\nID_LIKE=\"rhel centos fedora\""), /dnf install fd-find/);
  assert.match(hint("ID=manjaro\nID_LIKE=arch"), /pacman -S fd/);
  assert.match(hint("ID=opensuse-leap\nID_LIKE=\"suse opensuse\""), /zypper install fd/);
  // 大小写与引号
  assert.match(hint("ID=\"Ubuntu\"\n"), /apt install fd-find/);
  // 识别不了：cargo/发布页兜底
  assert.match(hint("ID=some-unknown-distro"), /cargo install fd-find/);
  assert.match(hint(undefined), /cargo install fd-find/);
});
