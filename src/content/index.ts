// ==================== DeepSeek 对话导出 - Fiber Reader 方案 ====================
// 策略：自动滚动对话 → 触发虚拟列表渲染 → 从 React fiber 读取完整内容

console.log('[DS Exporter] Fiber Reader 方案启动')

interface ParsedMessage {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
}

// ==================== 从 React fiber 读取内容 ====================

/**
 * 从一个 DOM 元素的 React fiber 中提取 content 字段。
 * DeepSeek 的 AI 消息组件在 fiber.memoizedProps.content 中存有完整 Markdown。
 */
function readContentFromFiber(el: Element): string | null {
  const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
  if (!fiberKey) return null

  let fiber = (el as any)[fiberKey]
  let depth = 0

  while (fiber && depth < 15) {
    const props = fiber.memoizedProps
    if (props && typeof props === 'object') {
      // AI 消息组件的 props.content 是完整 Markdown
      if (typeof props.content === 'string' && props.content.length > 20) {
        return props.content
      }
      // 有些组件把内容放在 children 或 item 中
      if (typeof props.children === 'string' && props.children.length > 20) {
        return props.children
      }
      if (props.item?.content && typeof props.item.content === 'string') {
        return props.item.content
      }
    }

    // 也检查 memoizedState
    const state = fiber.memoizedState
    if (state && typeof state === 'object') {
      let s = state
      let sIdx = 0
      while (s && sIdx < 5) {
        const val = s.memoizedState
        if (Array.isArray(val) && val.length > 0 && val[0]?.content) {
          // 找到消息数组，返回完整数组的 JSON
          return JSON.stringify(val)
        }
        s = s.next
        sIdx++
      }
    }

    fiber = fiber.return
    depth++
  }
  return null
}

// ==================== 读取当前可见的消息 ====================

function readVisibleMessages(): ParsedMessage[] {
  const messages: ParsedMessage[] = []
  const seen = new Set<string>()

  // AI 消息：有明确的 class 标识
  document.querySelectorAll('.ds-assistant-message-main-content').forEach(el => {
    const content = readContentFromFiber(el)
    if (content && !seen.has(content.slice(0, 100))) {
      seen.add(content.slice(0, 100))
      messages.push({ role: 'assistant', content })
    }
  })

  // 用户消息：通过兄弟关系或父容器推断
  // 找所有 ds-message 容器，检查其内部是否有 assistant 标识
  document.querySelectorAll('.ds-message').forEach(el => {
    const hasAssistant = el.querySelector('.ds-assistant-message-main-content')
    if (hasAssistant) return // 已经处理过

    // 没有 assistant 标识 → 可能是用户消息
    const content = readContentFromFiber(el)
    if (content && !seen.has(content.slice(0, 100))) {
      seen.add(content.slice(0, 100))
      messages.push({ role: 'user', content })
    }
  })

  // 兜底：找虚拟列表中的直接子元素（交替出现的用户/AI 消息）
  const virtualItems = document.querySelector('.ds-virtual-list-visible-items')
  if (virtualItems && messages.length === 0) {
    Array.from(virtualItems.children).forEach(child => {
      const text = child.textContent?.trim() || ''
      if (text.length < 10) return

      // 判断角色
      const cls = (typeof child.className === 'string' ? child.className : '').toLowerCase()
      const hasAssistant = child.querySelector('.ds-assistant-message-main-content')
      const role: 'user' | 'assistant' = hasAssistant ? 'assistant' :
        (cls.includes('user') || cls.includes('human') ? 'user' : guessRole(text))

      // 尝试从 fiber 读取完整内容，回退到 textContent
      const fiberContent = readContentFromFiber(child)
      const content = fiberContent || text

      if (!seen.has(content.slice(0, 100))) {
        seen.add(content.slice(0, 100))
        messages.push({ role, content })
      }
    })
  }

  return messages
}

function guessRole(text: string): 'user' | 'assistant' {
  // 用户消息通常较短，以问号结尾
  if (text.length < 300 && /[？\?]$/.test(text)) return 'user'
  // 包含代码或较长的通常是 AI
  if (text.includes('```') || text.length > 500) return 'assistant'
  return 'user'
}

// ==================== 自动滚动采集 ====================

/**
 * 自动滚动对话区域，触发虚拟列表渲染所有消息，
 * 同时采集每条消息的内容。
 */
