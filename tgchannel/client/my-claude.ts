#!/usr/bin/env bun

import { runAgentRunner } from './agent-runner.js'

const commandParts = process.argv.slice(2)

if (commandParts.length === 0) {
  process.stderr.write('用法：my-claude <claude 启动命令及参数>\n')
  process.exit(1)
}

runAgentRunner(commandParts).catch(error => {
  process.stderr.write(`my-claude 启动失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
