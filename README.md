# DeepSeek Chat Exporter

一键导出 DeepSeek 对话中的多轮问答记录。

## 功能

- ✅ 导出完整多轮对话（所有问答对）
- ✅ 支持 Markdown / JSON / HTML 三种格式
- ✅ 可选导出 DeepThink 思考过程
- ✅ 可选导出联网搜索结果
- ✅ 自动检测 DeepSeek 对话页面
- ✅ 浮动导出按钮 + 弹出面板

## 安装（本地开发模式）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目根目录（包含 `manifest.json` 的文件夹）

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 监听文件变化自动构建
npm run watch
```

## 使用方法

1. 安装插件后，打开 [DeepSeek 对话页面](https://chat.deepseek.com)
2. 页面右上角会出现 **导出** 按钮
3. 选择导出格式（MD / JSON / HTML）
4. 可勾选是否包含思考过程和搜索结果
5. 点击格式按钮，自动下载导出文件

也可以点击浏览器工具栏的插件图标，在弹出面板中选择对话并导出。

## 技术方案

- **Manifest V3** Chrome Extension
- **API 拦截**：通过注入 fetch 拦截器捕获 DeepSeek API 返回的对话数据
- **DOM 降级**：API 不可用时从页面 DOM 提取内容
- **SPA 路由监听**：自动检测对话页面切换

## 项目结构

```
├── manifest.json           # MV3 清单
├── build.mjs               # esbuild 构建脚本
├── src/
│   ├── background/
│   │   └── service-worker.ts  # API 拦截、导出逻辑
│   ├── content/
│   │   ├── index.ts           # 页面注入、DOM 解析
│   │   └── style.css          # 按钮样式
│   ├── popup/
│   │   ├── popup.html         # 弹出面板
│   │   └── popup.ts           # 面板逻辑
│   └── shared/
│       └── types.ts           # 类型定义
└── dist/                      # 构建输出
```

## 注意事项

- 插件需要在 DeepSeek 对话页面上使用
- 首次使用需先浏览对话，让插件拦截到 API 数据
- 如果导出按钮未出现，请刷新页面
