import * as esbuild from 'esbuild'
import { cpSync } from 'fs'

const watch = process.argv.includes('--watch')

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
}
