# Telegram Unofficial Plugin

Telegram channel plugin for Claude Code with Telegram Rich Markdown and multi-instance support.

## Features

- **Rich Markdown auto-conversion** - Messages are automatically sent with Telegram Rich Markdown
- **Nested list bullets** - `●` / `○` / `▪` for visual hierarchy
- **Multi-instance support** - Connect multiple Claude CLI instances and switch between them via Telegram buttons
- **Agent SDK instances** - Run `my-claude` instances alongside channel-based Claude CLI instances
- **Fish command bridge** - Agent SDK instances can launch a user-defined Fish `claude` function
- **Session reset IPC** - `tgchannel-reset` can reset an Agent SDK instance without restarting it

### Formatting Examples

| Markdown     | Telegram Output |
| ------------ | --------------- |
| `**bold**`   | **bold**        |
| `*italic*`   | _italic_        |
| `` `code` `` | `code`          |
| `- item`     | ● item          |
| `- nested`   | ○ nested        |

## Architecture

```
Telegram ←→ Center Manager ←→ Claude Client(s)
                    ↑
              Unix Socket

Center Manager tracks both `mcp` and `agent-sdk` instances. Agent SDK instances send their final Markdown output directly to Center Manager, which converts it to Telegram Rich Markdown.
```

## Installation

Install dependencies first:

```fish
cd tgchannel
bun install
```

Install the Center Manager as a standalone executable:

```fish
bun build --compile --minify --target bun --sourcemap=none \
    --outfile ~/.bun/bin/tgchannel-server server/index.ts
```

Install the Agent SDK CLI entry points as source-backed launchers:

```fish
mkdir -p ~/.bun/bin
ln -sf "$PWD/client/my-claude.ts" ~/.bun/bin/my-claude
ln -sf "$PWD/client/reset-session.ts" ~/.bun/bin/tgchannel-reset
```

Make sure `~/.bun/bin` is in `PATH`. You can then run `tgchannel-server`, `my-claude`, and `tgchannel-reset` from anywhere.

Start an Agent SDK instance with any Fish `claude` command or function:

```fish
my-claude claude
my-claude claude-deepseek
my-claude claude-aliyun
```

The Fish command is resolved when `my-claude` starts. Restart the instance after changing its function or environment settings.

## Connect Claude

Restart Claude Code with the plugin loaded:

```fish
claude --dangerously-load-development-channels plugin:tgchannel@weaming-plugins
```

Multiple Claude CLI instances can connect. Only the **active instance** receives Telegram messages.

## Switching Instances

In Telegram, use `/switch` to list all connected instances and tap a button to switch.
Use `/status` to inspect the active instance, session, model, working directory, and Agent SDK token totals.
Use `/clear` to reset the active Agent SDK session.
