// ==================== DeepSeek 对话导出 - Fiber Reader 方案 ====================
// 策略：自动滚动对话 → 触发虚拟列表渲染 → 从 React fiber 读取完整内容

console.log('[DS Exporter] Fiber Reader 方案启动')

import type { ParsedMessage, SearchReference } from '../shared/types.js'
import { exportMarkdown, exportJson, exportHtml } from '../shared/exporters.js'

// ==================== 从 React fiber 读取内容 ====================

/**
 * 从一个 DOM 元素的 React fiber 中提取 content 字段。
 * DeepSeek 的 AI 消息组件在 fiber.memoizedProps.content 中存有完整 Markdown。
 */
// ==================== Markdown AST 转换 ====================

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  depth?: number
  ordered?: boolean
  start?: number | null
  spread?: boolean
  checked?: boolean | null
  lang?: string
  position?: any
}

function astToMarkdown(node: MarkdownNode): string {
  if (!node) return ''

  switch (node.type) {
    case 'root':
      return (node.children || []).map(child => astToMarkdown(child)).join('\n\n')

    case 'paragraph':
      return (node.children || []).map(child => astToMarkdown(child)).join('')

    case 'heading':
      const prefix = '#'.repeat(node.depth || 1)
      const content = (node.children || []).map(child => astToMarkdown(child)).join('')
      return `${prefix} ${content}`

    case 'text':
      return node.value || ''

    case 'strong':
      const strongContent = (node.children || []).map(child => astToMarkdown(child)).join('')
      return `**${strongContent}**`

    case 'emphasis':
      const emContent = (node.children || []).map(child => astToMarkdown(child)).join('')
      return `*${emContent}*`

    case 'inlineCode':
      return `\`${node.value || ''}\``

    case 'code':
      const lang = node.lang || ''
      return `\`\`\`${lang}\n${node.value || ''}\n\`\`\``

    case 'blockquote':
      const quoteContent = (node.children || []).map(child => astToMarkdown(child)).join('\n')
      return quoteContent.split('\n').map(line => `> ${line}`).join('\n')

    case 'list':
      const items = (node.children || []).map((item, index) => {
        const itemContent = astToMarkdown(item)
        if (node.ordered) {
          return `${(node.start || 1) + index}. ${itemContent}`
        } else {
          return `- ${itemContent}`
        }
      })
      return items.join('\n')

    case 'listItem':
      const itemChildren = (node.children || []).map(child => astToMarkdown(child))
      return itemChildren.join('\n  ')

    case 'link':
      const linkText = (node.children || []).map(child => astToMarkdown(child)).join('')
      const url = (node as any).url || ''
      return `[${linkText}](${url})`

    case 'image':
      const alt = (node as any).alt || ''
      const src = (node as any).url || ''
      return `![${alt}](${src})`

    case 'thematicBreak':
      return '---'

    case 'break':
      return '\n'

    case 'delete':
      const delContent = (node.children || []).map(child => astToMarkdown(child)).join('')
      return `~~${delContent}~~`

    default:
      // 对于未知类型，尝试处理子节点
      if (node.children) {
        return node.children.map(child => astToMarkdown(child)).join('')
      }
      return node.value || ''
  }
}

// 通过 service worker 注入脚本到页面主世界，提取消息（用户+助手）
async function injectScriptToGetMessages(): Promise<Array<{role: 'user' | 'assistant', content: string}>> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'INJECT_MESSAGE_EXTRACTOR'
    })
    if (response?.debug) {
      console.log('[DS Exporter] 消息提取调试:')
      console.log('  - 找到容器:', response.debug.foundContainer)
      console.log('  - 容器子元素数:', response.debug.containerChildren)
      console.log('  - 容器中的助手元素:', response.debug.assistantElements)
      console.log('  - 容器中的用户元素:', response.debug.userElements)
      console.log('  - 直接查找助手元素:', response.debug.directAssistant)
      console.log('  - 直接查找消息元素:', response.debug.directUser)
      console.log('  - 提取消息数:', response.messages?.length || 0)
    }
    return response?.messages || []
  } catch (err) {
    console.log('[DS Exporter] 消息提取失败:', err)
    return []
  }
}

// ==================== 捕获搜索结果 ====================

