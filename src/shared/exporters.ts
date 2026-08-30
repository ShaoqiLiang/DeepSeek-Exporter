// ==================== 导出格式生成（content / background 共用） ====================

import type { ParsedMessage } from './types.js'

export function getLocalTimeString(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
}

export function fileTimestamp(): string {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
}

export function sanitizeFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30) || 'deepseek'
}

/**
 * 清理 DeepSeek 引用角标在正文中的残留。
 * 引用角标以 "-1"、"-4" 这类文本紧贴在中文词后面，连续引用会拼成 "-1-4-7"，
 * 转换成可读的 [1][4][7] 形式。
 */
function sanitizeCitations(text: string): string {
  return text.replace(
    /(?<=[\u4e00-\u9fff（）“”])((?:-\d+)+)(?=[\u4e00-\u9fff（）。、“”！？，,.;；:：\s]|$)/g,
    (_m, nums: string) => ' ' + nums.slice(1).split('-').map((n: string) => `[${n}]`).join('')
  )
}

export function exportMarkdown(messages: ParsedMessage[], includeThinking: boolean): string {
  const lines: string[] = []

  // 用第一条提问作为文档标题
  const firstUser = messages.find(m => m.role === 'user')
  const title = firstUser ? firstUser.content.split('\n')[0].slice(0, 60) : 'DeepSeek 对话导出'
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`> 导出时间：${getLocalTimeString()} · ${messages.length} 条消息`)
  lines.push('')

  let round = 0
  for (const msg of messages) {
    if (msg.role === 'user') {
      round++
      lines.push(`## 🙋 提问 ${round}`)
      lines.push('')
      lines.push(msg.content)
      lines.push('')
    } else {
      lines.push(`## 🤖 回答 ${round || ''}`.trimEnd())
      lines.push('')

      // 思考过程
      if (includeThinking && msg.thinking) {
        lines.push('<details>')
        lines.push('<summary>🧠 思考过程</summary>')
        lines.push('')
        lines.push(msg.thinking)
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }

      // 正文：直接输出 AI 的原始 Markdown 内容（保持表格、加粗、列表等格式）
      lines.push(sanitizeCitations(msg.content))
      lines.push('')

      // 搜索来源放在回答末尾，不打断正文
      if (msg.searchSummary || (msg.searchReferences && msg.searchReferences.length > 0)) {
        lines.push(`> 🔍 ${msg.searchSummary || '已搜索网页'}`)
        if (msg.searchReferences && msg.searchReferences.length > 0) {
          lines.push('>')
          for (const ref of msg.searchReferences) {
            lines.push(`> [${ref.index}] ${ref.url}`)
          }
        }
        lines.push('')
      }
    }
  }

  // 底部声明
  lines.push('---')
  lines.push('*本回答由AI生成，内容仅供参考，请仔细甄别*')
  lines.push('')

  return lines.join('\n')
}

export function exportJson(messages: ParsedMessage[], url?: string): string {
  return JSON.stringify({
    exported_at: getLocalTimeString(),
    url,
    message_count: messages.length,
    messages
  }, null, 2)
}

