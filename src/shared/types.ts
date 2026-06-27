// DeepSeek API 返回的消息结构
export interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  // DeepSeek 特有字段
  thinking_content?: string    // DeepThink 思考过程
  search_results?: SearchResult[]  // 联网搜索结果
  message_id?: string
  parent_id?: string
  model?: string
  timestamp?: number
}

export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

// 对话元信息
export interface ConversationMeta {
  chat_id: string
  title: string
  model?: string
  created_at?: number
  message_count?: number
}

// 导出选项
export interface ExportOptions {
  format: 'markdown' | 'json' | 'html'
  includeThinking: boolean     // 是否包含 DeepThink 思考过程
  includeSearchResults: boolean // 是否包含联网搜索结果
}

// 消息通信类型
export type MessageType =
  | 'CONVERSATION_DATA'      // background → content/popup，返回对话数据
  | 'REQUEST_EXPORT'         // content → background，请求导出
  | 'GET_CONVERSATION_LIST'  // popup → background，获取已捕获的对话列表
  | 'CONVERSATION_LIST'      // background → popup，返回对话列表

export interface Message {
  type: MessageType
  payload?: any
}

// Content script 注入的导出请求
export interface ExportRequest {
  chatId: string
  options: ExportOptions
}
