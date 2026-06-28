// ==================== DeepSeek 对话导出 - Popup ====================

import { ConversationMeta, ExportOptions } from '../shared/types.js'

let selectedChatId: string | null = null

// DOM 元素
const convListEl = document.getElementById('conv-list')!
const statusEl = document.getElementById('status')!
const btnMd = document.getElementById('btn-md')!
const btnJson = document.getElementById('btn-json')!
const btnHtml = document.getElementById('btn-html')!
const optThinking = document.getElementById('opt-thinking') as HTMLInputElement
const optSearch = document.getElementById('opt-search') as HTMLInputElement

// ==================== 设置同步 ====================

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

// 监听 storage 变化（来自 content script 的同步）
chrome.storage.onChanged.addListener((changes) => {
  if (changes.includeThinking) optThinking.checked = changes.includeThinking.newValue
  if (changes.includeSearch) optSearch.checked = changes.includeSearch.newValue
})

// ==================== 加载对话列表 ====================

async function loadConversations() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION_LIST' })
    const conversations: ConversationMeta[] = response?.conversations || []

    if (conversations.length === 0) {
      convListEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">📭</div>
          <div>暂无已捕获的对话</div>
          <div style="margin-top:8px;font-size:12px;color:#aaa">
            请先打开一个 DeepSeek 对话页面<br>插件会自动拦截并捕获对话数据
          </div>
        </div>
      `
      return
    }

    convListEl.innerHTML = conversations.map(conv => `
      <div class="conversation-item" data-chat-id="${conv.chat_id}">
        <span class="title">${escapeHtml(conv.title || '未命名对话')}</span>
        <span class="count">${conv.message_count || '?'} 条</span>
      </div>
    `).join('')

    // 绑定点击事件
    convListEl.querySelectorAll('.conversation-item').forEach(item => {
      item.addEventListener('click', () => {
        convListEl.querySelectorAll('.conversation-item').forEach(i => i.classList.remove('selected'))
        item.classList.add('selected')
        selectedChatId = (item as HTMLElement).dataset.chatId!
        enableExportButtons(true)
      })
    })

    // 自动选中第一个
    if (conversations.length > 0) {
      const first = convListEl.querySelector('.conversation-item') as HTMLElement
      first?.click()
    }
  } catch (err) {
    convListEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">⚠️</div>
        <div>加载失败</div>
        <div style="margin-top:8px;font-size:12px;color:#aaa">请确保已打开 DeepSeek 对话页面</div>
      </div>
    `
  }
}

// ==================== 导出 ====================

async function handleExport(format: 'markdown' | 'json' | 'html') {
  if (!selectedChatId) {
    showStatus('请先选择一个对话', 'error')
    return
  }

  const options: ExportOptions = {
    format,
    includeThinking: optThinking.checked,
    includeSearchResults: optSearch.checked
  }

  showStatus('正在导出...')
  enableExportButtons(false)

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'REQUEST_EXPORT',
      payload: {
        chatId: selectedChatId,
        options
      }
    })

    if (response?.error) {
      showStatus(response.error, 'error')
    } else if (response?.success) {
      showStatus(`已导出：${response.filename}`, 'success')
    }
  } catch (err: any) {
    showStatus(`导出失败：${err.message}`, 'error')
  } finally {
    enableExportButtons(true)
  }
}

// ==================== UI 辅助 ====================

function enableExportButtons(enabled: boolean) {
  ;[btnMd, btnJson, btnHtml].forEach(btn => {
    (btn as HTMLButtonElement).disabled = !enabled
  })
}

function showStatus(message: string, type?: 'success' | 'error') {
  statusEl.textContent = message
  statusEl.className = `status ${type || ''}`
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// ==================== 事件绑定 ====================

btnMd.addEventListener('click', () => handleExport('markdown'))
btnJson.addEventListener('click', () => handleExport('json'))
btnHtml.addEventListener('click', () => handleExport('html'))

// ==================== 初始化 ====================

loadConversations()
