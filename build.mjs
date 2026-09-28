// 설치 없이 더블클릭으로 실행되는 단일 HTML 파일 만들기: npm run build → dist/valo-aim-trainer.html
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const result = await build({
  entryPoints: ['js/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  alias: { three: './vendor/three.module.min.js' },
  legalComments: 'inline',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await readFile('css/style.css', 'utf8');
let html = await readFile('index.html', 'utf8');

const replaceOnce = (pattern, value) => {
  if (!pattern.test(html)) throw new Error(`build: pattern not found ${pattern}`);
  html = html.replace(pattern, () => value);
};
replaceOnce(/<link rel="stylesheet" href="css\/style\.css" \/>/, `<style>\n${css}</style>`);
replaceOnce(/\s*<script type="importmap">[\s\S]*?<\/script>/, '');
replaceOnce(/<script type="module" src="js\/main\.js"><\/script>/, `<script>\n${js}</script>`);

await mkdir('dist', { recursive: true });
await writeFile('dist/valo-aim-trainer.html', html);
console.log(`dist/valo-aim-trainer.html (${Math.round(html.length / 1024)} KB)`);
