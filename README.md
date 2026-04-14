# Claude Plugins Unofficial

Unofficial plugin marketplace for Claude Code.

## Available Plugins

| Plugin                    | Description                                       |
| ------------------------- | ------------------------------------------------- |
| [tgchannel](./tgchannel/) | Telegram channel with Markdown to HTML conversion |

## Installation

```bash
# Add this marketplace
/plugin marketplace add weaming/claude-plugins-unofficial

# Install a plugin
/plugin install tgchannel@weaming-plugins
```

## Plugin Structure

Each plugin follows the standard Claude Code plugin structure:

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json      # Plugin metadata (required)
├── .mcp.json            # MCP server configuration
├── commands/            # Slash commands (optional)
└── README.md            # Documentation
```
