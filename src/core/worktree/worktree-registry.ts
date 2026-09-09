import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeWorktreeName, randomWorktreeName, WORKTREE_DIR, WorktreeError, type WorktreeInfo } from "./worktree-types.ts";

const runGitBinary = promisify(execFile);

export interface WorktreeRegistryOptions {
  /** 起始目录：git 仓库根由它解析（git rev-parse --show-toplevel）。 */
  cwd: string;
  /** git 命令执行器注入（测试用）；默认 execFile("git", …, { cwd })。 */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string }>;
}

type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>;

/**
 * worktree 作用域注册表：只管目录与分支的解析和创建，完全不管会话——
 * 会话在创建时归属某个作用域（SessionRegistry 盖章），本类不维护任何
 * 会话状态。createOrResolve 是唯一的入口语义：
 *
 * 1. `git worktree list --porcelain` 已注册该路径 → 直接复用（不新建）；
 * 2. 同名分支存在但未挂载 → `git worktree add <path> <name>`；
 * 3. 否则 → `git worktree add -b <name> <path>`（基于 HEAD）；
 * 4. 目录已存在但未注册 → 报错（防止把无关目录当 worktree）。
 */
export class WorktreeRegistry {
  private readonly cwd: string;
  private readonly git: GitRunner;
  /** 解析成功的仓库根缓存；失败不缓存（下次调用重试）。 */
  private root?: string;

  public constructor(options: WorktreeRegistryOptions) {
    if (!options.cwd.trim()) throw new WorktreeError("cwd 不能为空");
    this.cwd = options.cwd;
    this.git = options.runGit ?? ((args, cwd) => runGitBinary("git", args, { cwd }));
  }

  /** 解析仓库根（缓存）；非 git 仓库抛 WorktreeError。 */
  public async ensureRoot(): Promise<string> {
    if (this.root) return this.root;
    try {
      const { stdout } = await this.git(["rev-parse", "--show-toplevel"], this.cwd);
      const root = stdout.trim();
      if (!root) throw new Error("rev-parse 输出为空");
      this.root = root;
      return root;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WorktreeError(`worktree 需要 git 仓库：无法从 ${this.cwd} 解析仓库根（${reason}）`);
    }
  }

  /** 作用域目录的绝对路径（会触发仓库根解析）。 */
  public async pathOf(name: string): Promise<string> {
    const root = await this.ensureRoot();
    return join(root, ...WORKTREE_DIR.split("/"), name);
  }

  /**
   * create-or-resolve：名称省略/空白时随机命名。返回的 name 永远是规范化的
   * 作用域名；created=false 表示复用已注册的 worktree（多会话共享同一目录）。
   */
  public async createOrResolve(name?: string): Promise<WorktreeInfo> {
    const root = await this.ensureRoot();
    const resolved = normalizeWorktreeName(name) ?? randomWorktreeName();
    const path = join(root, ...WORKTREE_DIR.split("/"), resolved);
    if (await this.isRegistered(path)) {
      return { name: resolved, path, created: false };
    }
    if (await pathExists(path)) {
      throw new WorktreeError(`目录已存在但不是注册的 worktree：${path}（请手动处理后重试，或换一个名称）`);
    }
    await mkdir(join(root, ...WORKTREE_DIR.split("/")), { recursive: true });
    const branchExists = await this.gitExists(`refs/heads/${resolved}`);
    if (branchExists) {
      // 分支已存在（例如早前 prune 掉的 worktree）：把分支重新挂载为新 worktree。
      await this.git(["worktree", "add", path, resolved], root);
    } else {
      await this.git(["worktree", "add", "-b", resolved, path], root);
    }
    await this.ensureGitignored(root);
    return { name: resolved, path, created: true };
  }

  /** 已注册的 worktree 列表（/worktrees 展示用；目录名即作用域名）。 */
  public async list(): Promise<WorktreeInfo[]> {
    const root = await this.ensureRoot();
    const { stdout } = await this.git(["worktree", "list", "--porcelain"], root);
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
    }
    const prefix = join(root, ...WORKTREE_DIR.split("/"));
    return paths
      .filter((path) => path.startsWith(prefix))
      .map((path) => ({ name: path.slice(prefix.length + 1), path, created: false }));
  }

  /** 主工作区（仓库根）路径。 */
  public async mainPath(): Promise<string> {
    return this.ensureRoot();
  }

  /** 路径是否出现在 git worktree list 中。 */
  private async isRegistered(path: string): Promise<boolean> {
    const root = await this.ensureRoot();
    const { stdout } = await this.git(["worktree", "list", "--porcelain"], root);
    return stdout.split("\n").some((line) => line.startsWith("worktree ") && line.slice("worktree ".length).trim() === path);
  }

  private async gitExists(ref: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", ref], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** 确保 <root>/.gitignore 忽略 worktrees 目录，避免主工作区出现状态噪声。 */
  private async ensureGitignored(root: string): Promise<void> {
    const gitignore = join(root, ".gitignore");
    const entry = `${WORKTREE_DIR}/`;
    let content = "";
    try {
      content = await readFile(gitignore, "utf8");
    } catch {
      // 无 .gitignore：从空内容开始创建。
    }
    const alreadyIgnored = content.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed === entry || trimmed === WORKTREE_DIR || trimmed === ".pi-swarm/";
    });
    if (alreadyIgnored) return;
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    await writeFile(gitignore, `${content}${separator}${entry}\n`, "utf8");
  }
}

/** 路径存在性检查；任何错误（缺失、权限）都视为不存在。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
