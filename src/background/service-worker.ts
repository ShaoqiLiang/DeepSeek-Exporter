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

  // 请求注入消息提取脚本（content script 发起）
  if (msg.type === 'INJECT_MESSAGE_EXTRACTOR') {
    const tabId = sender.tab?.id
    if (tabId) {
      injectMessageExtractor(tabId).then((result) => sendResponse(result))
      return true // 异步响应
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

// ==================== 消息提取脚本注入 ====================

async function injectMessageExtractor(tabId: number): Promise<{messages: any[], debug?: any}> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const messages: Array<{role: 'user' | 'assistant', content: string}> = []
        const debug: any = {
          foundContainer: false,
          containerChildren: 0,
          assistantElements: 0,
          userElements: 0,
          directAssistant: 0,
          directUser: 0
        }

        // 查找所有消息容器（虚拟列表的可见项）
        const virtualItems = document.querySelector('.ds-virtual-list-visible-items') ||
                             document.querySelector('[class*="virtual-list"]')
        const chatContainer = virtualItems || document.querySelector('[class*="chat-list"]') ||
                             document.querySelector('[class*="message-list"]')

        if (!chatContainer) {
          // 回退：直接查找所有消息元素
          extractFromDirectDOM()
        } else {
          debug.foundContainer = true
          debug.containerChildren = chatContainer.children.length
          // 从容器中提取消息
          extractFromContainer(chatContainer)
        }

        // 如果上面没找到，尝试直接查找 DOM 元素
        if (messages.length === 0) {
          extractFromDirectDOM()
        }

        function extractFromContainer(container: Element) {
          Array.from(container.children).forEach(child => {
            // 跳过太小的元素
            if ((child as HTMLElement).offsetHeight < 20) return

            // 判断角色：检查是否包含 assistant 消息元素
            const assistantEl = child.querySelector('.ds-assistant-message-main-content')

            if (assistantEl) {
              debug.assistantElements++
              // 助手消息：从 React fiber 提取 Markdown AST
              const content = extractAssistantMarkdown(assistantEl)
              if (content) {
                messages.push({ role: 'assistant', content: content })
              }
            } else {
              debug.userElements++
              // 用户消息：提取文本内容
              const userTextEl = child.querySelector('[class*="user-message"]') ||
                                 child.querySelector('[class*="ds-markdown"]') ||
                                 child
              const text = (userTextEl.textContent || '').trim()
              if (text.length > 0) {
                messages.push({ role: 'user', content: text })
              }
            }
          })
        }

        function extractFromDirectDOM() {
          // 查找助手消息
          const assistantEls = document.querySelectorAll('.ds-assistant-message-main-content')
          debug.directAssistant = assistantEls.length
          assistantEls.forEach(el => {
            const content = extractAssistantMarkdown(el)
            if (content) {
              messages.push({ role: 'assistant', content: content })
            }
          })

          // 查找用户消息（通过排除助手消息的方式）
          const messageEls = document.querySelectorAll('.ds-message, [class*="message"]')
          debug.directUser = messageEls.length
          messageEls.forEach(el => {
            const hasAssistant = el.querySelector('.ds-assistant-message-main-content')
            if (hasAssistant) return
            const text = (el.textContent || '').trim()
            if (text.length > 0 && text.length < 5000) {
              messages.push({ role: 'user', content: text })
            }
          })
        }

        function extractAssistantMarkdown(el: Element): string | null {
          // 方法1：尝试从 React fiber 提取
          let fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
          if (!fiberKey) {
            const child = el.querySelector('[class*="ds-markdown"]') || el.firstElementChild
            if (child) {
              const childFiberKey = Object.keys(child).find(k => k.startsWith('__reactFiber$'))
              if (childFiberKey) {
                el = child
                fiberKey = childFiberKey
              }
            }
          }

          if (fiberKey) {
            let fiber = (el as any)[fiberKey]
            let depth = 0
            const astNodes: any[] = []

            while (fiber && depth < 30) {
              const props = fiber.memoizedProps
              if (props && typeof props === 'object') {
                if (props.node && typeof props.node === 'object' && props.node.type) {
                  const blockTypes = ['paragraph', 'heading', 'list', 'blockquote', 'code', 'thematicBreak']
                  if (blockTypes.includes(props.node.type)) {
                    astNodes.push(props.node)
                  }
                }
              }
              fiber = fiber.return
              depth++
            }

            if (astNodes.length > 0) {
              return astNodes.map(node => astToMarkdown(node)).join('\n\n')
            }
          }

          // 方法2：直接提取文本内容（回退方案）
          const textContent = el.textContent?.trim()
          if (textContent && textContent.length > 0) {
            return textContent
          }

          return null
        }

        // AST 转换函数
        function astToMarkdown(node: any): string {
          if (!node) return ''

          switch (node.type) {
            case 'root':
              return (node.children || []).map((child: any) => astToMarkdown(child)).join('\n\n')

            case 'paragraph':
              return (node.children || []).map((child: any) => astToMarkdown(child)).join('')

            case 'heading':
              const prefix = '#'.repeat(node.depth || 1)
              const content = (node.children || []).map((child: any) => astToMarkdown(child)).join('')
              return prefix + ' ' + content

            case 'text':
              return node.value || ''

            case 'strong':
              const strongContent = (node.children || []).map((child: any) => astToMarkdown(child)).join('')
              return '**' + strongContent + '**'

            case 'emphasis':
              const emContent = (node.children || []).map((child: any) => astToMarkdown(child)).join('')
              return '*' + emContent + '*'

            case 'inlineCode':
              return '`' + (node.value || '') + '`'

            case 'code':
              const lang = node.lang || ''
              return '```' + lang + '\n' + (node.value || '') + '\n```'

            case 'blockquote':
              const quoteContent = (node.children || []).map((child: any) => astToMarkdown(child)).join('\n')
              return quoteContent.split('\n').map((line: string) => '> ' + line).join('\n')

            case 'list':
              const items = (node.children || []).map((item: any, index: number) => {
                const itemContent = astToMarkdown(item)
                if (node.ordered) {
                  return (node.start || 1) + index + '. ' + itemContent
                } else {
                  return '- ' + itemContent
                }
              })
              return items.join('\n')

            case 'listItem':
              const itemChildren = (node.children || []).map((child: any) => astToMarkdown(child))
              return itemChildren.join('\n  ')

            case 'link':
              const linkText = (node.children || []).map((child: any) => astToMarkdown(child)).join('')
              const url = node.url || ''
              return '[' + linkText + '](' + url + ')'

            case 'image':
              const alt = node.alt || ''
              const src = node.url || ''
              return '![' + alt + '](' + src + ')'

            case 'thematicBreak':
              return '---'

            case 'break':
              return '\n'

            case 'delete':
              const delContent = (node.children || []).map((child: any) => astToMarkdown(child)).join('')
              return '~~' + delContent + '~~'

            default:
              if (node.children) {
                return node.children.map((child: any) => astToMarkdown(child)).join('')
              }
              return node.value || ''
          }
        }

        return { messages, debug }
      }
    })

    // 返回提取消息和调试信息
    if (results && results[0] && results[0].result) {
      const { messages, debug } = results[0].result
      console.log('[DS Exporter] 提取调试信息:', debug)
      return { messages, debug }
    }
    return { messages: [] }
  } catch (err) {
    console.log('[DS Exporter] 消息提取脚本注入失败:', err)
    return { messages: [] }
  }
}

console.log('[DS Exporter] Service worker 就绪')
