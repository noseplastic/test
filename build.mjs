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

// 오버레이 창 (데스크톱 앱이 띄움. 브라우저에서는 두 번째 모니터용으로 열 수 있음)
const ov = await build({ entryPoints: ['js/overlay.js'], bundle: true, format: 'iife', minify: true, write: false });
let ovHtml = await readFile('overlay.html', 'utf8');
const coachCss = await readFile('css/coach.css', 'utf8');
ovHtml = ovHtml.replace('<link rel="stylesheet" href="css/coach.css" />', () => `<style>\n${coachCss}</style>`)
  .replace('<script type="module" src="js/overlay.js"></script>', () => `<script>\n${ov.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
if (ovHtml.includes('js/overlay.js') || ovHtml.includes('css/coach.css')) throw new Error('build: overlay inline failed');
await writeFile('dist/overlay.html', ovHtml);
console.log('dist/overlay.html');