function captureSearchResults(): { summary: string | null, references: SearchReference[], isExpanded: boolean } {
  let summary: string | null = null
  const references: SearchReference[] = []
  const seenUrls = new Set<string>()
  let isExpanded = false

  // 1. 提取搜索摘要 - 尝试多个选择器
  const summarySelectors = ['._769d943', '[class*="search"]', '[class*="Search"]']
  for (const sel of summarySelectors) {
    const el = document.querySelector(sel)
    if (el && el.textContent?.includes('个网页')) {
      summary = el.textContent.trim()
      break
    }
  }

  // 如果没找到，尝试从文本中提取
  if (!summary) {
    const allText = document.body.textContent || ''
    const match = allText.match(/已阅读\s*\d+\s*个网页/)
    if (match) {
      summary = match[0]
    }
  }

  // 2. 检查搜索结果是否展开
  // 查找搜索结果容器，检查是否有展开状态
  const searchContainer = document.querySelector('._60aa7fb, ._74c0879')
  if (searchContainer) {
    // 检查是否有展开的详细内容区域
    const detailArea = searchContainer.querySelector('[class*="detail"], [class*="content"], [class*="body"]')
    if (detailArea) {
      // 检查是否有可见的链接列表
      const links = detailArea.querySelectorAll('a[href]')
      isExpanded = links.length > 0
    }

    // 如果没有找到详细内容区域，检查搜索容器本身是否有展开状态
    if (!isExpanded) {
      // 检查是否有展开按钮或状态
      const expandButton = searchContainer.querySelector('[class*="expand"], [class*="toggle"], [class*="show"]')
      if (expandButton) {
        // 检查按钮状态
        const isExpandedState = expandButton.getAttribute('aria-expanded') === 'true' ||
                               expandButton.classList.contains('expanded') ||
                               expandButton.classList.contains('active')
        isExpanded = isExpandedState
      }
    }

    // 如果还是没有确定，检查是否有可见的链接列表
    if (!isExpanded) {
      const allLinks = searchContainer.querySelectorAll('a[href^="http"]:not([href*="deepseek.com"])')
      isExpanded = allLinks.length > 0
    }
  }

  // 3. 提取引用链接 - 改进匹配逻辑
  document.querySelectorAll('a[href]').forEach(a => {
    const href = (a as HTMLAnchorElement).href
    if (href && href.startsWith('http') && !href.includes('deepseek.com') && !seenUrls.has(href)) {
      seenUrls.add(href)
      const text = a.textContent?.trim() || ''
      // 提取引用编号（如 "-1"、"-2"、"1"、"2" 等）
      const match = text.match(/^[-]?(\d+)$/)
      if (match) {
        references.push({
          index: parseInt(match[1]),
          url: href
        })
      }
    }
  })

  // 按编号排序
  references.sort((a, b) => a.index - b.index)

  console.log('[DS Exporter] 搜索结果:', { summary, referencesCount: references.length, isExpanded })
  return { summary, references, isExpanded }
}

// ==================== 读取当前可见的消息 ====================

// 全局变量存储从页面提取消息的结果
// st = 采集时滚动容器的 scrollTop（越小越靠对话开头），i = 本批次内的序号
// 虚拟列表滚动时不断换页，每屏抓一次，最后按 (st, i) 还原全局顺序
let pageMessages: Array<{ message: ParsedMessage, st: number, i: number }> = []

// 从页面获取消息（用户+助手）
async function fetchMessagesFromPage(st: number): Promise<void> {
  try {
    console.log('[DS Exporter] 尝试从页面获取消息...')
    const messages = await injectScriptToGetMessages()

    if (messages.length > 0) {
      console.log('[DS Exporter] 成功获取', messages.length, '条消息')
      // 合并新消息（去重）
      const existingKeys = new Set(pageMessages.map(p => p.message.content.slice(0, 100)))
      messages.forEach((msg, i) => {
        const key = msg.content.slice(0, 100)
        if (!existingKeys.has(key)) {
          pageMessages.push({ message: msg, st, i })
          existingKeys.add(key)
        }
      })
      // 还原全局顺序：先按滚动位置，再按批内序号
      pageMessages.sort((a, b) => (a.st - b.st) || (a.i - b.i))
    } else {
      console.log('[DS Exporter] 未能获取消息，将使用 DOM 提取')
    }
  } catch (e) {
    console.log('[DS Exporter] 从页面获取消息失败:', e)
  }
}

