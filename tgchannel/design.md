# tgchannel 多实例架构与实现设计

## 背景

当前实现由 Center Manager 统一连接 Telegram，并同时管理两类 Claude 实例：传统 MCP channel 实例和 Agent SDK 实例。任一时刻只有活跃实例接收 Telegram 消息。

- **中心管理器**：一个独立进程连接 Telegram Bot，路由消息到指定 Claude CLI
- **多个 Claude CLI 实例**：各自运行，通过 IPC（如 unix socket / HTTP）与中心管理器通信
- **Telegram 内切换**：通过按钮列表选择与哪个 Claude 实例交互

---

## 一、Claude Plugin 工作原理

来源：`~/src/skills/docs/claude/en/agent-sdk/plugins.md` + `channels-reference.md`

### 架构

```
my-plugin/
├── .claude-plugin/plugin.json      # 元数据（可选）
├── skills/                         # prompt 注入，无运行时
│   └── my-skill/SKILL.md
├── .mcp.json                       # MCP 服务器声明
└── server.ts                       # MCP 实际运行进程（通过 stdio 与 Claude 通信）
```

### 核心通信机制

1. **MCP 服务器（stdio）**：MCP 服务器作为子进程启动，通过 stdin/stdout 使用 JSON-RPC 通信。
2. **传统 MCP 实例**：通过 `notifications/claude/channel` 将外部事件注入 Claude 会话，消息可带 channel 元信息。
3. **Agent SDK 实例**：Agent SDK 直接调用 Claude Code `query()`；Telegram 正文作为普通 user prompt，`chat_id` 等元信息放入 system prompt 末尾。
4. **回复格式**：Agent SDK Runner 将 query 的最终普通文本通过 Unix socket 发送给 Center Manager；Center Manager 负责 Markdown 到 Telegram HTML 的转换。
5. **MCP 工具调用**：传统 MCP 实例仍通过 Telegram MCP 工具发送回复、反应、编辑消息和下载附件。

### 关键文件

| 文件          | 用途                                  |
| ------------- | ------------------------------------- |
| `.mcp.json`   | 声明如何启动 MCP 服务器               |
| `plugin.json` | 插件元数据、声明 channels 能力        |
| `server/index.ts` | Center Manager、Telegram Bot 和 Unix socket 服务 |
| `client/mcp.ts` | 传统 channel 模式的 Telegram MCP |
| `client/agent-runner.ts` | Agent SDK query、会话和控制 IPC |

---

## 二、~/.claude 目录结构

来源：实际探索

```
~/.claude/
├── settings.json              # 主配置（model, permissions, plugins）
├── sessions/                  # 按 PID 区分的会话 {pid}.json
│   └── {pid}.json            # pid, sessionId(UUID), cwd, startedAt, kind
├── session-env/              # 按 UUID 的空目录
├── transcripts/              # 会话记录 ses_{hash}.jsonl
│   └── ses_{hash}.jsonl      # 完整对话历史
├── projects/                 # 按项目路径隔离
│   └── -Users-.../           # 项目名作为目录名
│       └── {sessionId}.jsonl
├── plugins/                  # 插件相关
│   ├── installed_plugins.json
│   ├── cache/                # 插件包缓存
│   └── marketplaces/         # 市场 git 克隆
├── channels/                 # Channel 配置（如 tgchannel）
│   └── tgchannel/
│       ├── .env              # BOT_TOKEN
│       ├── access.json       # 允许列表
│       ├── telegram-channel.pid  # leader PID
│       └── inbox/            # 下载的附件
└── skills/                   # 技能符号链接
```

### 多实例区分方式

- **Session ID (UUID)**：每个 Claude CLI 启动时生成 UUID，存于 `sessions/{pid}.json`
- **PID**：操作系统进程 ID，用于 leader election
- **项目路径**：`projects/` 下按 cwd 隔离

---

## 三、整体架构设计

