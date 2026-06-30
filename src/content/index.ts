// ==================== DeepSeek 对话导出 - Fiber Reader 方案 ====================
// 策略：自动滚动对话 → 触发虚拟列表渲染 → 从 React fiber 读取完整内容

console.log('[DS Exporter] Fiber Reader 方案启动')

interface SearchReference {
  index: number
  url: string
  title?: string
}

interface ParsedMessage {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  searchSummary?: string
  searchReferences?: SearchReference[]
}

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

// 注入脚本到页面主世界，提取消息（用户+助手）
function injectScriptToGetMessages(): Promise<Array<{role: 'user' | 'assistant', content: string}>> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'DS_EXPORTER_MESSAGES_RESULT') {
        window.removeEventListener('message', handler)
        resolve(event.data.messages || [])
      }
    }
    window.addEventListener('message', handler)

    const script = document.createElement('script')
    script.textContent = `
      (function() {
        try {
          const messages = [];

          // 查找所有消息容器（虚拟列表的可见项）
          const virtualItems = document.querySelector('.ds-virtual-list-visible-items') ||
                               document.querySelector('[class*="virtual-list"]');
          const chatContainer = virtualItems || document.querySelector('[class*="chat-list"]') ||
                               document.querySelector('[class*="message-list"]');

          if (!chatContainer) {
            // 回退：直接查找所有消息元素
            extractFromDirectDOM();
          } else {
            // 从容器中提取消息
            extractFromContainer(chatContainer);
          }

          // 如果上面没找到，尝试直接查找 DOM 元素
          if (messages.length === 0) {
            extractFromDirectDOM();
          }

          function extractFromContainer(container) {
            Array.from(container.children).forEach(child => {
              // 跳过太小的元素
              if (child.offsetHeight < 20) return;

              // 判断角色：检查是否包含 assistant 消息元素
              const assistantEl = child.querySelector('.ds-assistant-message-main-content');

              if (assistantEl) {
                // 助手消息：从 React fiber 提取 Markdown AST
                const content = extractAssistantMarkdown(assistantEl);
                if (content) {
                  messages.push({ role: 'assistant', content: content });
                }
              } else {
                // 用户消息：提取文本内容
                // 查找用户消息的文本区域
                const userTextEl = child.querySelector('[class*="user-message"]') ||
                                   child.querySelector('[class*="ds-markdown"]') ||
                                   child;
                const text = (userTextEl.textContent || '').trim();
                if (text.length > 0) {
                  messages.push({ role: 'user', content: text });
                }
              }
            });
          }

          function extractFromDirectDOM() {
            // 查找助手消息
            document.querySelectorAll('.ds-assistant-message-main-content').forEach(el => {
              const content = extractAssistantMarkdown(el);
              if (content) {
                messages.push({ role: 'assistant', content: content });
              }
            });

            // 查找用户消息（通过排除助手消息的方式）
            document.querySelectorAll('.ds-message, [class*="message"]').forEach(el => {
              const hasAssistant = el.querySelector('.ds-assistant-message-main-content');
              if (hasAssistant) return;
              const text = (el.textContent || '').trim();
              if (text.length > 0 && text.length < 5000) {
                messages.push({ role: 'user', content: text });
              }
            });
          }

          function extractAssistantMarkdown(el) {
            let fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            if (!fiberKey) {
              const child = el.querySelector('[class*="ds-markdown"]') || el.firstElementChild;
              if (child) {
                const childFiberKey = Object.keys(child).find(k => k.startsWith('__reactFiber$'));
                if (childFiberKey) {
                  el = child;
                  fiberKey = childFiberKey;
                }
              }
            }

            if (!fiberKey) return null;

            let fiber = el[fiberKey];
            let depth = 0;
            const astNodes = [];

            while (fiber && depth < 30) {
              const props = fiber.memoizedProps;
              if (props && typeof props === 'object') {
                if (props.node && typeof props.node === 'object' && props.node.type) {
                  const blockTypes = ['paragraph', 'heading', 'list', 'blockquote', 'code', 'thematicBreak'];
                  if (blockTypes.includes(props.node.type)) {
                    astNodes.push(props.node);
                  }
                }
              }
              fiber = fiber.return;
              depth++;
            }

            if (astNodes.length > 0) {
              return astNodes.map(node => astToMarkdown(node)).join('\\n\\n');
            }
            return null;
          }

          // AST 转换函数
          function astToMarkdown(node) {
            if (!node) return '';

            switch (node.type) {
              case 'root':
                return (node.children || []).map(child => astToMarkdown(child)).join('\\n\\n');

              case 'paragraph':
                return (node.children || []).map(child => astToMarkdown(child)).join('');

              case 'heading':
                const prefix = '#'.repeat(node.depth || 1);
                const content = (node.children || []).map(child => astToMarkdown(child)).join('');
                return prefix + ' ' + content;

              case 'text':
                return node.value || '';

              case 'strong':
                const strongContent = (node.children || []).map(child => astToMarkdown(child)).join('');
                return '**' + strongContent + '**';

              case 'emphasis':
                const emContent = (node.children || []).map(child => astToMarkdown(child)).join('');
                return '*' + emContent + '*';

              case 'inlineCode':
                return '\`' + (node.value || '') + '\`';

              case 'code':
                const lang = node.lang || '';
                return '\`\`\`' + lang + '\\n' + (node.value || '') + '\\n\`\`\`';

              case 'blockquote':
                const quoteContent = (node.children || []).map(child => astToMarkdown(child)).join('\\n');
                return quoteContent.split('\\n').map(line => '> ' + line).join('\\n');

              case 'list':
                const items = (node.children || []).map((item, index) => {
                  const itemContent = astToMarkdown(item);
                  if (node.ordered) {
                    return (node.start || 1) + index + '. ' + itemContent;
                  } else {
                    return '- ' + itemContent;
                  }
                });
                return items.join('\\n');

              case 'listItem':
                const itemChildren = (node.children || []).map(child => astToMarkdown(child));
                return itemChildren.join('\\n  ');

              case 'link':
                const linkText = (node.children || []).map(child => astToMarkdown(child)).join('');
                const url = node.url || '';
                return '[' + linkText + '](' + url + ')';

              case 'image':
                const alt = node.alt || '';
                const src = node.url || '';
                return '![' + alt + '](' + src + ')';

              case 'thematicBreak':
                return '---';

              case 'break':
                return '\\n';

              case 'delete':
                const delContent = (node.children || []).map(child => astToMarkdown(child)).join('');
                return '~~' + delContent + '~~';

              default:
                if (node.children) {
                  return node.children.map(child => astToMarkdown(child)).join('');
                }
                return node.value || '';
            }
          }

          // 发送结果给 content script
          window.postMessage({
            type: 'DS_EXPORTER_MESSAGES_RESULT',
            messages: messages
          }, '*');
        } catch (e) {
          console.error('[DS Exporter] 注入脚本执行失败:', e);
          window.postMessage({
            type: 'DS_EXPORTER_MESSAGES_RESULT',
            messages: []
          }, '*');
        }
      })();
    `;
    document.head.appendChild(script);
    script.remove();

    // 超时处理
    setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve([])
    }, 3000)
  })
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
let pageMessages: Array<{role: 'user' | 'assistant', content: string}> = []

