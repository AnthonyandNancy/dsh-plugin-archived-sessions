const pageUrl = process.argv[2]
const httpBase = process.argv[3].replace(/\/$/, '')
const bundlePath = process.argv[4] ?? 'plugins/??dsh-plugin-archived-sessions/client.js'

const list = await (await fetch(`${httpBase}/json/version`)).json()
const ws = new WebSocket(list.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
let sessionId

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const resolve = pending.get(message.id)
    pending.delete(message.id)
    resolve(message)
  }
})
await new Promise(resolve => ws.addEventListener('open', resolve))

const send = (method, params = {}, useSession = true) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params, ...(useSession ? { sessionId } : {}) }))
})

const { result: { targetId } } = await send('Target.createTarget', { url: pageUrl }, false)
const attached = await send('Target.attachToTarget', { targetId, flatten: true }, false)
sessionId = attached.result.sessionId
await send('Runtime.enable')
await send('Page.enable')
await new Promise(resolve => setTimeout(resolve, 20000))

const evaluate = async expression => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    return `<<throw>> ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
  }
  return result.result?.value
}

const url = new URL(bundlePath, pageUrl).href
console.log(await evaluate(`(async () => {
  const response = await fetch(${JSON.stringify(url)}, { credentials: 'same-origin' })
  const text = await response.text()
  return JSON.stringify({
    url: ${JSON.stringify(url)},
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes: text.length,
    head: text.slice(0, 220),
    tail: text.slice(-160),
    loadCalls: (text.match(/__ModuleLoader__/g) ?? []).length,
    windowRefs: (text.match(/window\\.__ModuleLoader__/g) ?? []).length,
    globalThisRefs: (text.match(/globalThis\\.__ModuleLoader__/g) ?? []).length,
  }, null, 2)
})()`))

ws.close()
process.exit(0)