```
                    Telegram
                        │
                  ┌─────┴─────┐
                  │  Center   │  ← 独立进程，管理 Telegram 连接
                  │  Manager  │    (compiled Bun server)
                  └─────┬─────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    Unix Socket     Unix Socket    Unix Socket
         │              │              │
    ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
    │Claude A │    │Claude B │    │Claude C │
    └─────────┘    └─────────┘    └─────────┘
```

### 组件

1. **Center Manager** (`server/`)
   - 独立运行的 Telegram Bot 进程
   - 维护"当前活跃 Claude 实例"状态
   - 通过 unix socket 与各 Claude 实例通信
   - 通过 Unix socket 提供实例注册、切换、消息转发、会话重置和状态查询

2. **Claude 客户端**
   - MCP 实例通过 `notifications/claude/channel` 接收消息
   - Agent SDK 实例通过 `agent-runner.ts` 调用 SDK，并直接将最终文本发送到 Center Manager

3. **Telegram UI 按钮**
   - 每次交互后更新消息/发送新消息，显示所有实例按钮
   - 按钮样式：`[Claude A - "hi buddy"] [Claude B - "hello"]`
   - 选择按钮 → 通知 Center Manager 切换 → 下一条消息路由到新实例

---

## 四、详细设计

### 4.1 目录结构

```
tgchannel/
├── .claude-plugin/
│   └── plugin.json      # 插件元数据
├── .mcp.json            # 传统 MCP channel 声明
├── server/
│   ├── index.ts      # Center Manager：Telegram bot + Unix socket
│   ├── session-store.ts      # 管理已注册的 Claude 实例
│   └── socket-server.ts      # Unix socket 消息类型
├── client/
│   ├── mcp.ts             # 传统 channel Telegram MCP 工具
│   ├── agent-output.ts    # Agent SDK 最终输出到 Telegram reply 的转换
│   ├── agent-runner.ts    # Agent SDK 会话、状态和控制 IPC
│   ├── fish-launcher.ts   # Fish profile 解析与 Claude wrapper
│   ├── my-claude.ts       # Agent SDK CLI
│   └── reset-session.ts   # reset_session IPC CLI
└── package.json
```

### 4.2 实例注册机制

每个 Claude CLI 启动时，通过 unix socket 发送注册消息：

```typescript
// 注册消息
{
  type: 'register',
  sessionId: 'uuid-xxx',
  kind: 'mcp' | 'agent-sdk',
  pid: process.pid,
  label: 'Claude A',           // 可配置，默认 "Claude {pid}"
  lastMessage: 'hello buddy',   // 最近一条用户消息的前 N 字
  cwd: process.cwd()
}
```

Center Manager 维护实例列表，按最后消息时间排序。

### 4.3 消息路由

1. Telegram 消息到达 Center Manager
2. Center Manager 检查"当前活跃实例"
3. 消息转发到活跃实例的 unix socket
4. 根据实例类型处理：
   - MCP：MCP server 发送 `notifications/claude/channel`
   - Agent SDK：Runner 将正文直接作为 `query()` 的 user prompt，并把 Telegram 元信息追加到 system prompt 末尾
5. Agent SDK Runner 或 MCP client 通过 Unix socket 发送回复
6. Center Manager 将 Markdown 转成 Telegram HTML 后发送

### 4.4 切换机制

**方式一：按钮点击**

- Center Manager 在每条消息回复时更新 Inline Keyboard
- 按钮：`[label|last_msg_preview]` 如 `[Claude A|hi buddy]`
- 点击触发 `callback_query` → 解析 instance ID → 更新活跃实例

**方式二：命令**

- Telegram `/switch` 显示实例列表并通过 Inline Keyboard 切换
- `tgchannel-reset` 通过 Unix socket 重置指定 Agent SDK 实例

### 4.5 活跃实例与回复路由

关键问题：多个 Claude 实例都收到同一份消息，如何避免重复回复？

**当前设计**：只有"活跃实例"会收到 forward 消息，非活跃实例不注入 channel 事件，也不会调用 Agent SDK。

但需要解决：Center Manager 如何知道哪个实例是"活跃"的？

**方案**：

