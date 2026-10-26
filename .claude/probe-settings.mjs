// Drive the dsh web UI through CDP: open Settings, then the archived-sessions
// section, reporting exceptions and what #root renders at each step.
const pageUrl = process.argv[2]
const httpBase = process.argv[3].replace(/\/$/, '')

const list = await (await fetch(`${httpBase}/json/version`)).json()
const ws = new WebSocket(list.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const exceptions = []
const consoleMessages = []
let sessionId

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const resolve = pending.get(message.id)
    pending.delete(message.id)
    resolve(message)
    return
  }
  if (message.sessionId !== sessionId) return
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    exceptions.push(details.exception?.description ?? details.text)
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const type = message.params.type
    if (type === 'error' || type === 'warning') {
      consoleMessages.push(`${type}: ${message.params.args.map(a => a.description ?? JSON.stringify(a.value)).join(' ')}`)
    }
  }
})

await new Promise(resolve => ws.addEventListener('open', resolve))

const send = (method, params = {}, useSession = true) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params, ...(useSession ? { sessionId } : {}) }))
})

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' }, false)
const attached = await send('Target.attachToTarget', { targetId, flatten: true }, false)
sessionId = attached.result.sessionId

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

const evaluate = async expression => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}

const clickText = async text => evaluate(`(() => {
  const all = [...document.querySelectorAll('button, [role="tab"], [role="button"], a, li, div[tabindex]')]
  const hit = all.find(el => (el.textContent ?? '').trim() === ${JSON.stringify(text)})
    ?? all.find(el => (el.textContent ?? '').includes(${JSON.stringify(text)}))
  if (hit === undefined) return 'not-found'
  hit.click()
  return 'clicked'
})()`)

const snapshot = async label => {
  const html = await evaluate('document.getElementById("root")?.innerHTML ?? ""')
  const text = await evaluate('document.body.innerText.slice(0, 400)')
  console.log(`\n=== ${label} ===`)
  console.log('#root 长度:', html.length)
  console.log('可见文本:', JSON.stringify(text.slice(0, 260)))
  return html
}

await send('Page.navigate', { url: pageUrl })
await new Promise(resolve => setTimeout(resolve, 22000))
await snapshot('初始加载')

console.log('\n按钮文本样本:')
console.log(await evaluate(`JSON.stringify([...document.querySelectorAll('button')].map(b => (b.textContent ?? '').trim()).filter(Boolean).slice(0, 45))`))

console.log('\n打开设置:', await clickText('设置'))
await new Promise(resolve => setTimeout(resolve, 2500))
await snapshot('设置页')

console.log('\n点开 归档会话:', await clickText('归档会话'))
await new Promise(resolve => setTimeout(resolve, 6000))
const finalHtml = await snapshot('归档会话区块')

console.log('\n=== 归档区块关键词命中 ===')
for (const keyword of ['归档会话', '暂无归档会话', '加载中', '加载失败', '标题加载中']) {
  console.log(` ${keyword}:`, finalHtml.includes(keyword))
}

console.log('\n=== 未捕获异常 ===')
console.log(exceptions.join('\n---\n') || '(无)')

console.log('\n=== console error/warn ===')
console.log(consoleMessages.join('\n') || '(无)')

ws.close()
process.exit(0)
