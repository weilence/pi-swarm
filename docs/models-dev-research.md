# models.dev 与 Pi provider/model 配置研究

> 调查日期：2026-09-02  
> 范围：为 pi-swarm 设计 `/provider`（供应商 + Pi API 类型）和 `/model`（供应商模型）命令时，核对 models.dev 原数据格式与 Pi 0.84.4 的第一方配置契约。

## 结论摘要

1. `https://models.dev/api.json` 是按 provider ID 索引的 JSON 原数据。每个 provider 至少包含 `id`、`name`、`env`、`npm`、可选 `api`（对 OpenAI-compatible provider 来说是默认 endpoint/base URL）和 `models`；每个模型以模型 ID 为 key，并包含 `id`、`name`、能力、模态、上下文限制、价格等元数据。
2. models.dev 的 `npm` 字段表示 AI SDK provider 包（例如 `@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/openai-compatible`），不是 Pi 的 `api` wire-protocol 类型。models.dev 的 `api` 字段通常是 URL，而 Pi `models.json` 的 `api` 字段是固定 API 类型字符串，不能直接复制。
3. Pi 的 `~/.pi/agent/models.json` 支持自定义 provider：provider 级 `baseUrl`、`api`、`apiKey`、headers、compat，以及模型数组；模型可以覆盖 `id`、`name`、`api`、reasoning、input、contextWindow、maxTokens、cost 等。官方文档明确支持 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。
4. SDK 的 `ModelRuntime` 能从自定义 `modelsPath` 加载模型并通过 `getModel(providerId, modelId)` 查询；会话使用 `session.setModel(model)` 切换。Pi 的 `/model` 会重载 models 配置，因此文件编辑可在会话中生效；pi-swarm 若要提供 `/provider`，应在自己的运行时生成/更新受控 models 文件，然后刷新或重建 runtime，并重新绑定 session。

## models.dev 原数据

### 官方 API 与仓库说明

