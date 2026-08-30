// ==================== DeepSeek 对话导出 - Background Service Worker ====================
// 负责：注入 fetch 拦截器（绕过 CSP）、管理数据

console.log('[DS Exporter] Service worker 启动')

import { exportMarkdown, exportJson, exportHtml, fileTimestamp, sanitizeFilename } from '../shared/exporters.js'

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

  // popup 请求对话列表
  if (msg.type === 'GET_CONVERSATION_LIST') {
    sendResponse({
      conversations: [...capturedData.values()].map(d => ({
        chat_id: d.chatId,
        title: d.title || '未命名对话',
        message_count: d.messages.length
      }))
    })
    return
  }

  // popup 请求导出：生成文件内容，由 popup 负责触发下载
  if (msg.type === 'REQUEST_EXPORT') {
    const { chatId, options } = msg.payload || {}
    const conv = chatId ? capturedData.get(chatId) : undefined
    if (!conv) {
      sendResponse({ error: '未找到该对话的数据，请先在 DeepSeek 页面打开一次对话' })
      return
    }
    try {
      const opts = options || { format: 'markdown', includeThinking: false, includeSearchResults: false }
      // API 原始消息的思考字段是 thinking_content，统一映射为导出模块使用的 thinking
      const messages = conv.messages.map((m: any) => ({ ...m, thinking: m.thinking ?? m.thinking_content }))
      const base = `${sanitizeFilename(conv.title || 'deepseek')}_${fileTimestamp()}`
      let content: string
      let filename: string
      let mimeType: string
      if (opts.format === 'json') {
        content = exportJson(messages)
        filename = `${base}.json`
        mimeType = 'application/json'
      } else if (opts.format === 'html') {
        content = exportHtml(messages)
        filename = `${base}.html`
        mimeType = 'text/html'
      } else {
        content = exportMarkdown(messages, !!opts.includeThinking)
        filename = `${base}.md`
        mimeType = 'text/markdown'
      }
      sendResponse({ success: true, filename, content, mimeType })
    } catch (e: any) {
      sendResponse({ error: `导出失败：${e?.message || e}` })
    }
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

        // 提取单条助手消息内部的搜索摘要与引用链接（每条回答各自对应）
        function extractSearchForElement(el: Element) {
          const summaryMatch = (el.textContent || '').match(/已阅读\s*\d+\s*个网页/)
          const refs: Array<{index: number, url: string}> = []
          const seenUrls = new Set<string>()
          el.querySelectorAll('a[href]').forEach(a => {
            const href = (a as HTMLAnchorElement).href
            if (href.startsWith('http') && !href.includes('deepseek.com') && !seenUrls.has(href)) {
              const m = (a.textContent || '').trim().match(/^[-]?(\d+)$/)
              if (m) {
                seenUrls.add(href)
                refs.push({ index: parseInt(m[1]), url: href })
              }
            }
          })
          refs.sort((a, b) => a.index - b.index)
          return { summary: summaryMatch ? summaryMatch[0] : null, references: refs }
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
                  const msg: any = { role: 'assistant', content: content }
                const thinking = extractThinking(child)
                if (thinking) msg.thinking = thinking
                const search = extractSearchForElement(assistantEl)
                if (search.summary) msg.searchSummary = search.summary
                if (search.references.length > 0) msg.searchReferences = search.references
                messages.push(msg)
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
          const items: Array<{ el: Element, role: 'user' | 'assistant' }> = []

          // 查找助手消息
          const assistantEls = document.querySelectorAll('.ds-assistant-message-main-content')
          debug.directAssistant = assistantEls.length
          assistantEls.forEach(el => items.push({ el, role: 'assistant' }))

          // 查找用户消息（通过排除助手消息的方式）
          const messageEls = document.querySelectorAll('.ds-message, [class*="message"]')
          debug.directUser = messageEls.length
          messageEls.forEach(el => {
            if (el.querySelector('.ds-assistant-message-main-content')) return
            const text = (el.textContent || '').trim()
            if (text.length > 0 && text.length < 5000) {
              items.push({ el, role: 'user' })
            }
          })

          // 关键：按 DOM 中的真实先后顺序排序，避免回答跑到提问前面
          items.sort((a, b) =>
            (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
          )

          for (const { el, role } of items) {
            const text = (el.textContent || '').trim()
            if (role === 'assistant') {
              const content = extractAssistantMarkdown(el)
              if (content) {
                const msg: any = { role: 'assistant', content }
                const thinking = extractThinking(el.closest('[class*="message"]') || el)
                if (thinking) msg.thinking = thinking
                const search = extractSearchForElement(el)
                if (search.summary) msg.searchSummary = search.summary
                if (search.references.length > 0) msg.searchReferences = search.references
                messages.push(msg)
              }
            } else if (text.length > 0 && text.length < 5000) {
              messages.push({ role: 'user', content: text })
            }
          }
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

        // 从消息元素提取思考过程：DeepSeek 渲染在 .ds-think-content 中
        function extractThinking(itemEl: Element): string | null {
          const think = itemEl.querySelector('.ds-think-content, [class*="ds-think-content"]')
          const text = think?.textContent?.trim()
          return text && text.length > 0 ? text : null
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

        // ==== 执行提取：优先虚拟列表容器（每个 child 是一条完整消息），失败再用直接 DOM 兜底 ====
        const container = document.querySelector('.ds-virtual-list-visible-items')
        if (container) {
          debug.foundContainer = true
          debug.containerChildren = container.children.length
          extractFromContainer(container)
        }
        if (messages.length === 0) {
          extractFromDirectDOM()
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
