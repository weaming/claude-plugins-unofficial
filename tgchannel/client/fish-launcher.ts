import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

export type FishLauncher = {
  path: string
  cleanup: () => void
}

export type ResolvedFishCommand = {
  commandParts: string[]
  environment: Record<string, string>
  executable: string
}

type ProbeResult = {
  args: string[]
  env: Record<string, string | undefined>
}

const execFileAsync = promisify(execFile)
const IGNORED_ENVIRONMENT_NAMES = new Set(['SHLVL'])

function fishQuote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function getFishBootstrapCommands(commands: string[]): string[] {
  return [
    'function uname; echo Linux; end',
    'if test -f ~/.config/fish/config.fish; source ~/.config/fish/config.fish; end',
    'functions --erase uname',
    ...commands,
  ]
}

function getFishBootstrap(commands: string[]): string {
  return getFishBootstrapCommands(commands).join('; ')
}

function getFishListAssignment(variableName: string, values: string[]): string {
  const lines = [`set -l ${variableName} \\`]

  values.forEach((value, index) => {
    const continuation = index === values.length - 1 ? '' : ' \\'
    lines.push(`    ${fishQuote(value)}${continuation}`)
  })

  return lines.join('\n')
}

function getInheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function removeChannelArguments(argumentsList: string[]): string[] {
  const filteredArguments: string[] = []

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--dangerously-load-development-channels' || argument === '--channels') {
      index += 1
      continue
    }
    filteredArguments.push(argument)
  }

  return filteredArguments
}

function getEnvironmentOverrides(
  initialEnvironment: Record<string, string>,
  resolvedEnvironment: Record<string, string | undefined>,
  probeDirectory: string,
): Record<string, string> {
  const overrides: Record<string, string> = {}

  for (const [name, value] of Object.entries(resolvedEnvironment)) {
    if (
      value !== undefined
      && value !== initialEnvironment[name]
      && !IGNORED_ENVIRONMENT_NAMES.has(name)
    ) {
      overrides[name] = value
    }
  }

  if (overrides.PATH) {
    overrides.PATH = overrides.PATH
      .split(':')
      .filter(pathEntry => pathEntry !== probeDirectory)
      .join(':')
  }

  return overrides
}

async function findClaudeExecutable(): Promise<string> {
  const source = getFishBootstrap(['command -v claude'])
  const result = await execFileAsync('fish', ['--no-config', '-ic', source], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const executable = result.stdout.trim().split('\n').filter(Boolean).at(-1)

  if (!executable) {
    throw new Error('Fish 环境中找不到 claude 可执行文件')
  }

  return executable
}

export async function resolveFishCommand(commandParts: string[]): Promise<ResolvedFishCommand> {
  if (commandParts.length === 0) {
    throw new Error('至少需要一个 Claude 启动命令')
  }

  const initialEnvironment = getInheritedEnvironment()
  const probeDirectory = mkdtempSync(join(tmpdir(), 'tgchannel-probe-'))
  const probePath = join(probeDirectory, 'claude')
  const resultPath = join(probeDirectory, 'result.json')
  const probeSource = [
    '#!/usr/bin/env bun',
    "import { writeFileSync } from 'fs'",
    `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }), { encoding: 'utf8', mode: 0o600 })`,
    '',
  ].join('\n')

  writeFileSync(probePath, probeSource, { encoding: 'utf8', mode: 0o700 })
  chmodSync(probePath, 0o700)

  try {
    const source = getFishBootstrap([
      `set -gx PATH ${fishQuote(probeDirectory)} $PATH`,
      'set -l agent_launcher_profile $argv',
      "eval (string join -- ' ' (string escape -- $agent_launcher_profile))",
    ])

    await execFileAsync('fish', ['--no-config', '-ic', source, '--', ...commandParts], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })

    const probeResult = JSON.parse(readFileSync(resultPath, 'utf8')) as ProbeResult
    const executable = await findClaudeExecutable()
    const environment = getEnvironmentOverrides(initialEnvironment, probeResult.env, probeDirectory)

    environment.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'

    return {
      executable,
      commandParts: [executable, ...removeChannelArguments(probeResult.args)],
      environment,
    }
  } catch (error) {
    if (error instanceof Error && 'stderr' in error) {
      const stderr = String(error.stderr).trim()
      if (stderr) {
        throw new Error(`解析 Fish Claude 启动命令失败：${stderr}`)
      }
    }
    throw new Error(`解析 Fish Claude 启动命令失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true })
  }
}

export function createFishLauncher(
  commandParts: string[],
  environment: Record<string, string> = {},
): FishLauncher {
  if (commandParts.length === 0) {
    throw new Error('至少需要一个 Claude 启动命令')
  }

  const directory = mkdtempSync(join(tmpdir(), 'tgchannel-agent-'))
  const launcherPath = join(directory, 'claude-launcher.fish')
  const environmentCommands = Object.entries(environment)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `set -gx ${name} ${fishQuote(value)}`)
  const startupCommands = getFishBootstrapCommands([...environmentCommands, 'eval $argv[1]'])
  const source = [
    '#!/usr/bin/env fish',
    getFishListAssignment('agent_launcher_command', commandParts),
    'set -l agent_launcher_sdk_arguments $argv',
    "set -l agent_launcher_command_line (string join -- ' ' (string escape -- $agent_launcher_command) (string escape -- $agent_launcher_sdk_arguments))",
    getFishListAssignment('agent_launcher_startup_commands', startupCommands),
    "set -l agent_launcher_startup_script (string join -- '; ' $agent_launcher_startup_commands)",
    'exec fish --no-config -ic $agent_launcher_startup_script -- $agent_launcher_command_line',
    '',
  ].join('\n')

  writeFileSync(launcherPath, source, { encoding: 'utf8', mode: 0o700 })
  chmodSync(launcherPath, 0o700)

  return {
    path: launcherPath,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
