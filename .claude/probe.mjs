// Minimal CDP driver: navigate a headless Chrome to the dsh web page and
// report what the client rendered, plus every console error/exception.
const baseUrl = process.argv[2]
const httpBase = (process.argv[3] ?? baseUrl).replace(/\/$/, '')

const list = await (await fetch(`${httpBase}/json/version`)).json()
console.log('browser:', list.Browser)

const ws = new WebSocket(list.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const events = []

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const resolve = pending.get(message.id)
    pending.delete(message.id)
    resolve(message)
    return
  }
  events.push(message)
})

await new Promise(resolve => ws.addEventListener('open', resolve))

const send = (method, params = {}, sessionId) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })

await send('Runtime.enable', {}, sessionId)
await send('Log.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

const exceptions = []
const consoleMessages = []

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.sessionId !== sessionId) return
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    exceptions.push(details.exception?.description ?? details.text)
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleMessages.push(`${message.params.type}: ${message.params.args.map(a => a.description ?? JSON.stringify(a.value)).join(' ')}`)
  }
})

await send('Page.navigate', { url: baseUrl }, sessionId)
await new Promise(resolve => setTimeout(resolve, 25000))

const evaluate = async expression => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  return result.result?.value
}

console.log('\n=== #root 内容长度 ===')
console.log(await evaluate('document.getElementById("root")?.innerHTML.length ?? -1'))

console.log('\n=== #root HTML 片段 ===')
console.log((await evaluate('(document.getElementById("root")?.innerHTML ?? "").slice(0, 1200)')))

console.log('\n=== body 可见文本片段 ===')
console.log(await evaluate('document.body.innerText.slice(0, 600)'))

console.log('\n=== 已注册客户端模块 id ===')
console.log(await evaluate('JSON.stringify((window.__ModuleLoader__?.pendingQueue ?? []).map(r => r.id))'))
console.log('module system mode:', await evaluate('String(window.__ModuleLoader__?.mode)'))
console.log('boot graph entries:', await evaluate('String(globalThis.__DSH_BOOT__?.entries?.length)'))

console.log('\n=== 未捕获异常 ===')
console.log(exceptions.join('\n---\n') || '(无)')

console.log('\n=== console 输出 ===')
console.log(consoleMessages.join('\n') || '(无)')

ws.close()
process.exit(0)