// 从页面获取消息（用户+助手）
async function fetchMessagesFromPage(): Promise<void> {
  try {
    console.log('[DS Exporter] 尝试从页面获取消息...')
    const messages = await injectScriptToGetMessages()

    if (messages.length > 0) {
      console.log('[DS Exporter] 成功获取', messages.length, '条消息')
      // 合并新消息（去重）
      const existingKeys = new Set(pageMessages.map(m => m.content.slice(0, 100)))
      for (const msg of messages) {
        const key = msg.content.slice(0, 100)
        if (!existingKeys.has(key)) {
          pageMessages.push(msg)
          existingKeys.add(key)
        }
      }
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

  // 优先使用从注入脚本获取的结构化消息
  if (pageMessages.length > 0) {
    for (const msg of pageMessages) {
      const key = msg.content.slice(0, 100)
      if (!seen.has(key)) {
        seen.add(key)
        messages.push({ role: msg.role, content: msg.content })
      }
    }
    console.log('[DS Exporter] 使用页面消息:', messages.length, '条')
  }

  // 如果页面消息为空，回退到 DOM 提取
  if (messages.length === 0) {
    // 查找助手消息
    document.querySelectorAll('.ds-assistant-message-main-content').forEach(el => {
      const text = el.textContent?.trim() || ''
      if (text && !seen.has(text.slice(0, 100))) {
        seen.add(text.slice(0, 100))
        messages.push({ role: 'assistant', content: text })
      }
    })

    // 查找用户消息
    document.querySelectorAll('.ds-message, [class*="message"]').forEach(el => {
      const hasAssistant = el.querySelector('.ds-assistant-message-main-content')
      if (hasAssistant) return
      const text = el.textContent?.trim() || ''
      if (text.length > 0 && !seen.has(text.slice(0, 100))) {
        seen.add(text.slice(0, 100))
        messages.push({ role: 'user', content: text })
      }
    })

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

  // 将搜索结果附加到最后一个 assistant 消息（仅当 includeSearch 为 true 时）
  if (includeSearch) {
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
    abortController = null
    console.log('[DS Exporter] 用户取消导出')
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

  // 从页面获取消息（用户+助手）
  await fetchMessagesFromPage()

  // 检查是否已取消
  if (signal.aborted) return []

  // 记录初始滚动位置
  const initialScrollTop = scrollContainer.scrollTop

  // 先滚动到顶部
  scrollContainer.scrollTop = 0
  await sleep(300, signal)

  let noChangeCount = 0
  const MAX_NO_CHANGE = 3

  while (noChangeCount < MAX_NO_CHANGE) {
    // 检查是否已取消
    if (signal.aborted) {
      // 恢复滚动位置
      scrollContainer.scrollTop = initialScrollTop
      return []
    }

    // 读取当前可见的消息
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
    await sleep(500, signal)

    // 检查是否已取消
    if (signal.aborted) {
      scrollContainer.scrollTop = initialScrollTop
      return []
    }

    // 检查是否到底
    if (scrollContainer.scrollTop === prevScrollTop ||
        scrollContainer.scrollTop >= scrollContainer.scrollHeight - scrollContainer.clientHeight - 10) {
      noChangeCount++
    } else {
      noChangeCount = 0
    }
  }

  // 最后再读一次底部的消息
  const final = readVisibleMessages(includeSearch)
  for (const msg of final) {
    const key = msg.content.slice(0, 100)
    if (!allMessages.has(key)) {
      allMessages.set(key, msg)
    }
  }

  // 恢复滚动位置
  scrollContainer.scrollTop = initialScrollTop

  // 清除 AbortController
  abortController = null

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
let isCollecting = false

function exportMarkdown(messages: ParsedMessage[], includeThinking: boolean): string {
  const lines: string[] = []
  lines.push(`# DeepSeek 对话导出\n`)
  lines.push(`> 导出时间：${getLocalTimeString()}`)
  lines.push(`> 消息数：${messages.length} 条\n`)
  lines.push('---\n')

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const isUser = msg.role === 'user'
    lines.push(`## ${isUser ? '👤 用户' : '🐋 DeepSeek'}\n`)

    if (includeThinking && msg.thinking) {
      lines.push(`<details>\n<summary>🧠 思考过程</summary>\n`)
      lines.push(msg.thinking)
      lines.push(`\n</details>\n`)
    }

    // 搜索结果（作为子标题）
    if (msg.searchSummary || (msg.searchReferences && msg.searchReferences.length > 0)) {
      lines.push('### 🔍 网页搜索\n')
      if (msg.searchSummary) {
        lines.push(`> ${msg.searchSummary}`)
      }
      if (msg.searchReferences && msg.searchReferences.length > 0) {
        lines.push('\n**搜索来源：**\n')
        for (const ref of msg.searchReferences) {
          lines.push(`[${ref.index}] ${ref.url}`)
        }
      }
      lines.push('')
    }

    // 正文内容（作为子标题）
    lines.push('### 📝 回答\n')
    lines.push(msg.content)
    lines.push('')

    if (i < messages.length - 1) lines.push('---\n')
  }
  return lines.join('\n')
}

function getLocalTimeString(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
}

function exportJson(messages: ParsedMessage[]): string {
  return JSON.stringify({
    exported_at: getLocalTimeString(),
    url: location.href,
    message_count: messages.length,
    messages
  }, null, 2)
}

function exportHtml(messages: ParsedMessage[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const deepseekIcon = `<svg viewBox="0 0 1024 1024" width="20" height="20" style="vertical-align:middle;margin-right:6px"><path d="M0 0m146.285714 0l731.428572 0q146.285714 0 146.285714 146.285714l0 731.428572q0 146.285714-146.285714 146.285714l-731.428572 0q-146.285714 0-146.285714-146.285714l0-731.428572q0-146.285714 146.285714-146.285714Z" fill="#FFFFFF"/><path d="M834.194286 329.106286c-6.948571-3.401143-9.947429 3.072-14.006857 6.326857-1.426286 1.024-2.56 2.413714-3.766858 3.657143-10.24 10.788571-22.089143 17.846857-37.668571 17.005714-22.710857-1.28-42.166857 5.814857-59.318857 23.003429-3.657143-21.211429-15.725714-33.865143-34.230857-41.984-9.654857-4.205714-19.382857-8.411429-26.148572-17.627429-4.754286-6.546286-5.997714-13.824-8.338285-20.955429-1.536-4.352-2.998857-8.777143-8.045715-9.508571-5.485714-0.841143-7.643429 3.693714-9.801143 7.497143-8.594286 15.506286-11.885714 32.548571-11.556571 49.883428 0.731429 38.948571 17.334857 69.888 50.395429 91.940572 3.730286 2.56 4.754286 5.083429 3.547428 8.777143-2.267429 7.570286-4.937143 14.994286-7.314286 22.564571-1.462857 4.864-3.730286 5.924571-8.996571 3.803429a151.881143 151.881143 0 0 1-47.652571-31.963429c-23.478857-22.491429-44.726857-47.250286-71.204572-66.669714a316.233143 316.233143 0 0 0-18.870857-12.763429c-27.062857-25.965714 3.510857-47.213714 10.605714-49.773714 7.387429-2.633143 2.56-11.702857-21.357714-11.593143-23.917714 0.109714-45.824 8.045714-73.691429 18.578286-4.132571 1.536-8.411429 2.779429-12.763428 3.657143a266.422857 266.422857 0 0 0-79.067429-2.742857c-51.712 5.705143-92.964571 29.842286-123.392 71.094857-36.461714 49.554286-45.056 105.910857-34.486857 164.644571 10.971429 61.915429 43.008 113.152 92.16 153.234286 50.907429 41.581714 109.568 61.915429 176.530286 58.002286 40.667429-2.304 85.942857-7.68 136.996571-50.432 12.836571 6.363429 26.368 8.886857 48.786286 10.788571 17.298286 1.609143 33.938286-0.841143 46.811429-3.510857 20.114286-4.169143 18.761143-22.674286 11.483428-26.002286-59.136-27.245714-46.153143-16.164571-57.929143-25.124571 29.988571-35.108571 75.300571-71.606857 92.964572-189.842286 1.426286-9.398857 0.219429-15.286857 0-22.893714-0.109714-4.608 0.987429-6.4 6.363428-6.948572 14.848-1.536 29.257143-5.888 42.349715-12.873143 38.326857-20.662857 53.76-54.637714 57.417142-95.341714 0.548571-6.217143-0.109714-12.653714-6.765714-15.945143z m-333.677715 366.409143c-57.307429-44.544-85.065143-59.245714-96.548571-58.587429-10.752 0.658286-8.813714 12.8-6.473143 20.699429 2.450286 7.826286 5.668571 13.165714 10.24 20.041142 3.072 4.534857 5.229714 11.264-3.181714 16.347429-18.432 11.300571-50.468571-3.803429-51.968-4.534857-37.376-21.686857-68.571429-50.432-90.550857-89.673143a271.36 271.36 0 0 1-35.620572-121.453714c-0.548571-10.459429 2.56-14.153143 13.056-16.091429a130.450286 130.450286 0 0 1 41.947429-1.024c58.514286 8.448 108.251429 34.267429 150.016 75.190857 23.771429 23.296 41.801143 51.2 60.342857 78.372572 19.748571 28.891429 40.996571 56.429714 68.022857 78.994285 9.581714 7.899429 17.152 13.933714 24.502857 18.358858-22.016 2.413714-58.697143 2.925714-83.785143-16.676572z m27.428572-174.592c0-5.705143 5.851429-9.728 11.373714-7.789715a8.265143 8.265143 0 0 1 1.024 15.177143 8.777143 8.777143 0 0 1-7.277714 0.292572 8.192 8.192 0 0 1-5.12-7.68z m85.284571 43.264c-5.12 2.340571-10.605714 3.803429-16.201143 4.315428a34.450286 34.450286 0 0 1-21.869714-6.838857c-7.497143-6.217143-12.873143-9.728-15.140571-20.553143a46.811429 46.811429 0 0 1 0.438857-15.981714c1.938286-8.850286-0.219429-14.518857-6.582857-19.675429-5.12-4.205714-11.702857-5.412571-18.870857-5.412571a15.286857 15.286857 0 0 1-9.289143-3.803429 6.656 6.656 0 0 1-1.645715-5.302857 6.619429 6.619429 0 0 1 0.877715-2.706286 30.354286 30.354286 0 0 1 5.302857-5.668571c9.728-5.485714 20.992-3.693714 31.414857 0.402286 9.618286 3.913143 16.896 11.081143 27.428571 21.211428 10.752 12.214857 12.690286 15.616 18.797715 24.795429 4.827429 7.131429 9.216 14.555429 12.178285 22.966857 1.828571 5.266286-0.512 9.581714-6.802285 12.251429z" fill="#4D6BFE"/></svg>`
  let body = ''
  for (const msg of messages) {
    const isUser = msg.role === 'user'
    body += `<div class="msg ${msg.role}">\n`
    body += `  <div class="msg-header">${isUser ? '👤 用户' : deepseekIcon + 'DeepSeek'}</div>\n`
    if (msg.thinking) {
      body += `  <details class="thinking"><summary>🧠 思考过程</summary><pre>${esc(msg.thinking)}</pre></details>\n`
    }

    // 搜索结果（作为子标题）
    if (msg.searchSummary || (msg.searchReferences && msg.searchReferences.length > 0)) {
      body += `  <div class="search-results">\n`
      body += `    <h3>🔍 网页搜索</h3>\n`
      if (msg.searchSummary) {
        body += `    <div class="search-summary">${esc(msg.searchSummary)}</div>\n`
      }
      if (msg.searchReferences && msg.searchReferences.length > 0) {
        body += `    <div class="search-references">\n`
        body += `      <strong>搜索来源：</strong>\n`
        body += `      <ul>\n`
        for (const ref of msg.searchReferences) {
          body += `        <li><a href="${esc(ref.url)}" target="_blank">[${ref.index}] ${esc(ref.url)}</a></li>\n`
        }
        body += `      </ul>\n`
        body += `    </div>\n`
      }
      body += `  </div>\n`
    }

    // 正文内容（作为子标题）
    body += `  <div class="msg-section">\n`
    body += `    <h3>📝 回答</h3>\n`
    body += `    <div class="msg-body">${esc(msg.content)}</div>\n`
    body += `  </div>\n`

    body += `</div>\n`
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>DeepSeek 对话导出</title>
<style>
  body{max-width:800px;margin:0 auto;padding:20px;font-family:-apple-system,sans-serif;line-height:1.6;color:#333}
  h1{text-align:center}.meta{text-align:center;color:#666;margin-bottom:30px}
  .msg{margin:20px 0;padding:16px;border-radius:12px}
  .msg.user{background:#e3f2fd;border-left:4px solid #2196f3}
  .msg.assistant{background:#f5f5f5;border-left:4px solid #4caf50}
  .msg-header{font-weight:bold;margin-bottom:8px;display:flex;align-items:center}
  .msg-body{white-space:pre-wrap;word-break:break-word}
  .thinking{margin:10px 0;padding:10px;background:#fff3e0;border-radius:8px}
  .thinking summary{cursor:pointer;font-weight:bold}
  .msg-section{margin:15px 0}
  .msg-section h3{margin:0 0 10px 0;font-size:16px;color:#333}
  .search-results{margin:15px 0;padding:12px;background:#f0f7ff;border-radius:8px;border-left:4px solid #2196f3}
  .search-results h3{margin:0 0 10px 0;font-size:16px;color:#1565c0}
  .search-summary{margin-bottom:8px;color:#333}
  .search-references ul{margin:8px 0 0 20px;padding:0}
  .search-references li{margin:4px 0}
  .search-references a{color:#1976d2;text-decoration:none}
  .search-references a:hover{text-decoration:underline}
  pre{background:#282c34;color:#abb2bf;padding:12px;border-radius:8px;overflow-x:auto}
  table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}
</style></head><body>
<h1>📤 DeepSeek 对话导出</h1>
<div class="meta">导出时间：${getLocalTimeString()} · ${messages.length} 条消息</div>
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
      triggerDownload(exportJson(cachedMessages), `${title}_${ts}.json`, 'application/json')
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
  pageMessages = [] // 清除页面消息缓存
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
