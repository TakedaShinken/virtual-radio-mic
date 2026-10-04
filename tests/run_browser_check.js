import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 実際の index.html を偽マイク付きのヘッドレス Chromium で動かすエンドツーエンド検証
// SCREENSHOT_PATH を指定すると、検証後にスマホ幅の画面写真も保存する
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const screenshotPath = process.env.SCREENSHOT_PATH || '';

const chromeBin = fs.existsSync('/home/shinken/.local/bin/google-chrome')
  ? '/home/shinken/.local/bin/google-chrome'
  : '/usr/bin/chromium';

let chromeProcess;
// Debian の chromium ランチャーは exec しない場合があるので、プロセスグループごと終了させる
function stopChrome() {
  if (!chromeProcess) return;
  try { process.kill(-chromeProcess.pid, 'SIGTERM'); } catch (e) {}
  chromeProcess = null;
}

function serveStatic(req, res) {
  let safePath = path.normalize(req.url.split('?')[0]);
  if (safePath === '/') safePath = '/index.html';
  const filePath = path.join(rootDir, safePath);

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    let contentType = 'text/plain';
    if (ext === '.html') contentType = 'text/html';
    else if (ext === '.js') contentType = 'application/javascript';
    else if (ext === '.css') contentType = 'text/css';
    else if (ext === '.json' || ext === '.webmanifest') contentType = 'application/json';
    else if (ext === '.svg') contentType = 'image/svg+xml';
    else if (ext === '.png') contentType = 'image/png';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      const data = JSON.parse(body);

      console.log("\n================ BROWSER INTERACTION TEST RESULTS ================");
      if (data.error) {
        console.error("Test Error:", data.error);
        stopChrome();
        process.exit(1);
      }

      let allPass = true;
      for (const t of data.testResults) {
        const mark = t.pass ? "PASS" : "FAIL";
        console.log(`[${mark}] ${t.name}`);
        if (!t.pass) allPass = false;
      }
      console.log(`Total Icons Rendered: ${data.iconsCount}`);
      console.log(`Default Channel Mode: ${data.channelMode}`);
      console.log(`Voice Focus Status: ${data.voiceFocusStatus}`);
      console.log("===================================================================\n");

      server.close();
      stopChrome();

      if (screenshotPath) {
        captureScreenshot(allPass);
      } else {
        process.exit(allPass ? 0 : 1);
      }
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`Browser test server running on port ${port}... Launching Chromium...`);

  chromeProcess = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `http://127.0.0.1:${port}/tests/verify_in_browser.html`
  ], { detached: true, stdio: 'ignore' });

  setTimeout(() => {
    console.error("Browser test timeout after 90s");
    stopChrome();
    server.close();
    process.exit(1);
  }, 90000);
});

function captureScreenshot(allPass) {
  const ssServer = http.createServer(serveStatic);
  ssServer.listen(0, '127.0.0.1', () => {
    const port = ssServer.address().port;
    console.log(`Capturing browser view to ${screenshotPath}...`);
    const p = spawn(chromeBin, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=430,932',
      `--screenshot=${screenshotPath}`,
      `http://127.0.0.1:${port}/index.html`
    ], { stdio: 'ignore' });

    p.on('exit', (code) => {
      console.log(`Screenshot capture exited with code ${code}`);
      ssServer.close();
      process.exit(allPass ? 0 : 1);
    });
  });
}
