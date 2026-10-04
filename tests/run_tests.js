import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

let chromeProcess;
// Debian の chromium ランチャーは exec しない場合があるので、プロセスグループごと終了させる
function stopChrome() {
  if (!chromeProcess) return;
  try { process.kill(-chromeProcess.pid, 'SIGTERM'); } catch (e) {}
  chromeProcess = null;
}
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      const results = JSON.parse(body);
      console.log("\n================ BLINK WEBAUDIO TEST RESULTS ================");
      let allPass = true;
      for (const t of results) {
        const mark = t.pass ? "PASS" : "FAIL";
        console.log(`[${mark}] ${t.name} -> ${t.details}`);
        if (!t.pass) allPass = false;
      }
      console.log("=============================================================\n");

      server.close();
      stopChrome();
      process.exit(allPass ? 0 : 1);
    });
    return;
  }

  // Serve static files
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
    else if (ext === '.json') contentType = 'application/json';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`Test server running on port ${port}... Launching Chromium...`);

  const chromeBin = fs.existsSync('/home/shinken/.local/bin/google-chrome')
    ? '/home/shinken/.local/bin/google-chrome'
    : '/usr/bin/chromium';

  chromeProcess = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    ...(process.env.DEBUG_CHROME ? ['--enable-logging=stderr', '--v=0'] : []),
    `http://127.0.0.1:${port}/tests/${process.env.TEST_PAGE || 'test_real_audio_pipeline.html'}`
  ], { detached: true, stdio: process.env.DEBUG_CHROME ? 'inherit' : 'ignore' });

  // 低速な端末 (Raspberry Pi 等) でも 20 秒音源の負荷測定まで完走できる猶予
  setTimeout(() => {
    console.error("Test timeout after 180s");
    stopChrome();
    server.close();
    process.exit(1);
  }, 180000);
});