function readVisibleMessages(includeSearch: boolean = false): ParsedMessage[] {
  const messages: ParsedMessage[] = []
  const seen = new Set<string>()

  // 捕获搜索结果（仅当 includeSearch 为 true 时）
  let searchSummary: string | null = null
  let searchReferences: SearchReference[] = []
  if (includeSearch) {
    const result = captureSearchResults()
    searchSummary = result.summary
    searchReferences = result.references
  }

  // 优先使用从注入脚本获取的结构化消息（已按滚动位置排好序）
  if (pageMessages.length > 0) {
    for (const { message: msg } of pageMessages) {
      const key = msg.content.slice(0, 100)
      if (!seen.has(key)) {
        seen.add(key)
        const item: ParsedMessage = { role: msg.role, content: msg.content }
        if (includeSearch) {
          if (msg.searchSummary) item.searchSummary = msg.searchSummary
          if (msg.searchReferences) item.searchReferences = msg.searchReferences
        }
        messages.push(item)
      }
    }
    console.log('[DS Exporter] 使用页面消息:', messages.length, '条')
  }

  // 如果页面消息为空，回退到 DOM 提取
  if (messages.length === 0) {
    // 汇总助手/用户消息元素，按 DOM 真实顺序排序后再提取，保证提问在回答之前
    const items: Array<{ el: Element, role: 'user' | 'assistant' }> = []

    document.querySelectorAll('.ds-assistant-message-main-content').forEach(el => {
      items.push({ el, role: 'assistant' })
    })
    document.querySelectorAll('.ds-message, [class*="message"]').forEach(el => {
      if (el.querySelector('.ds-assistant-message-main-content')) return
      const text = el.textContent?.trim() || ''
      if (text.length > 0 && text.length < 5000) {
        items.push({ el, role: 'user' })
      }
    })
    items.sort((a, b) =>
      (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
    )

    for (const { el, role } of items) {
      const key = (el.textContent?.trim() || '').slice(0, 100)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (role === 'assistant') {
        const item: ParsedMessage = { role: 'assistant', content: el.textContent!.trim() }
        if (includeSearch) {
          const summaryMatch = el.textContent?.match(/已阅读\s*\d+\s*个网页/)
          if (summaryMatch) item.searchSummary = summaryMatch[0]
          const refs: SearchReference[] = []
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
          refs.sort((x, y) => x.index - y.index)
          if (refs.length > 0) item.searchReferences = refs
        }
        messages.push(item)
      } else {
        messages.push({ role: 'user', content: el.textContent!.trim() })
      }
    }

    // 最后回退：从虚拟列表中获取
    if (messages.length === 0) {
      const virtualItems = document.querySelector('.ds-virtual-list-visible-items')
      if (virtualItems) {
        Array.from(virtualItems.children).forEach(child => {
          const text = child.textContent?.trim() || ''
          if (text.length < 10) return

          const hasAssistant = child.querySelector('.ds-assistant-message-main-content')
          const role: 'user' | 'assistant' = hasAssistant ? 'assistant' : 'user'

          if (!seen.has(text.slice(0, 100))) {
            seen.add(text.slice(0, 100))
            messages.push({ role, content: text })
          }
        })
      }
    }
  }

  // 兜底：如果逐条提取没拿到任何引用，才整页抓一次挂到最后一条回答
  if (includeSearch && !messages.some(m => m.searchReferences && m.searchReferences.length > 0)) {
    const lastAssistantMsg = messages.filter(m => m.role === 'assistant').pop()
    if (lastAssistantMsg) {
      if (searchSummary) lastAssistantMsg.searchSummary = searchSummary
      if (searchReferences.length > 0) lastAssistantMsg.searchReferences = searchReferences
      console.log('[DS Exporter] 搜索结果已附加到最后一个 assistant 消息:', { searchSummary, searchReferencesCount: searchReferences.length })
    } else {
      console.log('[DS Exporter] 未找到 assistant 消息，搜索结果未附加')
    }
  }

  return messages
}

// ==================== 自动滚动采集 ====================

// 用于取消导出的 AbortController
let abortController: AbortController | null = null

/**
 * 取消正在进行的导出
 */
function cancelExport() {
  if (abortController) {
    abortController.abort()
    console.log('[DS Exporter] 用户取消导出')

    // 立即更新 UI 反馈
    const statusEl = document.getElementById('ds-status')
    const cancelBtn = document.getElementById('ds-cancel-btn')
    if (statusEl) {
      statusEl.textContent = '⏹ 正在取消...'
      statusEl.className = 'ds-export-status waiting'
    }
    if (cancelBtn) {
      ;(cancelBtn as HTMLButtonElement).disabled = true
      cancelBtn.textContent = '取消中...'
    }
  }
}

/**
 * 自动滚动对话区域，触发虚拟列表渲染所有消息，
 * 同时采集每条消息的内容。
 */
async function scrollAndCollect(includeSearch: boolean = false): Promise<ParsedMessage[]> {
  const allMessages = new Map<string, ParsedMessage>() // 用内容前100字符去重
  const scrollContainer = document.querySelector('.ds-virtual-list') ||
                          document.querySelector('.ds-scroll-area') ||
                          findScrollContainer()

  if (!scrollContainer) {
    console.log('[DS Exporter] 未找到滚动容器')
    return readVisibleMessages(includeSearch)
  }

  console.log('[DS Exporter] 找到滚动容器，开始滚动采集...')

  // 创建新的 AbortController
  abortController = new AbortController()
  const signal = abortController.signal

  // 从页面获取消息（用户+助手）——点击导出时可见的这一屏
  await fetchMessagesFromPage(scrollContainer.scrollTop)

  // 检查是否已取消
  if (signal.aborted) {
    abortController = null
    return []
  }

  // 记录初始滚动位置
  const initialScrollTop = scrollContainer.scrollTop

  // 先滚动到顶部（等虚拟列表渲染出开头的消息）
  scrollContainer.scrollTop = 0
  await sleep(500, signal)

  let noChangeCount = 0
  const MAX_NO_CHANGE = 3

  while (noChangeCount < MAX_NO_CHANGE) {
    // 检查是否已取消
    if (signal.aborted) {
      scrollContainer.scrollTop = initialScrollTop
      abortController = null
      return []
    }

    // 每一屏都重新提取，虚拟列表换页后新消息才会进入缓存
    await fetchMessagesFromPage(scrollContainer.scrollTop)

    // 读取当前可见的消息（使用较短的超时）
    const visible = readVisibleMessages(includeSearch)
    for (const msg of visible) {
      const key = msg.content.slice(0, 100)
      if (!allMessages.has(key)) {
        allMessages.set(key, msg)
      }
    }

    // 向下滚动一屏
    const prevScrollTop = scrollContainer.scrollTop
    scrollContainer.scrollTop += scrollContainer.clientHeight * 0.8

    // 使用更短的 sleep，分段检查取消状态
    for (let i = 0; i < 5; i++) {
      await sleep(80, signal)
      if (signal.aborted) {
        scrollContainer.scrollTop = initialScrollTop
        abortController = null
        return []
      }
    }

    // 检查是否到底
    if (scrollContainer.scrollTop === prevScrollTop ||
        scrollContainer.scrollTop >= scrollContainer.scrollHeight - scrollContainer.clientHeight - 10) {
      noChangeCount++
    } else {
      noChangeCount = 0
    }
  }

  // 最后再抓取并读一次底部的消息
  await fetchMessagesFromPage(scrollContainer.scrollTop)

  // 恢复滚动位置
  scrollContainer.scrollTop = initialScrollTop

  // 清除 AbortController
  abortController = null

  // pageMessages 已全局去重且按 (滚动位置, 批内序号) 排序，直接以最后一次读取为准
  const result = readVisibleMessages(includeSearch)
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

/**
 * 支持取消的 sleep 函数
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve()
      return
    }

    const timer = setTimeout(resolve, ms)

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    }
  })
}

// ==================== 导出 ====================

let cachedMessages: ParsedMessage[] | null = null
let cachedMessagesUrl: string | null = null
let isCollecting = false

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
      <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor"><path d="M911.988743 783.990323H95.998815a47.999408 47.999408 0 0 1-47.999407-47.999408V127.99842a47.999408 47.999408 0 0 1 47.999407-47.999407h239.997038l143.998222 95.998815h383.99526a47.999408 47.999408 0 0 1 47.999408 47.999407z" fill="#FAEFDE"/><path d="M95.998815 79.999013h255.99684l111.998618 111.998617H47.999408V127.99842a47.999408 47.999408 0 0 1 47.999407-47.999407z" fill="#FFF7F0"/><path d="M911.988743 239.997038h63.99921a31.999605 31.999605 0 0 1 31.999605 31.999605v463.994272a47.999408 47.999408 0 0 1-47.999408 47.999408h-47.999407V239.997038z" fill="#CDA1A7"/><path d="M47.999408 623.992298h863.989335v159.998025H95.998815a47.999408 47.999408 0 0 1-47.999407-47.999408v-111.998617z" fill="#EFD8BE"/><path d="M975.987953 223.997235h-47.999408v-15.999802a47.999408 47.999408 0 0 0-47.999407-47.999408H475.354132a47.999408 47.999408 0 0 1-33.759583-13.919828l-59.679263-58.879273A79.999013 79.999013 0 0 0 325.755979 63.99921H79.999013a47.999408 47.999408 0 0 0-47.999408 47.999408v623.992297a63.99921 63.99921 0 0 0 63.99921 63.99921h863.989335a63.99921 63.99921 0 0 0 63.99921-63.99921V271.996643a47.999408 47.999408 0 0 0-47.999407-47.999408zM95.998815 767.99052a31.999605 31.999605 0 0 1-31.999605-31.999605v-95.998815h335.995853a15.999803 15.999803 0 0 0 0-31.999605H63.99921V111.998618a15.999803 15.999803 0 0 1 15.999803-15.999803h245.756966a47.999408 47.999408 0 0 1 33.759583 13.919828l59.679264 59.039271A79.999013 79.999013 0 0 0 475.354132 191.99763H879.989138a15.999803 15.999803 0 0 1 15.999802 15.999803v399.995062H623.992298a15.999803 15.999803 0 0 0 0 31.999605h271.996642v95.998815a63.039222 63.039222 0 0 0 10.079876 31.999605z m895.98894-31.999605a31.999605 31.999605 0 0 1-31.999605 31.999605 36.159554 36.159554 0 0 1-31.999605-31.999605V255.99684h47.999408a15.999803 15.999803 0 0 1 15.999802 15.999803z" fill="#8D6C9F"/><path d="M95.998815 671.991705a15.999803 15.999803 0 0 0-15.999802 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999803-15.999803zM175.997828 671.991705a15.999803 15.999803 0 0 0-15.999803 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999802-15.999803zM255.99684 671.991705a15.999803 15.999803 0 0 0-15.999802 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999803-15.999803zM335.995853 671.991705a15.999803 15.999803 0 0 0-15.999803 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999802-15.999803zM415.994865 671.991705a15.999803 15.999803 0 0 0-15.999802 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999803-15.999803zM607.992495 671.991705a15.999803 15.999803 0 0 0-15.999802 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999803-15.999803zM687.991508 671.991705a15.999803 15.999803 0 0 0-15.999803 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999802-15.999803zM767.99052 671.991705a15.999803 15.999803 0 0 0-15.999802 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999803-15.999803zM847.989533 671.991705a15.999803 15.999803 0 0 0-15.999803 15.999803v31.999605a15.999803 15.999803 0 0 0 31.999605 0v-31.999605a15.999803 15.999803 0 0 0-15.999802-15.999803z" fill="#8D6C9F"/><path d="M559.993088 431.994668v399.995062l63.99921-63.99921 63.99921 63.99921-175.997828 175.997828-175.997827-175.997828 63.99921-63.99921 63.99921 63.99921V431.994668h95.998815z" fill="#C2CDE7"/><path d="M523.35354 1019.347417l175.997827-175.997827a15.999803 15.999803 0 0 0 0-22.559722l-63.99921-63.99921a15.999803 15.999803 0 0 0-22.559721 0L575.99289 793.430206V431.994668a15.999803 15.999803 0 0 0-15.999802-15.999803h-95.998815a15.999803 15.999803 0 0 0-15.999803 15.999803v361.435538l-36.639548-36.639548a15.999803 15.999803 0 0 0-22.559721 0l-63.99921 63.99921a15.999803 15.999803 0 0 0 0 22.559722l175.997827 175.997827a15.999803 15.999803 0 0 0 22.559722 0zM358.555574 831.98973L399.995063 790.550242l52.63935 52.63935A15.999803 15.999803 0 0 0 479.994075 831.98973V447.99447h63.99921v383.99526a15.999803 15.999803 0 0 0 27.359662 11.35986l52.639351-52.799348L665.431786 831.98973 511.99368 985.427836z" fill="#8D6C9F"/></svg>
    </button>
    <div class="ds-export-menu" style="display:none">
      <div class="ds-export-options">
        <label class="ds-export-option">
          <input type="checkbox" id="ds-opt-thinking">
          <svg viewBox="0 0 1024 1024" width="16" height="16" fill="#4D6BFE"><path d="M964.783309 59.731888c91.838106 91.774107 73.982474 268.986452-29.0554 452.278672 103.037875 183.420217 120.765509 360.632562 29.0554 452.34267-91.838106 91.838106-268.986452 74.046473-452.34267-28.863404-183.420217 102.845879-360.696561 120.701511-452.470668 28.927403-91.774107-91.774107-73.982474-268.986452 28.991402-452.278672C-14.012503 328.590343-31.804136 151.377998 59.969971 59.667889c91.838106-91.838106 269.050451-74.046473 452.470668 28.927404 183.356218-102.973876 360.504565-120.765509 452.34267-28.991402v0.127997zM144.768222 600.072743l-2.43195 4.8639c-62.07872 130.173315-70.078555 243.962968-18.559617 295.609903 52.286922 52.222923 168.316528 43.327106 300.6018-20.799571-54.078885-38.399208-104.765839-81.278324-151.548874-128.253355a1170.535858 1170.535858 0 0 1-128.061359-151.420877z m735.344834 0l-12.287747 16.959651a1192.487405 1192.487405 0 0 1-267.450484 262.650583c132.221273 64.190676 248.314879 73.086493 300.473803 20.863569 52.222923-52.222923 43.391105-168.316528-20.735572-300.473803zM512.312642 194.001119l-7.039855 4.543906a1065.130032 1065.130032 0 0 0-168.572523 137.917155 1060.778121 1060.778121 0 0 0-142.461062 175.676377 1064.938036 1064.938036 0 0 0 142.52506 175.548379A1060.778121 1060.778121 0 0 0 512.37664 830.147998a1065.002034 1065.002034 0 0 0 175.54838-142.461062 1060.778121 1060.778121 0 0 0 142.52506-175.804374 1064.938036 1064.938036 0 0 0-142.52506-175.356383A1060.84212 1060.84212 0 0 0 512.37664 194.065117V193.93712z m-8.703821 217.595512a112.893672 112.893672 0 1 1 0 225.723344 112.893672 112.893672 0 0 1 0-225.787343zM424.378455 144.338143c-132.285272-64.254675-248.314879-73.022494-300.537801-20.86357-52.286922 52.222923-43.391105 168.316528 20.799571 300.537802a1175.655752 1175.655752 0 0 1 128.189356-151.548875 1179.62367 1179.62367 0 0 1 134.589224-115.83761l16.95965-12.287747z m180.86027-2.367951l-4.8639 2.43195a1170.599856 1170.599856 0 0 1 151.484876 128.061358 1170.535858 1170.535858 0 0 1 128.125357 151.420877c64.254675-132.157274 73.086493-248.186881 20.86357-300.409804-51.646935-51.582936-165.436588-43.583101-295.673902 18.559618z"/></svg>
          包含思考过程
        </label>
        <label class="ds-export-option">
          <input type="checkbox" id="ds-opt-search">
          <svg viewBox="0 0 1024 1024" width="16" height="16" fill="#4D6BFE"><path d="M512 0C229.632 0 0 229.632 0 512c0 282.24 229.76 512 512 512 282.368 0 512-229.632 512-512 0-282.24-229.632-512-512-512z m450.624 481.92h-184.704c-4.8-166.976-49.408-310.208-116.352-396.16a452.48 452.48 0 0 1 301.056 396.16z m-480.64-416.512V481.92H306.432c6.528-209.472 81.92-385.024 175.424-416.512z m0 476.672v416.512c-93.632-31.488-168.832-207.04-175.488-416.512H481.92z m60.16 416.512V542.08h175.488c-6.656 209.472-81.92 385.024-175.424 416.512z m0-476.672V65.408c93.632 31.488 168.832 207.04 175.488 416.512H542.208zM362.624 85.76C295.68 171.776 251.008 315.008 246.208 481.92H61.44a452.544 452.544 0 0 1 301.184-396.16zM61.44 542.08h184.704c4.8 166.976 49.408 310.208 116.352 396.16A452.608 452.608 0 0 1 61.44 542.08z m600.064 396.16c66.944-85.952 111.552-229.184 116.352-396.16h184.768c-11.968 183.552-134.272 337.536-301.12 396.16z"/></svg>
          包含搜索结果
        </label>
      </div>
      <div class="ds-export-formats">
        <button class="ds-export-format" data-format="markdown">
          <svg viewBox="0 0 1280 1024" width="16" height="13" fill="#2c2c2c"><path d="M1187.6 118.2H92.4C41.4 118.2 0 159.6 0 210.4v603c0 51 41.4 92.4 92.4 92.4h1095.4c51 0 92.4-41.4 92.2-92.2V210.4c0-50.8-41.4-92.2-92.4-92.2zM677 721.2H554v-240l-123 153.8-123-153.8v240H184.6V302.8h123l123 153.8 123-153.8h123v418.4z m270.6 6.2L763 512H886V302.8h123V512H1132z"/></svg>
          Markdown
        </button>
        <button class="ds-export-format" data-format="json">
          <svg viewBox="0 0 1024 1024" width="16" height="16" fill="#FF6B08"><path d="M653.88544 0a92.16 92.16 0 0 1 65.09568 26.9312l187.61728 187.21792a92.16 92.16 0 0 1 27.05408 65.2288v120.6272A80.10752 80.10752 0 0 1 1013.76 480.09216v319.7952a80.10752 80.10752 0 0 1-77.55776 80.06656l-2.54976 0.03072v48.00512c0 53.02272-43.02848 96-96.12288 96H196.7104c-53.0944 0-96.12288-42.97728-96.12288-96v-48.00512A80.10752 80.10752 0 0 1 20.48 799.8976v-319.7952a80.10752 80.10752 0 0 1 77.55776-80.06656l2.54976-0.04096V96C100.58752 42.97728 143.616 0 196.7104 0h457.17504zM837.5296 879.99488H196.7104v17.28512a30.72 30.72 0 0 0 30.72 30.72h579.3792a30.72 30.72 0 0 0 30.72-30.72v-17.28512zM558.77632 555.78624c-15.90272 0-30.03392 3.11296-42.41408 9.33888-12.36992 6.22592-23.1424 15.63648-32.28672 28.23168-5.69344 7.80288-10.10688 16.9984-13.2096 27.56608a116.13184 116.13184 0 0 0-4.67968 32.96256c0 21.74976 6.2464 38.7584 18.7392 51.01568 12.4928 12.26752 29.87008 18.40128 52.14208 18.40128 14.91968 0 28.55936-3.06176 40.88832-9.17504 12.3392-6.11328 22.85568-14.98112 31.55968-26.60352 6.144-8.32512 10.98752-18.05312 14.51008-29.19424 3.5328-11.14112 5.29408-22.44608 5.29408-33.91488 0-21.52448-6.22592-38.3488-18.67776-50.46272-12.45184-12.11392-29.73696-18.16576-51.8656-18.16576z m-237.71136 3.70688h-42.86464l-21.25824 100.9152c-1.80224 8.5504-4.9152 14.9504-9.33888 19.17952-4.42368 4.23936-10.12736 6.35904-17.1008 6.35904-2.32448 0-4.9664-0.3072-7.92576-0.90112a82.83136 82.83136 0 0 1-10.07616-2.80576l-9.00096 34.8672c4.28032 2.02752 8.94976 3.5328 14.00832 4.5056a89.856 89.856 0 0 0 16.93696 1.46432c17.6128 0 31.47776-4.05504 41.5744-12.15488 10.07616-8.0896 16.95744-20.736 20.6336-37.90848l24.41216-113.52064z m81.5616-3.4816c-20.10112 0-36.33152 4.8128-48.71168 14.45888-12.36992 9.6256-18.56512 22.17984-18.56512 37.632 0 8.76544 2.21184 16.27136 6.64576 22.49728 4.42368 6.22592 11.1616 11.24352 20.24448 15.07328 2.32448 0.9728 5.59104 2.28352 9.78944 3.9424 16.72192 6.66624 25.088 13.86496 25.088 21.59616 0 6.144-3.15392 11.02848-9.45152 14.62272-6.2976 3.60448-14.92992 5.39648-25.87648 5.39648-6.00064 0-12.1344-0.8192-18.39104-2.46784a103.39328 103.39328 0 0 1-19.4048-7.424l-9.22624 32.96256c8.25344 2.9184 16.81408 5.12 25.7024 6.57408a171.3152 171.3152 0 0 0 27.8528 2.2016c22.86592 0 40.98048-5.20192 54.33344-15.58528 13.34272-10.38336 20.0192-24.32 20.0192-41.78944 0-9.5232-2.39616-17.36704-7.19872-23.52128-4.80256-6.144-13.83424-12.4416-27.11552-18.8928a196.47488 196.47488 0 0 0-10.79296-4.73088c-11.39712-4.72064-17.1008-9.97376-17.1008-15.74912 0-5.3248 2.52928-9.39008 7.58784-12.20608 5.0688-2.80576 12.35968-4.21888 21.88288-4.21888 6.30784 0 12.45184 0.65536 18.45248 1.96608 6.00064 1.32096 11.9296 3.2768 17.77664 5.90848l9.90208-31.16032c-6.37952-2.32448-14.08-4.096-23.12192-5.28384a231.79264 231.79264 0 0 0-30.3104-1.80224z m319.2832 3.4816h-52.54144l-34.0992 159.86688h39.15776l17.664-83.58912c0.9728-4.64896 1.87392-9.6256 2.70336-14.8992 0.8192-5.29408 1.60768-10.8544 2.3552-16.71168h1.6896c0.45056 4.64896 1.1264 9.09312 2.02752 13.33248 0.90112 4.23936 1.98656 8.37632 3.26656 12.43136l27.21792 89.43616h52.5312l34.0992-159.86688h-38.93248l-17.1008 80.896a390.01088 390.01088 0 0 0-3.70688 18.8928 153.58976 153.58976 0 0 0-1.80224 14.7456h-1.91488a128.88064 128.88064 0 0 0-2.58048-14.848 262.79936 262.79936 0 0 0-5.18144-18.56512l-24.86272-81.12128z m-165.9392 25.98912c9.29792 0 16.4864 3.19488 21.59616 9.56416 5.09952 6.37952 7.64928 15.4112 7.64928 27.11552 0 8.17152-1.16736 16.57856-3.4816 25.1904-2.33472 8.63232-5.36576 15.91296-9.1136 21.83168-5.09952 7.7312-10.43456 13.44512-15.9744 17.16224a31.92832 31.92832 0 0 1-18.1248 5.56032c-8.99072 0-16.0768-3.23584-21.25824-9.728-5.1712-6.48192-7.76192-15.36-7.76192-26.60352 0-8.25344 1.16736-16.71168 3.4816-25.37472 2.33472-8.66304 5.36576-16.0256 9.1136-22.09792 4.57728-7.43424 9.73824-13.056 15.47264-16.87552a32.5632 32.5632 0 0 1 18.40128-5.7344z m52.36736-497.16224H227.4304a30.72 30.72 0 0 0-30.72 30.72v280.95488h640.8192v-81.5616H700.52864c-50.8928-0.01024-92.14976-41.2672-92.16-92.16l-0.03072-137.95328z m96.12288 59.84256v58.91072a15.36 15.36 0 0 0 15.36 15.36h59.0848l-74.4448-74.27072z"/></svg>
          JSON
        </button>
        <button class="ds-export-format" data-format="html">
          <svg viewBox="0 0 1024 1024" width="16" height="16" fill="#64A247"><path d="M535.42 74.41H593v91.38c108.53 0.61 217.17-1.12 325.6 0.51 23.35-2.23 41.63 15.94 39.29 39.29 1.73 189.66-0.41 379.42 1 569.19-1 20.5 2 43.25-9.75 61.42-14.82 10.76-34.11 9.34-51.47 10.15-101.53-0.51-203.06-0.35-304.67-0.35v101.57h-63.18c-154.73-28.23-309.77-54-464.6-81.22q-0.15-355.31 0-710.51c156.67-27.12 313.33-54.73 470.2-81.43z"/><path d="M112.32 550.12V426h23.19v48.84h45.44V426h23.2v124.1h-23.2v-54.25h-45.44v54.27zM254 550.12V447h-34.11v-21h91.29v21h-34v103.12zM325.84 550.12V426h34.71l20.84 84.65L402 426h34.79v124.1h-21.55v-97.67l-22.8 97.68h-22.33l-22.73-97.68v97.68zM460.44 550.12V427h23.2v102.2h57.67v20.91zM589.6 196.24v619.34h335.05V196.24z m75.43 361l-48.73-39a7.37 7.37 0 0 1-2.44-5.69 9.22 9.22 0 0 1 2.44-6.5l48.73-39a8 8 0 1 1 11.37 11.37l-42.24 34.18 42.24 34.12c3.25 3.25 3.25 8.12 0 10.56a7.85 7.85 0 0 1-11.4-0.01z m17.87 57.67c-4.87-0.81-5.69-6.5-3.25-10.56l101.53-195.72c2.44-4.06 7.31-5.69 11.37-3.25a8.74 8.74 0 0 1 2.45 11.37L694.27 611.69c-2.44 4.06-6.5 4.88-11.37 3.25z m172.2-95.85l-48.74 39A8 8 0 0 1 795 546.71l42.24-34.12L795 478.48a8 8 0 0 1 11.37-11.37l48.74 39q2.44 2.44 2.44 7.31a8.78 8.78 0 0 1-2.46 5.68z" fill="#FFFFFF"/></svg>
          HTML
        </button>
      </div>
      <div class="ds-export-status-container">
        <div class="ds-export-status" id="ds-status"></div>
        <button class="ds-export-cancel-btn" id="ds-cancel-btn" style="display:none">取消导出</button>
      </div>
    </div>
  `
  document.body.appendChild(wrapper)

  const trigger = wrapper.querySelector('.ds-export-trigger')!
  const menu = wrapper.querySelector('.ds-export-menu') as HTMLElement
  const optThinking = wrapper.querySelector('#ds-opt-thinking') as HTMLInputElement
  const optSearch = wrapper.querySelector('#ds-opt-search') as HTMLInputElement

  // 从 storage 加载设置
  chrome.storage.sync.get(['includeThinking', 'includeSearch'], (result) => {
    optThinking.checked = result.includeThinking ?? false
    optSearch.checked = result.includeSearch ?? false
  })

  // 监听变化并保存到 storage
  optThinking.addEventListener('change', () => {
    chrome.storage.sync.set({ includeThinking: optThinking.checked })
  })
  optSearch.addEventListener('change', () => {
    chrome.storage.sync.set({ includeSearch: optSearch.checked })
  })

  // 监听 storage 变化（来自 popup 的同步）
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.includeThinking) optThinking.checked = changes.includeThinking.newValue
    if (changes.includeSearch) optSearch.checked = changes.includeSearch.newValue
  })

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
      await doExport(format, optThinking.checked, optSearch.checked)
    })
  })

  // 取消按钮事件
  const cancelBtn = wrapper.querySelector('#ds-cancel-btn') as HTMLButtonElement
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    cancelExport()
  })
}

async function doExport(format: string, includeThinking: boolean, includeSearch: boolean) {
  const statusEl = document.getElementById('ds-status')
  const cancelBtn = document.getElementById('ds-cancel-btn')

  if (isCollecting) {
    showNotification('正在采集中，请稍候...', 'error')
    return
  }

  // 缓存属于别的对话时强制重新采集，防止切换对话后导出旧数据
  if (cachedMessages && cachedMessagesUrl !== location.href) {
    console.log('[DS Exporter] URL 已变化，丢弃旧对话缓存')
    cachedMessages = null
  }

  // 如果没有缓存数据，先采集
  if (!cachedMessages || cachedMessages.length === 0) {
    isCollecting = true

    // 显示状态和取消按钮
    if (statusEl) {
      statusEl.textContent = '⏳ 正在滚动采集对话数据...'
      statusEl.className = 'ds-export-status waiting'
    }
    if (cancelBtn) {
      cancelBtn.style.display = 'block'
    }

    // 禁用导出按钮
    disableExportButtons(true)

    try {
      cachedMessages = await scrollAndCollect(includeSearch)
      cachedMessagesUrl = location.href
    } catch (e) {
      console.error('[DS Exporter] 采集失败:', e)
      showNotification('采集失败，请重试', 'error')
      isCollecting = false
      resetExportUI()
      return
    }
    isCollecting = false

    // 检查是否被取消
    if (cachedMessages.length === 0) {
      showNotification('导出已取消', 'error')
      resetExportUI()
      return
    }
  }

  if (!cachedMessages || cachedMessages.length === 0) {
    showNotification('未找到对话内容', 'error')
    resetExportUI()
    return
  }

  if (statusEl) {
    statusEl.textContent = `✅ ${cachedMessages.length} 条消息`
    statusEl.className = 'ds-export-status captured'
  }

  const now = new Date()
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
  const title = document.title.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30) || 'deepseek'

  switch (format) {
    case 'markdown':
      triggerDownload(exportMarkdown(cachedMessages, includeThinking), `${title}_${ts}.md`, 'text/markdown')
      break
    case 'json':
      triggerDownload(exportJson(cachedMessages, location.href), `${title}_${ts}.json`, 'application/json')
      break
    case 'html':
      triggerDownload(exportHtml(cachedMessages), `${title}_${ts}.html`, 'text/html')
      break
  }

  showNotification(`已导出 ${cachedMessages.length} 条消息 (${format})`, 'success')
  resetExportUI()
}

/**
 * 重置导出 UI 状态
 */
function resetExportUI() {
  const statusEl = document.getElementById('ds-status')
  const cancelBtn = document.getElementById('ds-cancel-btn')

  if (cancelBtn) {
    cancelBtn.style.display = 'none'
  }
  if (statusEl) {
    statusEl.textContent = ''
    statusEl.className = 'ds-export-status'
  }
  disableExportButtons(false)
}

/**
 * 禁用/启用导出按钮
 */
function disableExportButtons(disabled: boolean) {
  document.querySelectorAll('.ds-export-format').forEach(btn => {
    (btn as HTMLButtonElement).disabled = disabled
  })
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
  cachedMessagesUrl = null
  pageMessages = [] // 清除页面消息缓存
  console.log('[DS Exporter] 路由变化，缓存已清除')
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => { debounceTimer = null; injectUI() }, 1500)
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
    // onRouteChange 内的 injectUI 定时器触发后同样要清空，否则会永久阻塞 Observer
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