export function exportHtml(messages: ParsedMessage[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const deepseekIcon = `<svg viewBox="0 0 1024 1024" width="20" height="20" style="vertical-align:middle;margin-right:6px"><path d="M0 0m146.285714 0l731.428572 0q146.285714 0 146.285714 146.285714l0 731.428572q0 146.285714-146.285714 146.285714l-731.428572 0q-146.285714 0-146.285714-146.285714l0-731.428572q0-146.285714 146.285714-146.285714Z" fill="#FFFFFF"/><path d="M834.194286 329.106286c-6.948571-3.401143-9.947429 3.072-14.006857 6.326857-1.426286 1.024-2.56 2.413714-3.766858 3.657143-10.24 10.788571-22.089143 17.846857-37.668571 17.005714-22.710857-1.28-42.166857 5.814857-59.318857 23.003429-3.657143-21.211429-15.725714-33.865143-34.230857-41.984-9.654857-4.205714-19.382857-8.411429-26.148572-17.627429-4.754286-6.546286-5.997714-13.824-8.338285-20.955429-1.536-4.352-2.998857-8.777143-8.045715-9.508571-5.485714-0.841143-7.643429 3.693714-9.801143 7.497143-8.594286 15.506286-11.885714 32.548571-11.556571 49.883428 0.731429 38.948571 17.334857 69.888 50.395429 91.940572 3.730286 2.56 4.754286 5.083429 3.547428 8.777143-2.267429 7.570286-4.937143 14.994286-7.314286 22.564571-1.462857 4.864-3.730286 5.924571-8.996571 3.803429a151.881143 151.881143 0 0 1-47.652571-31.963429c-23.478857-22.491429-44.726857-47.250286-71.204572-66.669714a316.233143 316.233143 0 0 0-18.870857-12.763429c-27.062857-25.965714 3.510857-47.213714 10.605714-49.773714 7.387429-2.633143 2.56-11.702857-21.357714-11.593143-23.917714 0.109714-45.824 8.045714-73.691429 18.578286-4.132571 1.536-8.411429 2.779429-12.763428 3.657143a266.422857 266.422857 0 0 0-79.067429-2.742857c-51.712 5.705143-92.964571 29.842286-123.392 71.094857-36.461714 49.554286-45.056 105.910857-34.486857 164.644571 10.971429 61.915429 43.008 113.152 92.16 153.234286 50.907429 41.581714 109.568 61.915429 176.530286 58.002286 40.667429-2.304 85.942857-7.68 136.996571-50.432 12.836571 6.363429 26.368 8.886857 48.786286 10.788571 17.298286 1.609143 33.938286-0.841143 46.811429-3.510857 20.114286-4.169143 18.761143-22.674286 11.483428-26.002286-59.136-27.245714-46.153143-16.164571-57.929143-25.124571 29.988571-35.108571 75.300571-71.606857 92.964572-189.842286 1.426286-9.398857 0.219429-15.286857 0-22.893714-0.109714-4.608 0.987429-6.4 6.363428-6.948572 14.848-1.536 29.257143-5.888 42.349715-12.873143 38.326857-20.662857 53.76-54.637714 57.417142-95.341714 0.548571-6.217143-0.109714-12.653714-6.765714-15.945143z m-333.677715 366.409143c-57.307429-44.544-85.065143-59.245714-96.548571-58.587429-10.752 0.658286-8.813714 12.8-6.473143 20.699429 2.450286 7.826286 5.668571 13.165714 10.24 20.041142 3.072 4.534857 5.229714 11.264-3.181714 16.347429-18.432 11.300571-50.468571-3.803429-51.968-4.534857-37.376-21.686857-68.571429-50.432-90.550857-89.673143a271.36 271.36 0 0 1-35.620572-121.453714c-0.548571-10.459429 2.56-14.153143 13.056-16.091429a130.450286 130.450286 0 0 1 41.947429-1.024c58.514286 8.448 108.251429 34.267429 150.016 75.190857 23.771429 23.296 41.801143 51.2 60.342857 78.372572 19.748571 28.891429 40.996571 56.429714 68.022857 78.994285 9.581714 7.899429 17.152 13.933714 24.502857 18.358858-22.016 2.413714-58.697143 2.925714-83.785143-16.676572z m27.428572-174.592c0-5.705143 5.851429-9.728 11.373714-7.789715a8.265143 8.265143 0 0 1 1.024 15.177143 8.777143 8.777143 0 0 1-7.277714 0.292572 8.192 8.192 0 0 1-5.12-7.68z m85.284571 43.264c-5.12 2.340571-10.605714 3.803429-16.201143 4.315428a34.450286 34.450286 0 0 1-21.869714-6.838857c-7.497143-6.217143-12.873143-9.728-15.140571-20.553143a46.811429 46.811429 0 0 1 0.438857-15.981714c1.938286-8.850286-0.219429-14.518857-6.582857-19.675429-5.12-4.205714-11.702857-5.412571-18.870857-5.412571a15.286743 15.286743 0 0 1-9.289143-3.803429 6.656 6.656 0 0 1-1.645715-5.302857 6.619429 6.619429 0 0 1 0.877715-2.706286 30.354286 30.354286 0 0 1 5.302857-5.668571c9.728-5.485714 20.992-3.693714 31.414857 0.402286 9.618286 3.913143 16.896 11.081143 27.428571 21.211428 10.752 12.214857 12.690286 15.616 18.797715 24.795429 4.827429 7.131429 9.216 14.555429 12.178285 22.966857 1.828571 5.266286-0.512 9.581714-6.802285 12.251429z" fill="#4D6BFE"/></svg>`
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