async function scrollAndCollect(): Promise<ParsedMessage[]> {
  const allMessages = new Map<string, ParsedMessage>() // 用内容前100字符去重
  const scrollContainer = document.querySelector('.ds-virtual-list') ||
                          document.querySelector('.ds-scroll-area') ||
                          findScrollContainer()

  if (!scrollContainer) {
    console.log('[DS Exporter] 未找到滚动容器')
    return readVisibleMessages()
  }

  console.log('[DS Exporter] 找到滚动容器，开始滚动采集...')

  // 记录初始滚动位置
  const initialScrollTop = scrollContainer.scrollTop

  // 先滚动到顶部
  scrollContainer.scrollTop = 0
  await sleep(300)

  let lastHeight = -1
  let noChangeCount = 0
  const MAX_NO_CHANGE = 3

  while (noChangeCount < MAX_NO_CHANGE) {
    // 读取当前可见的消息
    const visible = readVisibleMessages()
    for (const msg of visible) {
      const key = msg.content.slice(0, 100)
      if (!allMessages.has(key)) {
        allMessages.set(key, msg)
      }
    }

    // 向下滚动一屏
    const prevScrollTop = scrollContainer.scrollTop
    scrollContainer.scrollTop += scrollContainer.clientHeight * 0.8
    await sleep(500)

    // 检查是否到底
    if (scrollContainer.scrollTop === prevScrollTop ||
        scrollContainer.scrollTop >= scrollContainer.scrollHeight - scrollContainer.clientHeight - 10) {
      noChangeCount++
    } else {
      noChangeCount = 0
    }
  }

  // 最后再读一次底部的消息
  const final = readVisibleMessages()
  for (const msg of final) {
    const key = msg.content.slice(0, 100)
    if (!allMessages.has(key)) {
      allMessages.set(key, msg)
    }
  }

  // 恢复滚动位置
  scrollContainer.scrollTop = initialScrollTop

  const result = [...allMessages.values()]
  console.log(`[DS Exporter] 滚动采集完成，共 ${result.length} 条消息`)
  return result
}

