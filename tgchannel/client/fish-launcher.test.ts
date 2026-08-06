import { afterEach, expect, test } from 'bun:test'
import { createFishLauncher, type FishLauncher } from './fish-launcher.js'

const launchers: FishLauncher[] = []

afterEach(() => {
  while (launchers.length > 0) {
    launchers.pop()!.cleanup()
  }
})

test('Fish launcher appends SDK arguments to the supplied command', async () => {
  const launcher = createFishLauncher(['printf', '%s|%s'])
  launchers.push(launcher)

  const process = Bun.spawn([launcher.path, 'first', 'second'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(process.stdout).text()

  expect(await process.exited).toBe(0)
  expect(output).toBe('first|second')
})

test('Fish launcher preserves arguments containing spaces', async () => {
  const launcher = createFishLauncher(['printf', '%s'])
  launchers.push(launcher)

  const process = Bun.spawn([launcher.path, 'value with spaces'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(process.stdout).text()

  expect(await process.exited).toBe(0)
  expect(output).toBe('value with spaces')
})

test('Fish launcher passes option-like SDK arguments through', async () => {
  const launcher = createFishLauncher(['printf', '%s|%s'])
  launchers.push(launcher)

  const process = Bun.spawn([launcher.path, '--output-format', 'stream-json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(process.stdout).text()

  expect(await process.exited).toBe(0)
  expect(output).toBe('--output-format|stream-json')
})

test('Fish launcher applies resolved environment before starting Claude', async () => {
  const launcher = createFishLauncher(
    ['sh', '-c', 'printf %s "$TGCHANNEL_TEST_VALUE"'],
    { TGCHANNEL_TEST_VALUE: 'value from profile' },
  )
  launchers.push(launcher)

  const process = Bun.spawn([launcher.path], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(process.stdout).text()

  expect(await process.exited).toBe(0)
  expect(output).toBe('value from profile')
})
