// Inspect the live client module system: its shape, the archived-sessions row,
// and whether materializing that module throws.
const pageUrl = process.argv[2]
const httpBase = process.argv[3].replace(/\/$/, '')

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
await new Promise(resolve => setTimeout(resolve, 22000))

const evaluate = async expression => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    return `<<throw>> ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
  }
  return result.result?.value
}

console.log('module system keys:', await evaluate('JSON.stringify(Object.keys(window.__ModuleLoader__ ?? {}))'))
console.log('loader mode:', await evaluate('String(window.__ModuleLoader__?.mode)'))
console.log('all aria-labels:', await evaluate(`JSON.stringify([...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).slice(0, 40))`))
console.log('sidebar text:', await evaluate(`JSON.stringify((document.querySelector('[data-slot="sidebar"]')?.textContent ?? '').slice(0, 300))`))

const bundleUrl = new URL(process.argv[4] ?? 'plugins/??dsh-plugin-archived-sessions/client.js&rev=55b2ed23ed79', pageUrl).href
console.log('\n=== 直接拉取客户端产物并尝试物化 ===')
const materialize = `(async () => {
  const text = await (await fetch(${JSON.stringify(bundleUrl)}, { credentials: 'same-origin' })).text()
  const registered = []
  const previous = window.__ModuleLoader__
  let registration
  const sandbox = {
    load(reg) { registration = reg; registered.push(reg.id) },
    mode: 'probe',
  }
  window.__ModuleLoader__ = sandbox
  try {
    new Function(text)()
  } catch (error) {
    window.__ModuleLoader__ = previous
    return { stage: 'execute', error: String(error && error.stack || error) }
  }
  window.__ModuleLoader__ = previous
  if (registration === undefined) return { stage: 'register', error: 'no registration captured', registered }
  const missing = []
  let exports
  try {
    exports = registration.factory(name => {
      missing.push(name)
      return new Proxy(function () {}, { get: () => () => {}, apply: () => {} })
    })
  } catch (error) {
    return { stage: 'materialize', error: String(error && error.stack || error), registered }
  }
  return {
    stage: 'ok',
    registered,
    requires: missing,
    exportKeys: Object.keys(exports ?? {}),
    inject: exports?.inject,
    bytes: text.length,
  }
})()`
console.log(JSON.stringify(await evaluate(materialize), null, 2))

ws.close()
process.exit(0)