- 每个实例连接后默认都是"待命"状态
- 第一个连接注册为"当前活跃"
- 用户在 TG 点击按钮切换
- Center Manager 将活跃信息通过 socket 通知各实例
- 非活跃实例不处理 channel 消息（丢弃或忽略）

### 4.6 消息格式

**注册消息**

```json
{
  "type": "register",
  "sessionId": "454d11ae-ba25-4424-b60d-1d9b0a7ba3bb",
  "pid": 12345,
  "label": "Claude A",
  "lastMessage": "hi buddy",
  "cwd": "/Users/garden/src"
}
```

**切换消息**

```json
{
  "type": "switch",
  "toSessionId": "454d11ae-ba25-4424-b60d-1d9b0a7ba3bb"
}
```

**转发消息**

```json
{
  "type": "forward",
  "sessionId": "454d11ae-ba25-4424-b60d-1d9b0a7ba3bb",
  "content": "hello",
  "meta": {"chat_id": "123", "message_id": 456, "user": "weaming"}
}
```

**控制消息**

```json
{
  "type": "status",
  "sessionId": "agent-xxx",
  "requestId": "uuid-xxx"
}
```

`reset_session` 使用相同格式但 type 为 `reset_session`。Agent SDK Runner 对 `reset_session` 返回新会话状态，对 `status` 返回模型、PWD、PID、session ID 和累计 token。Telegram `/clear` 和 `/status` 都通过这条控制链路工作。

**回复消息**

```json
{
  "type": "reply",
  "sessionId": "454d11ae-ba25-4424-b60d-1d9b0a7ba3bb",
  "chat_id": "123",
  "text": "Hello!"
}
```

---

## 五、实现任务

### Phase 1: Center Manager 核心

1. 创建 `server/index.ts`
   - Telegram long polling
   - 管理实例注册表（sessionId → socket 连接）
   - 处理 `callback_query` 切换活跃实例
   - 消息路由到当前活跃实例

2. 创建 `server/session-store.ts`
   - 维护活跃实例
   - 实例列表（label, lastMessage, sessionId, pid）
   - 按最后消息时间排序

3. 创建 `server/socket-server.ts`
   - Unix socket 监听
   - 处理 register/switch/forward/reply 消息

### Phase 2: Claude Client 插件

4. 创建 `client/mcp.ts`
   - 连接 Center Manager unix socket
   - 发送注册消息
   - 接收 forward 消息并转发 MCP 通知；Agent SDK 消息由 `agent-runner.ts` 处理
   - 接收 switch 消息更新状态
   - 处理 `reply` 工具调用，发送回复到 socket

5. 配置根目录 `.mcp.json`
   - 当前由根目录 `.mcp.json` 声明传统 MCP 服务器

### Phase 3: 整合与 UI

6. 修改 Telegram 消息处理
   - 显示实例切换按钮
   - Inline keyboard 样式

7. 增加 Telegram 管理命令
   - `/switch`、`/status`、`/clear`

### Phase 4: Agent SDK 扩展

8. `my-claude <fish command>` 启动 Agent SDK Runner
9. 启动时解析 Fish function，提取真实 Claude 可执行文件、参数和环境
10. 每条消息调用 Agent SDK `query()`，通过 `resume` 继续 Runner 当前 session
11. 通过 `reset_session`、`status` IPC 管理会话和状态

---

## 六、关键文件

| 操作      | 文件路径                            |
| --------- | ----------------------------------- |
| ✅ 新建   | `tgchannel/server/index.ts`         |
| ✅ 新建   | `tgchannel/server/session-store.ts` |
| ✅ 新建   | `tgchannel/server/socket-server.ts` |
| ✅ 新建   | `tgchannel/.mcp.json`               |
| ✅ 新建   | `tgchannel/package.json`             |
| ✅ 新建   | `tgchannel/client/mcp.ts`           |
| ✅ 新建   | `tgchannel/client/agent-runner.ts` |
| ✅ 新建   | `tgchannel/client/my-claude.ts` |
| ✅ 新建   | `tgchannel/client/reset-session.ts` |
| ✅ 新建   | `tgchannel/client/fish-launcher.ts` |
| ✅ 已实现 | `tgchannel/.claude-plugin/plugin.json` |
| ✅ 已实现 | 权限控制（access.json 检查）        |
| ⏳ 待完成 | 完整 Telegram 集成测试              |

