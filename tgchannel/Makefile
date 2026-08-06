install-all: install-server install-my-claude

install-server:
	bun build --compile --minify --target bun --sourcemap=none --outfile ~/.bun/bin/tgchannel-server server/index.ts

install-my-claude:
	bun build --compile --minify --target bun --sourcemap=none --outfile ~/.bun/bin/my-claude client/my-claude.ts