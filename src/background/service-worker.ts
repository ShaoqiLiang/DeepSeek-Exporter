// ==================== DeepSeek 对话导出 - Background Service Worker ====================
// 负责：注入 fetch 拦截器（绕过 CSP）、管理数据

console.log('[DS Exporter] Service worker 启动')

// ==================== 注入 fetch 拦截器 ====================

// chrome.scripting.executeScript 不受 CSP 限制
async function injectInterceptor(tabId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN', // 页面主世界，可以访问页面的 fetch
      func: () => {
        // 避免重复注入
        if ((window as any).__dsFetchIntercepted) return
        ;(window as any).__dsFetchIntercepted = true

        const _fetch = window.fetch
        window.fetch = async function (...args: any[]) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''
          const response = await _fetch.apply(this, args as any)

          try {
            const ct = response.headers.get('content-type') || ''
            if (ct.includes('json')) {
              const cloned = response.clone()
              const data = await cloned.json()
              window.postMessage({
                type: '__DS_API__',
                url: url,
                data: data
              }, '*')
            }
          } catch (e) {}

          return response
        }

        console.log('[DS Exporter] fetch 拦截器已就位 (MAIN world)')
      }
    })
    console.log('[DS Exporter] 拦截器注入成功, tabId:', tabId)
  } catch (err) {
    console.log('[DS Exporter] 拦截器注入失败:', err)
  }
}

// ==================== 标签页监听 ====================

// 页面加载完成时注入拦截器
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('chat.deepseek.com')) {
    injectInterceptor(tabId)
  }
})

// 标签页激活时也注入（处理已打开的标签页）
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId)
    if (tab.url?.includes('chat.deepseek.com')) {
      injectInterceptor(activeInfo.tabId)
    }
  } catch (e) {}
})

// ==================== 消息通信 ====================

// 存储捕获的对话数据（按 chatId）
const capturedData = new Map<string, {
  chatId: string
  messages: any[]
  title?: string
  capturedAt: number
}>()

// 监听 content script 转发的 API 数据
chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  // content script 转发的拦截数据
  if (msg.type === 'DS_API_CAPTURED') {
    const { chatId, messages, title, apiUrl } = msg.payload
    const existing = capturedData.get(chatId)
    capturedData.set(chatId, {
      chatId,
      messages: mergeMessages(existing?.messages || [], messages),
      title: existing?.title || title,
      capturedAt: Date.now()
    })
    console.log(`[DS Exporter] 已存储对话 ${chatId}, ${messages.length} 条消息`)
    sendResponse({ ok: true })
    return
  }

  // popup/content 请求对话数据
  if (msg.type === 'GET_CONVERSATIONS') {
    sendResponse({
      conversations: [...capturedData.values()],
      currentChatId: msg.chatId
    })
    return
  }

  // 请求注入拦截器（content script 发起）
  if (msg.type === 'INJECT_INTERCEPTOR') {
    const tabId = sender.tab?.id
    if (tabId) {
      injectInterceptor(tabId).then(() => sendResponse({ ok: true }))
      return true
    }
  }
})

function mergeMessages(existing: any[], incoming: any[]): any[] {
  if (incoming.length >= existing.length) return incoming
  const existingKeys = new Set(existing.map((m: any) => (m.content || '').slice(0, 100)))
  const merged = [...existing]
  for (const msg of incoming) {
    if (!existingKeys.has((msg.content || '').slice(0, 100))) {
      merged.push(msg)
    }
  }
  return merged
}

console.log('[DS Exporter] Service worker 就绪')
