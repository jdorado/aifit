const { execFileSync, spawn } = require('node:child_process')

const port = Number(process.env.PORT || 5175)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port')
}

const listenerPids = () => {
  try {
    return execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isSafeInteger)
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
}

const commandFor = (pid) => execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()

const waitForPortToClear = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (listenerPids().length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`AIFit development server did not release port ${port}`)
}

const restartExistingDevServer = async () => {
  const pids = listenerPids()
  if (pids.length === 0) return
  const listeners = pids.map((pid) => ({ pid, command: commandFor(pid) }))
  if (listeners.some(({ command }) => !/webpack(?:-dev-server)?(?:\s|\/|$)/.test(command))) {
    throw new Error(`Port ${port} is in use by a non-AIFit process; it was left untouched.`)
  }
  for (const { pid } of listeners) process.kill(pid, 'SIGTERM')
  await waitForPortToClear()
}

const main = async () => {
  await restartExistingDevServer()
  const webpackCli = require.resolve('webpack-cli/bin/cli.js')
  const child = spawn(process.execPath, [webpackCli, 'serve', '--config', 'webpack.config.cjs', '--mode', 'development', '--host', '127.0.0.1', '--port', String(port)], {
    stdio: 'inherit',
  })
  child.once('error', (error) => { throw error })
  child.once('exit', (code, signal) => process.exitCode = signal ? 1 : code ?? 1)
}

void main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
