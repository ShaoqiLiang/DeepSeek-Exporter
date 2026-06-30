# DeepSeek Chat Exporter

A Chrome extension to export multi-turn Q&A conversations from DeepSeek Chat.

[中文文档](README_CN.md)

## Features

- ✅ Export complete multi-turn conversations (all Q&A pairs)
- ✅ Support Markdown / JSON / HTML export formats
- ✅ Optionally include DeepThink reasoning process
- ✅ Optionally include web search results
- ✅ Auto-detect DeepSeek chat pages
- ✅ Floating export button with dropdown menu
- ✅ Cancel ongoing export process
- ✅ SPA route change detection

## Installation

### Development Mode (Unpacked)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder in this project

### CRX Package (Distribution)

```bash
# Build and package
npm run package
```

Then drag `build/deepseek-exporter.crx` into Chrome extensions page.

## Development

### Prerequisites

- Node.js >= 18
- npm >= 9

### Setup

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (auto-rebuild on changes)
npm run watch
```

### Project Structure

```
deepseek-exporter/
├── manifest.json              # Chrome Extension manifest
├── build.mjs                  # Build script (esbuild)
├── src/
│   ├── background/
│   │   └── service-worker.ts  # Background service worker
│   ├── content/
│   │   ├── index.ts           # Content script (core logic)
│   │   └── style.css          # Injected styles
│   ├── popup/
│   │   ├── popup.html         # Popup UI
│   │   └── popup.ts           # Popup logic
│   └── shared/
│       └── types.ts           # TypeScript type definitions
├── icons/                     # Extension icons
├── doc/                       # Documentation
└── dist/                      # Build output
```

## Usage

1. Install the extension
2. Open [DeepSeek Chat](https://chat.deepseek.com)
3. Click the **Export** button (top right corner)
4. Select export format (MD / JSON / HTML)
5. Optionally check "Include thinking process" or "Include search results"
6. Click the format button to download

You can also click the extension icon in the browser toolbar to open the popup panel.

## Technical Details

- **Manifest V3** Chrome Extension
- **Message Extraction**: Injects scripts into page's main world via Service Worker to extract messages from React fiber
- **Role Detection**: Identifies user/assistant messages by DOM structure (`.ds-assistant-message-main-content`)
- **Content Extraction**: 
  - Assistant messages: Extracts Markdown AST from React fiber
  - User messages: Extracts text content directly
- **SPA Route Listening**: Monitors URL changes to detect conversation switches

## Documentation

- [Build Guide](doc/build-guide.md) - How to build and package
- [CRX Packaging](doc/crx-packaging.md) - CRX packaging and key.pem explanation

## FAQ

### Export button not appearing?

- Make sure you're on `chat.deepseek.com`
- Try refreshing the page
- Check if the extension is enabled in `chrome://extensions/`

### Export is slow or incomplete?

- The extension scrolls through the conversation to load all messages
- For long conversations, this may take some time
- You can click "Cancel" to stop the export process

### CSP errors in extensions page?

This was fixed in recent versions. If you still see errors:
1. Make sure you're using the latest build (`npm run build`)
2. Reload the extension

## License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)