---

## 七、实现状态

### 已完成

1. **server/**
   - `session-store.ts` - 实例注册、活跃管理
   - `socket-server.ts` - Unix socket 框架
   - `index.ts` - Telegram 连接、消息路由、按钮 UI、callback_query 处理
   - `.mcp.json` / `package.json` - 项目配置

2. **client/**
   - `agent-runner.ts` - Agent SDK 会话、消息队列、status 和 reset_session IPC
   - `fish-launcher.ts` - 加载用户 Fish 配置、解析 profile 并启动自定义命令
   - `my-claude.ts` - Agent SDK 实例入口
   - `reset-session.ts` - reset_session IPC 测试入口
   - `mcp.ts` - 支持传统 channel 模式
   - `agent-output.ts` - 构造 Agent SDK 的 Telegram Markdown 回复
   - `.mcp.json` - 项目配置

### 当前限制

1. `my-claude` 重启后不会自动恢复上一次 Runner 的 session ID；旧 session 文件仍保留，但需要显式恢复。
2. Agent SDK 不显式挂载当前插件的 Telegram MCP；Claude 默认 MCP 加载行为保持不变。最终普通文本通过 Unix socket 发送给 Center Manager，由 Center Manager 负责 Telegram 格式转换。
3. `/status` 的 token 是当前 Runner 生命周期内累计值，不是历史 session 文件的全量统计。
4. 完整 Telegram 集成测试仍待补充。

### 设计确认

- **Center**: 单一实例运行，管理 Telegram 连接和所有客户端 socket
- **Client**: MCP 客户端负责 channel 或工具转发；Agent SDK 客户端负责 query、session、状态和控制 IPC
- **切换**: 用户在 TG 发 `/switch` → Center 回复实例列表 + Inline Buttons → 点击切换活跃实例
- **消息路由**: 只有活跃实例收到 forward 通知；非活跃实例忽略；所有客户端的回复都会发回 center（center 校验是否是活跃实例）

---

## 八、验证方式

1. 安装依赖：`cd tgchannel && bun install`
2. 启动 Center Manager：`tgchannel-server`
3. 启动传统实例：按正常方式启动 Claude，并加载 channel MCP
4. 启动 Agent SDK 实例：`my-claude claude` 或 `my-claude claude-deepseek`
5. 在 Telegram 使用 `/switch`、`/status`、`/clear` 验证实例管理

---

## 九、启动方式

### Center Manager（需先启动）

```bash
cd /Users/garden/src/claude-plugins-unofficial/tgchannel
bun install
bun build --compile --minify --target bun --sourcemap=none \
  --outfile ~/.bun/bin/tgchannel-server server/index.ts
```

### MCP Claude CLI

按插件方式加载 channel MCP。

### Agent SDK CLI

```fish
my-claude claude
my-claude claude-deepseek
my-claude claude-aliyun
```

Fish function 会在 Runner 启动时解析，实际 Claude 子进程在收到第一条 Telegram 消息时由 Agent SDK 启动。Agent SDK 使用 Claude Code 默认 system prompt，并加载 `user`、`project`、`local` 设置源及 `CLAUDE.md`；最终文本由 Runner 通过 Unix socket 发送到 Center Manager。

---

## 更新记录

- 2026-04-14：初稿，基于 plugin 架构和 channels 文档
- 2026-04-14：完成 server/ 和 client/ 目录结构和核心文件
- 2026-04-14：修复 NetSocket 类型，添加 switch skill
- 2026-04-14：确认设计 - center 单实例，client 无状态，/switch 在 TG 内切换
- 2026-08-06：完成 MCP 与 Agent SDK 双实例架构，加入 Fish profile、`/clear`、`/status` 和 token 统计
- 2026-08-06：Agent SDK 改为不挂载 MCP，最终输出直接通过 Center Manager 转换为 Telegram 格式
