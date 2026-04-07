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
/plugin install telegram@claude-plugins-unofficial
/reload-plugins
```

## Configuration

```bash
/telegram:configure <token>
```

## Enable Channel

Restart Claude Code with:

```bash
claude --channels plugin:telegram@claude-plugins-unofficial
```

## Pair Your Account

1. Open Telegram and send any message to your bot
2. The bot will reply with a pairing code
3. In Claude Code, run: `/telegram:access pair <code>`
4. Lock down access: `/telegram:access policy allowlist`

## Upgrading

```bash
/plugin marketplace update claude-plugins-unofficial
```
