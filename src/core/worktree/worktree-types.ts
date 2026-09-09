/** worktree 作用域解析/创建的结果。 */
export interface WorktreeInfo {
  /** 作用域名，同时是分支名与目录名。 */
  name: string;
  /** 绝对路径 <repoRoot>/.pi-swarm/worktrees/<name>。 */
  path: string;
  /** 本次调用是否新建（false = 复用已注册的 worktree）。 */
  created: boolean;
}

/** worktree 解析/创建失败（非 git 仓库、非法名称、目录冲突等）。 */
export class WorktreeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** worktree 名称规则：分支名安全子集；`.` 是主工作区保留引用，恰好不满足本规则。 */
export const WORKTREE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** worktrees 在仓库内的固定存放目录（相对仓库根）。 */
export const WORKTREE_DIR = ".pi-swarm/worktrees";

/** 去除首尾空白并校验名称规则；空串返回 undefined（由调用方决定随机命名）。 */
export function normalizeWorktreeName(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (!WORKTREE_NAME_PATTERN.test(trimmed)) {
    throw new WorktreeError(
      `非法 worktree 名称：${trimmed}（允许字母/数字开头，含 . _ -，最长 64 字符）`
    );
  }
  return trimmed;
}

/** 随机作用域名：wt- + 6 位 base36（crypto 随机，撞名概率可忽略）。 */
export function randomWorktreeName(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `wt-${suffix}`;
}