function findScrollContainer(): Element | null {
  // 找可滚动的容器
  const candidates = document.querySelectorAll('div')
  for (const el of candidates) {
    const style = getComputedStyle(el)
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 100 &&
        el.clientHeight > 200) {
      return el
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ==================== 导出 ====================

let cachedMessages: ParsedMessage[] | null = null
let isCollecting = false

function exportMarkdown(messages: ParsedMessage[], includeThinking: boolean): string {
  const lines: string[] = []
  lines.push(`# DeepSeek 对话导出\n`)
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`)
  lines.push(`> 消息数：${messages.length} 条\n`)
  lines.push('---\n')

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const isUser = msg.role === 'user'
    lines.push(`## ${isUser ? '👤 用户' : '🤖 DeepSeek'}\n`)

    if (includeThinking && msg.thinking) {
      lines.push(`<details>\n<summary>🧠 思考过程</summary>\n`)
      lines.push(msg.thinking)
      lines.push(`\n</details>\n`)
    }

    lines.push(msg.content)
    lines.push('')
    if (i < messages.length - 1) lines.push('---\n')
  }
  return lines.join('\n')
}

function exportJson(messages: ParsedMessage[]): string {
  return JSON.stringify({
    exported_at: new Date().toISOString(),
    url: location.href,
    message_count: messages.length,
    messages
  }, null, 2)
}

function exportHtml(messages: ParsedMessage[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let body = ''
  for (const msg of messages) {
    const isUser = msg.role === 'user'
    body += `<div class="msg ${msg.role}">\n`
    body += `  <div class="msg-header">${isUser ? '👤 用户' : '🤖 DeepSeek'}</div>\n`
    if (msg.thinking) {
      body += `  <details class="thinking"><summary>🧠 思考过程</summary><pre>${esc(msg.thinking)}</pre></details>\n`
    }
    body += `  <div class="msg-body">${esc(msg.content)}</div>\n</div>\n`
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>DeepSeek 对话导出</title>
<style>
  body{max-width:800px;margin:0 auto;padding:20px;font-family:-apple-system,sans-serif;line-height:1.6;color:#333}
  h1{text-align:center}.meta{text-align:center;color:#666;margin-bottom:30px}
  .msg{margin:20px 0;padding:16px;border-radius:12px}
  .msg.user{background:#e3f2fd;border-left:4px solid #2196f3}
  .msg.assistant{background:#f5f5f5;border-left:4px solid #4caf50}
  .msg-header{font-weight:bold;margin-bottom:8px}
  .msg-body{white-space:pre-wrap;word-break:break-word}
  .thinking{margin:10px 0;padding:10px;background:#fff3e0;border-radius:8px}
  .thinking summary{cursor:pointer;font-weight:bold}
  pre{background:#282c34;color:#abb2bf;padding:12px;border-radius:8px;overflow-x:auto}
  table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}
</style></head><body>
<h1>📤 DeepSeek 对话导出</h1>
<div class="meta">导出时间：${new Date().toLocaleString('zh-CN')} · ${messages.length} 条消息</div>
${body}</body></html>`
}

function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ==================== UI ====================

function injectUI() {
  if (document.querySelector('#ds-export-btn')) return

  const wrapper = document.createElement('div')
  wrapper.id = 'ds-export-btn'
  wrapper.className = 'ds-export-floating'
  wrapper.innerHTML = `
    <button class="ds-export-trigger" title="导出对话">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span>导出</span>
    </button>
    <div class="ds-export-menu" style="display:none">
      <div class="ds-export-options">
        <label class="ds-export-option">
          <input type="checkbox" id="ds-opt-thinking" checked> 包含思考过程
        </label>
      </div>
      <div class="ds-export-formats">
        <button class="ds-export-format" data-format="markdown">📝 Markdown</button>
        <button class="ds-export-format" data-format="json">📋 JSON</button>
        <button class="ds-export-format" data-format="html">🌐 HTML</button>
      </div>
      <div class="ds-export-status" id="ds-status"></div>
    </div>
  `
  document.body.appendChild(wrapper)

  const trigger = wrapper.querySelector('.ds-export-trigger')!
  const menu = wrapper.querySelector('.ds-export-menu') as HTMLElement

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
  })

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target as Node)) menu.style.display = 'none'
  })

  wrapper.querySelectorAll('.ds-export-format').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const format = (e.currentTarget as HTMLElement).dataset.format as string
      const includeThinking = (document.querySelector('#ds-opt-thinking') as HTMLInputElement)?.checked ?? true
      await doExport(format, includeThinking)
    })
  })
}

async function doExport(format: string, includeThinking: boolean) {
  const statusEl = document.getElementById('ds-status')

  if (isCollecting) {
    showNotification('正在采集中，请稍候...', 'error')
    return
  }

  // 如果没有缓存数据，先采集
  if (!cachedMessages || cachedMessages.length === 0) {
    isCollecting = true
    if (statusEl) {
      statusEl.textContent = '⏳ 正在滚动采集对话数据...'
      statusEl.className = 'ds-export-status waiting'
    }

    try {
      cachedMessages = await scrollAndCollect()
    } catch (e) {
      console.error('[DS Exporter] 采集失败:', e)
      showNotification('采集失败，请重试', 'error')
      isCollecting = false
      return
    }
    isCollecting = false
  }

  if (!cachedMessages || cachedMessages.length === 0) {
    showNotification('未找到对话内容', 'error')
    return
  }

  if (statusEl) {
    statusEl.textContent = `✅ ${cachedMessages.length} 条消息`
    statusEl.className = 'ds-export-status captured'
  }

  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const title = document.title.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30) || 'deepseek'

  switch (format) {
    case 'markdown':
      triggerDownload(exportMarkdown(cachedMessages, includeThinking), `${title}_${ts}.md`, 'text/markdown')
      break
    case 'json':
      triggerDownload(exportJson(cachedMessages), `${title}_${ts}.json`, 'application/json')
      break
    case 'html':
      triggerDownload(exportHtml(cachedMessages), `${title}_${ts}.html`, 'text/html')
      break
  }

  showNotification(`已导出 ${cachedMessages.length} 条消息 (${format})`, 'success')
  document.querySelector('.ds-export-menu')?.setAttribute('style', 'display:none')
}

function showNotification(message: string, type: 'success' | 'error') {
  document.querySelector('.ds-export-notification')?.remove()
  const el = document.createElement('div')
  el.className = `ds-export-notification ds-export-notification-${type}`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

// ==================== SPA 路由监听 ====================

let lastUrl = location.href
let debounceTimer: number | null = null

function onRouteChange() {
  if (location.href === lastUrl) return
  lastUrl = location.href
  cachedMessages = null // 切换对话时清除缓存
  console.log('[DS Exporter] 路由变化，缓存已清除')
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(injectUI, 1500)
}

window.addEventListener('popstate', onRouteChange)
const origPush = history.pushState
history.pushState = function (...args) { origPush.apply(this, args); onRouteChange() }
const origReplace = history.replaceState
history.replaceState = function (...args) { origReplace.apply(this, args); onRouteChange() }

// MutationObserver
function setupObserver() {
  if (document.body) {
    new MutationObserver(() => {
      if (debounceTimer) return
      debounceTimer = window.setTimeout(() => { debounceTimer = null; onRouteChange() }, 500)
    }).observe(document.body, { childList: true, subtree: true })
  }
}

// ==================== 初始化 ====================

console.log('[DS Exporter] 等待 DOM 就绪...')

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setupObserver()
    injectUI()
  })
} else {
  setupObserver()
  injectUI()
}
