// Capture the network traffic the archived-sessions section produces, so the
// host half's answer (or failure) is visible instead of guessed.
const pageUrl = process.argv[2]
const httpBase = process.argv[3].replace(/\/$/, '')

const list = await (await fetch(`${httpBase}/json/version`)).json()
const ws = new WebSocket(list.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const exceptions = []
const consoleMessages = []
const requests = new Map()
const responses = []
const bodies = []
let sessionId

ws.addEventListener('message', async event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const resolve = pending.get(message.id)
    pending.delete(message.id)
    resolve(message)
    return
  }
  if (message.sessionId !== sessionId) return
  const { method, params } = message
  if (method === 'Runtime.exceptionThrown') {
    exceptions.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text)
  }
  if (method === 'Runtime.consoleAPICalled') {
    const type = params.type
    if (type === 'error' || type === 'warning') {
      consoleMessages.push(`${type}: ${params.args.map(a => a.description ?? JSON.stringify(a.value)).join(' ').slice(0, 600)}`)
    }
  }
  if (method === 'Network.requestWillBeSent') requests.set(params.requestId, { url: params.request.url, method: params.request.method, postData: params.request.postData })
  if (method === 'Network.responseReceived') {
    const entry = requests.get(params.requestId)
    if (entry !== undefined) responses.push({ ...entry, status: params.response.status, mimeType: params.response.mimeType })
  }
  if (method === 'Network.loadingFailed') {
    const entry = requests.get(params.requestId)
    if (entry !== undefined) responses.push({ ...entry, status: 'FAILED', error: params.errorText })
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
await send('Log.enable')
await send('Page.enable')
await send('Network.enable')

const evaluate = async expression => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) return `<<throw>> ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
  return result.result?.value
}

await new Promise(resolve => setTimeout(resolve, 20000))
responses.length = 0

await evaluate(`document.querySelector('[aria-label="设置"]')?.click()`)
await new Promise(resolve => setTimeout(resolve, 2500))
await evaluate(`(() => { const hit = [...document.querySelectorAll('button')].find(el => (el.textContent ?? '').trim() === '归档会话'); hit?.click(); return hit ? 'ok' : 'not-found' })()`)
await new Promise(resolve => setTimeout(resolve, 15000))

console.log('=== 归档会话区块文本 ===')
console.log(await evaluate(`(() => { const el = [...document.querySelectorAll('*')].find(e => (e.textContent ?? '').includes('管理已归档的会话')); return el ? el.closest('[data-slot]')?.parentElement?.textContent?.slice(0, 400) ?? el.textContent.slice(0, 400) : 'not-found' })()`))

console.log('\n=== 非静态请求 ===')
for (const response of responses) {
  if (response.url.includes('/plugins/') || response.url.includes('/assets/') || response.url.includes('.woff') || response.url.includes('.css')) continue
  console.log(`${response.status} ${response.method} ${response.url.slice(0, 160)}`, response.error ?? '')
}

console.log('\n=== 未捕获异常 ===')
console.log(exceptions.join('\n---\n') || '(无)')
console.log('\n=== console error/warn ===')
console.log(consoleMessages.join('\n') || '(无)')

ws.close()
process.exit(0)
