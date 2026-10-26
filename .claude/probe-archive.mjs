// Open Settings in the dsh web UI via the aria-labelled rail button, then the
// archived-sessions section, and report whether the React tree survives.
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
      consoleMessages.push(`${type}: ${message.params.args.map(a => a.description ?? JSON.stringify(a.value)).join(' ').slice(0, 500)}`)
    }
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

const evaluate = async expression => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    return `<<throw>> ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
  }
  return result.result?.value
}

const report = async label => {
  const html = await evaluate('document.getElementById("root")?.innerHTML ?? ""')
  const text = await evaluate('document.body.innerText.replace(/\\s+/g, " ").slice(0, 300)')
  console.log(`\n--- ${label} ---`)
  console.log('#root 长度:', html.length, '| 文本:', text)
  return html
}

await new Promise(resolve => setTimeout(resolve, 20000))
await report('初始')

console.log('\n点击设置:', await evaluate(`(() => {
  const button = document.querySelector('[aria-label="设置"]')
  if (!button) return 'not-found'
  button.click()
  return 'clicked'
})()`))
await new Promise(resolve => setTimeout(resolve, 3000))
const settingsHtml = await report('设置页')

console.log('\n设置页导航项:', await evaluate(`JSON.stringify([...document.querySelectorAll('[role="tab"], nav button, nav [role="button"], [data-slot] button')].map(e => (e.textContent ?? '').trim()).filter(Boolean).slice(0, 60))`))
console.log('\n设置页全部按钮:', await evaluate(`JSON.stringify([...document.querySelectorAll('button')].map(e => (e.textContent ?? '').trim()).filter(Boolean).slice(0, 60))`))

console.log('\n点击归档会话:', await evaluate(`(() => {
  const candidates = [...document.querySelectorAll('button, [role="tab"], [role="button"], li, div')]
  const hit = candidates.find(el => (el.textContent ?? '').trim() === '归档会话')
  if (!hit) return 'not-found'
  hit.click()
  return 'clicked'
})()`))
await new Promise(resolve => setTimeout(resolve, 8000))
const sectionHtml = await report('归档会话区块')

console.log('\n区块关键词:', JSON.stringify({
  归档会话: sectionHtml.includes('归档会话'),
  暂无归档会话: sectionHtml.includes('暂无归档会话'),
  加载中: sectionHtml.includes('加载中'),
  加载失败: sectionHtml.includes('加载失败'),
  标题加载中: sectionHtml.includes('标题加载中'),
  补全标题: sectionHtml.includes('补全标题'),
  会话ID: /[0-9a-f]{8}-[0-9a-f]{4}/.test(sectionHtml),
}))

console.log('\n=== 未捕获异常 ===')
console.log(exceptions.join('\n---\n') || '(无)')
console.log('\n=== console error/warn ===')
console.log(consoleMessages.join('\n') || '(无)')

ws.close()
process.exit(0)
