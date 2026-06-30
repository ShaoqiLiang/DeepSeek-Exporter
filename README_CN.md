# DeepSeek 对话导出

一键导出 DeepSeek 对话中的多轮问答记录。

[English](README.md)

## 功能

- ✅ 导出完整多轮对话（所有问答对）
- ✅ 支持 Markdown / JSON / HTML 三种格式
- ✅ 可选导出 DeepThink 思考过程
- ✅ 可选导出联网搜索结果
- ✅ 自动检测 DeepSeek 对话页面
- ✅ 浮动导出按钮 + 下拉菜单
- ✅ 支持取消导出过程
- ✅ SPA 路由变化检测

## 安装

### 开发模式（未打包）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目的 `dist/` 文件夹

### CRX 打包（分发）

```bash
# 构建并打包
npm run package
```

然后将 `build/deepseek-exporter.crx` 拖入 Chrome 扩展页面安装。

## 开发

### 环境要求

- Node.js >= 18
- npm >= 9

### 常用命令

```bash
# 安装依赖
npm install

# 构建
npm run build

# 监听文件变化自动构建
npm run watch

# 打包 CRX
npm run package

# 清理构建产物
npm run clean
```

### 项目结构

```
deepseek-exporter/
├── manifest.json              # Chrome 扩展清单
├── build.mjs                  # 构建脚本（esbuild）
├── src/
│   ├── background/
│   │   └── service-worker.ts  # 后台服务
│   ├── content/
│   │   ├── index.ts           # 内容脚本（核心逻辑）
│   │   └── style.css          # 注入样式
│   ├── popup/
│   │   ├── popup.html         # 弹出面板
│   │   └── popup.ts           # 面板逻辑
│   └── shared/
│       └── types.ts           # 类型定义
├── icons/                     # 扩展图标
├── doc/                       # 文档
└── dist/                      # 构建输出
```

## 使用方法

1. 安装插件后，打开 [DeepSeek 对话页面](https://chat.deepseek.com)
2. 页面右上角会出现 **导出** 按钮
3. 选择导出格式（MD / JSON / HTML）
4. 可勾选是否包含思考过程和搜索结果
5. 点击格式按钮，自动下载导出文件

也可以点击浏览器工具栏的插件图标，在弹出面板中选择对话并导出。

### 取消导出

导出过程中，如果需要取消：
1. 点击导出菜单中的 **取消导出** 按钮
2. 等待取消完成（通常 < 100ms）

## 技术方案

- **Manifest V3** Chrome 扩展
- **消息提取**：通过 Service Worker 注入脚本到页面主世界，从 React fiber 提取消息
- **角色识别**：通过 DOM 结构识别用户/助手消息（`.ds-assistant-message-main-content`）
- **内容提取**：
  - 助手消息：从 React fiber 提取 Markdown AST
  - 用户消息：直接提取文本内容
- **SPA 路由监听**：监听 URL 变化检测对话切换

## 文档

- [构建指南](doc/build-guide.md) - 如何构建和打包
- [CRX 打包说明](doc/crx-packaging.md) - CRX 打包和 key.pem 说明

## 常见问题

### 导出按钮没有出现？

- 确保在 `chat.deepseek.com` 页面上
- 尝试刷新页面
- 检查扩展是否在 `chrome://extensions/` 中启用

### 导出很慢或不完整？

- 扩展会滚动对话以加载所有消息
- 对于长对话，可能需要一些时间
- 可以点击「取消」停止导出过程

### 扩展页面显示 CSP 错误？

此问题已在最新版本中修复。如果仍有错误：
1. 确保使用最新构建（`npm run build`）
2. 重新加载扩展

## 许可证

[GNU Affero 通用公共许可证 v3.0 (AGPL-3.0)](LICENSE)
