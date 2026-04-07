# Telegram Plugin

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

```bash
claude mcp add telegram-unofficial \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e TELEGRAM_STATE_DIR=~/.claude/channels/telegram \
  -e TELEGRAM_ACCESS_MODE=pairing \
  -- bun run --cwd $PLUGIN_DIR --shell=bun --silent start
```

Or use the Claude Code plugin manager and point to this directory.

## Configuration

| Environment Variable | Description |
|---------------------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token from @BotFather |
| `TELEGRAM_STATE_DIR` | Directory for access control and state (default: `~/.claude/channels/telegram`) |
| `TELEGRAM_ACCESS_MODE` | `pairing` (default), `allowlist`, or `disabled` |

## Usage

After installation, Claude Code will automatically use this plugin for Telegram messages. The Markdown formatting will be automatically converted to Telegram-friendly HTML.

### Manual Reply Format

When using the reply tool, the default format is `markdown`, so you can write:

```
**Bold Text**
- Item 1
- Item 2
```

And it will render as properly formatted HTML in Telegram.
