// Windows 실행파일 만들기: npm run build:win
// → desktop/out/ValoAimTrainer-win32-x64/ValoAimTrainer.exe (+ zip)
import { packager } from '@electron/packager';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const ELECTRON_VERSION = '33.2.1';

await mkdir('desktop/app', { recursive: true });
await copyFile('dist/valo-aim-trainer.html', 'desktop/app/index.html');
await copyFile('dist/overlay.html', 'desktop/app/overlay.html');
await rm('desktop/out', { recursive: true, force: true });

const [outDir] = await packager({
  dir: 'desktop',
  out: 'desktop/out',
  platform: 'win32',
  arch: 'x64',
  electronVersion: ELECTRON_VERSION,
  name: 'ValoAimTrainer',
  appVersion: '0.1.0',
  asar: true,
  overwrite: true,
  ignore: [/^\/out($|\/)/, /^\/build-win\.mjs$/],
  win32metadata: {
    ProductName: 'ValoAimTrainer',
    FileDescription: 'Valo Aim Trainer',
    CompanyName: 'personal',
  },
});
console.log(outDir);

try {
  execFileSync('zip', ['-qr', 'ValoAimTrainer-win-x64.zip', 'ValoAimTrainer-win32-x64'], { cwd: 'desktop/out' });
  console.log('desktop/out/ValoAimTrainer-win-x64.zip');
} catch {
  console.log('zip 명령이 없어 압축은 건너뜀');
}