- API：[`https://models.dev/api.json`](https://models.dev/api.json)
- provider-agnostic 模型元数据：[`https://models.dev/models.json`](https://models.dev/models.json)
- 合并 provider endpoint 与模型元数据：[`https://models.dev/catalog.json`](https://models.dev/catalog.json)
- 官方仓库 README（API、字段及 TOML 来源）：[`sst/models.dev README`](https://github.com/sst/models.dev/blob/master/README.md#api)

README 给出的最小调用是：

```bash
curl https://models.dev/api.json
```

README 还说明：模型 ID 是 AI SDK 使用的标识；`models/` 存放与 provider 无关的事实，`providers/<id>/models/` 存放 provider-specific serving details；provider 的字段在生成时覆盖 `base_model` 继承来的模型字段（见 [`README#adding-model-metadata`](https://github.com/sst/models.dev/blob/master/README.md#adding-model-metadata)）。

### provider 形状（实测原数据）

以 API 当前返回的 provider 为例（不把数据快照提交到仓库，以免模型目录过时）：

```json
{
  "id": "openrouter",
  "env": ["OPENROUTER_API_KEY"],
  "npm": "@openrouter/ai-sdk-provider",
  "api": "https://openrouter.ai/api/v1",
  "name": "OpenRouter",
  "doc": "https://openrouter.ai/docs",
  "models": {
    "openai/gpt-4o": {
      "id": "openai/gpt-4o",
      "name": "...",
      "reasoning": false,
      "tool_call": true,
      "modalities": {"input": ["text"], "output": ["text"]},
      "limit": {"context": 128000, "output": 16384},
      "cost": {"input": 2.5, "output": 10}
    }
  }
}
```

字段要点：

- `env` 是该 provider 认证所需的环境变量名列表；它不是密钥值。
- `npm` 是 Vercel AI SDK/provider 包名。比如当前原数据中 Anthropic 为 `@ai-sdk/anthropic`，OpenAI 为 `@ai-sdk/openai`，Google 为 `@ai-sdk/google`，而 HPC-AI、OpenRouter 等兼容端点使用 `@ai-sdk/openai-compatible` 或专用兼容包。
- `api` 在兼容 provider 上是默认 HTTP endpoint（如 `https://.../v1`）；对原生 Anthropic/OpenAI/Google provider 常为空，由 SDK provider 决定 endpoint。
- `models` 是对象，不是数组；对象 key 通常与模型的 `id` 相同。
- 模型元数据包括 `reasoning`、`tool_call`、`structured_output`、`temperature`、`modalities`、`limit`、`cost`、`release_date` 等。原数据可增加字段，客户端应容忍未知字段。

### 对 `/provider` 与 `/model` 的映射建议

models.dev 可作为可搜索目录，但生成 Pi 配置时需要显式转换：

| models.dev | Pi `models.json` | 处理 |
|---|---|---|
| provider object key / `id` | provider key / `id` | 保持稳定 ID |
| `name` | provider `name` | 直接复制 |
| `env` | provider `apiKey` 的环境变量引用 | 例如 `"$OPENROUTER_API_KEY"`；不要写回实际 secret |
| `api` URL | provider/model `baseUrl` | 仅当有 URL 时映射 |
| `npm` | **无直接对应字段** | 由实现决定 Pi `api` 类型；不要把 npm 包名填进 Pi `api` |
| model object key / `id` | model `id` | 保持上游模型 ID（包括 `/`） |
| `name` | model `name` | 显示标签 |
| `reasoning`、`modalities`、`limit`、`cost` | `reasoning`、`input`、`contextWindow`、`maxTokens`、`cost` | 需做字段名/单位转换（models.dev 价格为每百万 token） |
| `tool_call` | Pi 模型是否可用于 coding agent 的能力校验 | 不能忽略；Pi AI 只收录支持工具调用的模型 |

关键设计：`/provider` 应选择目录 provider，再让用户选择“Pi API 类型”（而不是选择 `npm` 包）；`/model` 只列出该 provider 的 models，并检查认证、base URL 和 API 类型是否足够。

## Pi 0.84.4 的第一方契约

### `models.json` 文件

- 官方文档：[`packages/coding-agent/docs/models.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- 默认路径：`~/.pi/agent/models.json`
- 官方最小例子：provider 的 `baseUrl`、`api`、`apiKey`、`models` 数组，例如 Ollama 使用 `api: "openai-completions"`。
- 文件在打开 `/model` 时重载，无需重启；无认证的模型会加载但不会出现在可用 `/model` 列表中（除非通过 auth 文件、`/login` 或 `--api-key` 配置认证）。

Pi provider 配置字段（官方表格）：

| 字段 | 作用 |
|---|---|
| `baseUrl` | API endpoint URL；定义自定义 models 时通常必需 |
| `api` | API wire protocol；可 provider 级设置，也可 model 级覆盖 |
| `apiKey` | 字面量、`$ENV_VAR`/`${ENV_VAR}` 插值或 `!command`；不要持久化明文 secret |
| `headers` | 自定义 header，支持同样的值解析语法 |
| `authHeader` | 是否自动添加 `Authorization: Bearer <apiKey>` |
| `models` | 模型定义数组 |
| `modelOverrides` | 覆盖内置/扩展 provider 的单模型属性 |
| `compat` | OpenAI/Anthropic 兼容性开关，可 provider/model 两级设置 |

模型配置的关键字段是 `id`（发送给 API）、可选 `name`、可选模型级 `api`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost`、`compat`。完整字段表见 [`models.md#model-configuration`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md#model-configuration)。

### Pi 支持的 API 类型

官方列表见 [`models.md#supported-apis`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md#supported-apis)：

| API id | 协议 |
|---|---|
| `openai-completions` | OpenAI Chat Completions（兼容性最广） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

底层 `@earendil-works/pi-ai` 还公开其他 API 实现：`openai-codex-responses`、`azure-openai-responses`、`google-vertex`、`mistral-conversations`、`bedrock-converse-stream`。这些属于 Pi AI 的 API implementation 表，不一定都能通过普通 `models.json` provider 配置直接使用；是否暴露给 `/provider` 应以当前版本的 `ModelRuntime` 注册 provider 为准。参考 [`pi-ai README#calling-api-implementations-directly`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/README.md#calling-api-implementations-directly)。

Pi AI 对 provider 与 API 的关系是：provider 拥有模型目录、认证和 stream 行为；多个 provider 可以共享一个 wire API。官方明确示例是 Anthropic 使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，xAI/Groq/Cerebras/OpenRouter 等多使用 `openai-completions`。参考 [`pi-ai README#providers-and-models`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/README.md#providers-and-models)。

### SDK 运行时接口

官方 SDK 文档：[`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)。

```ts
const modelRuntime = await ModelRuntime.create({
  modelsPath: "/path/to/models.json",
});

const model = modelRuntime.getModel("my-provider", "my-model");
await session.setModel(model!);
```

`ModelRuntime.create()` 默认使用 `~/.pi/agent/models.json` 与 `auth.json`，也可以指定 `modelsPath`；`getModel(providerId, modelId)` 返回包含自定义模型的模型对象；`session.setModel(model)` 在当前会话切换模型。若目录是动态来源，`modelRuntime.refresh()` 可显式刷新（网络刷新有超时/缓存策略）。

## 对 pi-swarm 实现的边界与风险

- models.dev 是实时社区数据库，不应在每次输入 `/model` 时无缓存地依赖网络；建议缓存原数据、显示更新时间，并允许离线使用 Pi 自己的 `models-store.json`。
- 不应把 models.dev 的 `npm` 作为用户可任意选择并动态 `import()` 的 SDK 名称；运行时依赖必须已安装，且 Pi provider 还需要正确 auth/stream 实现。更安全的 `/provider` 是选择已注册 Pi provider，并选择 API 类型作为配置/校验字段。
- 对自定义 OpenAI-compatible endpoint，通常生成 `api: "openai-completions"`、provider `baseUrl` 和 `$ENV_VAR` API key；对 Anthropic-compatible endpoint 使用 `anthropic-messages`；不能仅凭 provider 名称猜测协议。
- `/provider` 切换若改变 `baseUrl` 或 API 类型，应先更新受控 `models.json`，再执行 `ModelRuntime.refresh()` 或重建 `AgentSession`；已有会话的 `session.setModel()` 只能切换到已经注册并可用的 `Model`。
- models.dev 元数据中的 `tool_call` 对 coding agent 是硬约束候选；Pi AI README 说明其模型库只包含支持 tool calling 的模型，目录中缺少该能力时应在 UI 中标警告或过滤。

