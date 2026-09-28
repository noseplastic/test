// 데스크톱 실행파일용 Electron 진입점. dist/valo-aim-trainer.html 을 창으로 띄운다.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');

// 에임 트레이너는 프레임 제한이 없을수록 입력 지연이 줄어든다
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-vsync');

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#0f1419',
    title: '발로 에임 트레이너',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false },
  });
  win.maximize();
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // F11: 전체화면 전환
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
});

app.on('window-all-closed', () => app.quit());
