# Telegram Plugin (Unofficial)

Telegram channel plugin for Claude Code with Markdown to HTML conversion.

## Features

- **Markdown to HTML auto-conversion** - Messages are automatically formatted as Telegram-friendly HTML
- **Nested list bullets** - `●` / `○` / `▪` for visual hierarchy
- **Default format: markdown** - No need to specify `format: 'html'` manually

### Formatting Examples

| Markdown | Telegram Output |
|----------|-----------------|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `` `code` `` | `code` |
| `- item` | ● item |
| `- nested` | ○ nested |

## Installation

### 1. Add as MCP server

```bash
claude mcp add telegram-unofficial \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e TELEGRAM_STATE_DIR=~/.claude/channels/telegram \
  -e TELEGRAM_ACCESS_MODE=pairing \
  -- bun run --cwd $PLUGIN_DIR --shell=bun --silent start
```

### 2. Enable channel on startup

```bash
claude --channels telegram-unofficial
```

Or add to your shell profile/aliases:

```bash
alias claude-tg='claude --channels telegram-unofficial'
```

### 3. Pair your account

1. Open Telegram and send any message to your bot
2. The bot will reply with a pairing code
3. In Claude Code, run: `/telegram:access pair <code>`
4. Lock down access: `/telegram:access policy allowlist`

## Configuration

| Environment Variable | Description |
|---------------------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token from @BotFather |
| `TELEGRAM_STATE_DIR` | Directory for access control and state (default: `~/.claude/channels/telegram`) |
| `TELEGRAM_ACCESS_MODE` | `pairing` (default), `allowlist`, or `disabled` |

## Upgrading

```bash
cd /path/to/claude-plugins/telegram
git pull
bun install
```

Then restart Claude Code.
