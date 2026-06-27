import * as esbuild from 'esbuild'
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { generateKeyPairSync } from 'crypto'

const watch = process.argv.includes('--watch')
const pack = process.argv.includes('--package')

const buildOptions = {
  entryPoints: [
    'src/background/service-worker.ts',
    'src/content/index.ts',
    'src/popup/popup.ts',
  ],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome110',
  sourcemap: true,
}

if (watch) {
  const ctx = await esbuild.context(buildOptions)
  await ctx.watch()
  console.log('Watching for changes...')
} else {
  await esbuild.build(buildOptions)

  // 复制静态文件
  cpSync('src/popup/popup.html', 'dist/popup/popup.html')
  cpSync('src/content/style.css', 'dist/content/style.css')

  console.log('Build complete!')

  if (pack) {
    await packageExtension()
  }
}

async function packageExtension() {
  const CRX = (await import('crx')).default

  const rootDir = process.cwd()
  const distDir = join(rootDir, 'dist')
  const keyPath = join(rootDir, 'key.pem')

  // 如果没有私钥文件，生成一个
  if (!existsSync(keyPath)) {
    console.log('Generating new private key...')
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    writeFileSync(keyPath, privateKey)
    console.log('Private key saved to key.pem')
  }

  const privateKey = readFileSync(keyPath)

  // 准备打包内容 - 将 manifest 和资源复制到临时目录
  const packDir = join(rootDir, 'pack-temp')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(join(packDir, 'icons'), { recursive: true })
  mkdirSync(join(packDir, 'dist'), { recursive: true })

  // 读取 manifest 并修正路径（去掉 dist/ 前缀）
  const manifest = JSON.parse(readFileSync(join(rootDir, 'manifest.json'), 'utf-8'))
  const packManifest = {
    ...manifest,
    background: {
      ...manifest.background,
      service_worker: 'background/service-worker.js',
    },
    content_scripts: manifest.content_scripts.map(cs => ({
      ...cs,
      js: cs.js.map(p => p.replace('dist/', '')),
      css: cs.css.map(p => p.replace('dist/', '')),
    })),
    action: {
      ...manifest.action,
      default_popup: 'popup/popup.html',
    },
  }

  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(packManifest, null, 2))

  // 复制图标
  cpSync(join(rootDir, 'icons'), join(packDir, 'icons'), { recursive: true })

  // 复制构建产物
  cpSync(distDir, join(packDir, 'dist'), { recursive: true })

  // 打包 CRX
  const crx = new CRX({
    privateKey,
    rootDirectory: packDir,
  })

  const crxBuffer = await crx.pack()
  const buildDir = join(rootDir, 'build')
  mkdirSync(buildDir, { recursive: true })
  const outputPath = join(buildDir, 'deepseek-exporter.crx')
  writeFileSync(outputPath, crxBuffer)

  // 清理临时目录
  rmSync(packDir, { recursive: true, force: true })

  console.log(`CRX package created: ${outputPath}`)
}
