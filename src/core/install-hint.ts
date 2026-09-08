import { readFileSync } from "node:fs";

/**
 * 按平台给出 fd 的安装提示（@ 文件补全依赖 fd）。macOS 走 brew，Windows 走
 * winget；Linux 依据 /etc/os-release 的 ID/ID_LIKE 判断发行版选包管理器，
 * 识别不了时回退 cargo/ releases。osRelease 由调用方注入以便测试。
 */
export function fdInstallHint(platform: NodeJS.Platform, osRelease?: string): string {
  if (platform === "darwin") return "brew install fd";
  if (platform === "win32") return "winget install sharkdp.fd";
  switch (linuxDistro(osRelease)) {
    case "debian":
      // Debian/Ubuntu 的包名与二进制名不同：装完命令是 fdfind。
      return "sudo apt install fd-find（命令为 fdfind）";
    case "fedora":
      return "sudo dnf install fd-find";
    case "arch":
      return "sudo pacman -S fd";
    case "suse":
      return "sudo zypper install fd";
    case "alpine":
      return "apk add fd";
    case "nixos":
      return "nix-env -iA nixpkgs.fd";
    default:
      return "cargo install fd-find，或从 github.com/sharkdp/fd/releases 下载";
  }
}

/** 读 /etc/os-release 原文（仅 Linux 存在；读取失败返回 undefined）。 */
export function readOsRelease(): string | undefined {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return undefined;
  }
}

/** 发行版族判定：os-release 的 ID 优先，ID_LIKE 兜底（两者都是空格分组的别名列表）。 */
function linuxDistro(osRelease?: string): string | undefined {
  if (!osRelease) return undefined;
  const field = (name: string): string[] => {
    const match = osRelease.match(new RegExp(`^${name}=(?:"([^"]*)"|(.+))$`, "m"));
    return (match?.[1] ?? match?.[2] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  };
  const tokens = [...field("ID"), ...field("ID_LIKE")];
  const family = (names: string[]): boolean => tokens.some((token) => names.includes(token));
  if (family(["debian", "ubuntu", "linuxmint", "pop", "raspbian", "kali", "deepin"])) return "debian";
  if (family(["fedora", "rhel", "centos", "rocky", "almalinux", "amzn", "ol"])) return "fedora";
  if (family(["arch", "manjaro", "endeavouros", "garuda", "artix"])) return "arch";
  if (family(["suse", "opensuse", "sled", "sles"])) return "suse";
  if (family(["alpine"])) return "alpine";
  if (family(["nixos"])) return "nixos";
  return undefined;
}
