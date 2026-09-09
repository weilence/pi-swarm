import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * 任务级流式指标观测器：首字符响应时间（TTFT）与任务级平均输出速度（tok/s）。
 * 与 ToolObservationCollector 同构——只消费会话事件和显式的 prompt 生命周期
 * 标记，不持有会话引用：速度计算需要的会话累计输出 token 由调用方在
 * handle()/speed() 时传入。
 *
 * 时间窗：本轮 prompt 派发 → 首个流式输出 → 本轮结束。派发后首字符未到时
 * 沿用上一任务的定格值，不随新任务的等待时间摊薄。
 */
export class StreamMetrics {
  /** 流式中当前 assistant 消息的 running 输出 token（message_update 持续更新；
   *  消息落盘后清零——那时会话统计已包含它，避免重复计数）。 */
  private runningTokens = 0;
  private promptStartedAt?: number;
  private firstOutputAt?: number;
  /** 首字符时刻的累计输出 token 基线：窗口起点之前的产出不计入平均速度。 */
  private outputAtFirst = 0;
  private generationEndedAt?: number;
  /** 定格的首字符响应时间：下一个任务的首字符到达前保持不变。 */
  private lastTtft?: number;
  private prompting = false;
  private readonly clock: () => number;

  public constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** 新一轮 prompt 派发：只刷新派发时刻；上一任务指标保持定格展示。 */
  public markPromptStart(): void {
    this.prompting = true;
    this.promptStartedAt = this.clock();
  }

  /** 本轮 prompt 结束（含失败/中止）：定格速度窗口终点。 */
  public markPromptEnd(): void {
    this.prompting = false;
    this.generationEndedAt = this.clock();
  }

  /**
   * 消费会话事件：message_update 携带进行中消息的累计输出 token（Anthropic
   * 每个 message_delta 更新一次，思考/正文都包含在 output_tokens 里），供
   * 速度实时采样；会话统计只在消息落盘时更新，单靠它速度表在整个生成期间
   * 都是 Δ=0。message_end 时统计已包含该消息，清零防重复；agent_end 兜底
   * 中断等未走 message_end 的路径。`sessionOutputTokens` 是此刻的会话累计
   * 输出（TTFT 时刻的基线取自它）。
   */
  public handle(event: AgentSessionEvent, sessionOutputTokens: number): void {
    if (event.type === "message_update" && event.message.role === "assistant") {
      this.runningTokens = event.message.usage?.output ?? this.runningTokens;
      // 本轮的首个流式输出事件＝首字符到达（firstOutputAt 早于本轮派发时刻
      // 说明还是上一任务的旧窗口）：刷新 TTFT 定格值、重开速度窗口；基线取
      // 此刻累计输出（含本消息已报的 usage，起始 token 不进平均）。
      if (this.isStaleWindow()) {
        const at = this.clock();
        this.lastTtft = this.promptStartedAt !== undefined ? at - this.promptStartedAt : undefined;
        this.firstOutputAt = at;
        this.outputAtFirst = sessionOutputTokens + this.runningTokens;
        this.generationEndedAt = undefined;
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.runningTokens = 0;
    } else if (event.type === "agent_end") {
      this.runningTokens = 0;
    }
  }

  /** 本轮首字符是否尚未到达（firstOutputAt 早于本轮派发时刻说明还是旧窗口）。 */
  private isStaleWindow(): boolean {
    return this.firstOutputAt === undefined
      || (this.promptStartedAt !== undefined && this.firstOutputAt < this.promptStartedAt);
  }

  /** 定格的首字符响应时间（毫秒）；undefined 表示还没有任何一次首字符。 */
  public get ttftMs(): number | undefined {
    return this.lastTtft;
  }

  /** 流式中当前消息的 running 输出 token（会话统计落盘前的增量）。 */
  public get runningOutputTokens(): number {
    return this.runningTokens;
  }

  /**
   * 任务级平均输出速度（tok/s）：时间窗从首个流式输出到本轮结束（输出中为
   * 当前时刻），分子是窗口基线之后的累计输出 token。首字符从未到达或窗长为
   * 零时 undefined。
   */
  public speed(sessionOutputTokens: number): number | undefined {
    if (this.firstOutputAt === undefined) return undefined;
    const liveWindow = this.prompting && this.promptStartedAt !== undefined
      && this.firstOutputAt >= this.promptStartedAt;
    const end = liveWindow ? this.clock() : this.generationEndedAt ?? this.firstOutputAt;
    const seconds = (end - this.firstOutputAt) / 1000;
    if (seconds <= 0) return undefined;
    return Math.max(0, sessionOutputTokens + this.runningTokens - this.outputAtFirst) / seconds;
  }
}
