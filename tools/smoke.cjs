#!/usr/bin/env node
/**
 * smoke.cjs —— 无头冒烟测试（不开任何可见窗口）
 *
 * 做法：起一个本机静态服务 + Chrome --headless=new，用 CDP 的 Runtime.evaluate
 * 驱动真实 DOM，逐条断言。全程 headless，不会在你正在用的屏幕上弹窗。
 *
 * 前置：先跑 npm run build，确保 www/ 存在且最新。
 * 用法：node tools/smoke.cjs
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const PORT = 5181;
// 每轮换一个调试端口：万一上一轮的浏览器没杀干净，新进程也不会连到它、
// 读到旧 profile 的 localStorage（那会让数据翻倍，测试结果不可信）。
const CDP_PORT = 9300 + Math.floor(Math.random() * 600);
const URL = `http://127.0.0.1:${PORT}/`;

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const children = [];
let profileDir = '';

/**
 * 同步清理。process.exit 之后异步 spawn 的 taskkill 跑不完，
 * 残留的无头 Chrome 会一直留在后台，所以这里全部用同步调用。
 * 除了杀自己 spawn 的 pid，还按临时 profile 路径兜底扫一遍——
 * Chrome 在 Windows 上可能把浏览器进程“转生”成另一个 pid，只杀 pid 抓不全。
 */
function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(c.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
      } else {
        c.kill('SIGKILL');
      }
    } catch {}
  }
  if (profileDir && process.platform === 'win32') {
    try {
      const ps =
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${profileDir.replace(/'/g, "''")}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {}
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个地址能返回 2xx（不解析内容） */
async function waitUp(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        await r.text();
        return true;
      }
      lastErr = 'status ' + r.status;
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    await sleep(200);
  }
  throw new Error('等待超时：' + url + '（最后错误：' + lastErr + '）');
}

/** 等某个地址返回可解析的 JSON（CDP 端点） */
async function waitJson(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      lastErr = 'status ' + r.status;
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    await sleep(200);
  }
  throw new Error('等待超时：' + url + '（最后错误：' + lastErr + '）');
}

async function main() {
  if (!fs.existsSync(path.join(WWW, 'index.html'))) {
    console.error('www/ 不存在，请先运行 npm run build');
    process.exit(1);
  }

  const chrome = CHROMES.find((p) => fs.existsSync(p));
  if (!chrome) {
    console.error('未找到 Chrome/Edge');
    process.exit(1);
  }

  // 1. 静态服务
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.cjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(String(d)));
  server.stderr.on('data', (d) => process.stderr.write(String(d)));
  server.on('error', (e) => console.error('静态服务启动失败：' + e.message));
  children.push(server);
  await waitUp(URL, 6000);

  // 2. 无头浏览器（独立临时 profile，不影响你日常的 Chrome）
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-smoke-'));
  profileDir = profile;
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,OptimizationHints',
      '--window-size=420,900',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  children.push(browser);

  await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);

  const target = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' })
  ).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP 连接失败'));
  });

  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };

  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: URL });
  await sleep(1200);

  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  // 等应用初始化
  const ready = await evaluate(`(async()=>{for(let i=0;i<50;i++){if(window.__sqReady)return true;await new Promise(r=>setTimeout(r,100))}return false})()`);
  if (!ready) throw new Error('应用未初始化（__sqReady 未置位）');

  const results = [];
  const check = async (name, fn) => {
    try {
      const v = await fn();
      results.push({ name, ok: v === true || v === undefined, detail: v });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  };

  await check('版本号存在', async () => {
    const v = await evaluate('window.__sq.version');
    return v === '0.1.0' ? true : '版本=' + v;
  });

  await check('内容库 60 条', async () => {
    const v = await evaluate('window.__sq.guidesCount()');
    return v === 60 ? true : '条数=' + v;
  });

  await check('分类 10 类', async () => {
    const v = await evaluate('window.__sq.categories.length');
    return v === 10 ? true : '类数=' + v;
  });

  await check('今日清单非空', async () => {
    const v = await evaluate('window.__sq.todayCount()');
    return v >= 1 ? true : '条数=' + v;
  });

  await check('今日页渲染出卡片', async () => {
    const v = await evaluate(`document.querySelectorAll('#today-list .gcard').length`);
    return v >= 1 ? true : '卡片=' + v;
  });

  await check('切换到攻略页', async () => {
    await evaluate(`document.querySelector('#tabbar .tab[data-tab="library"]').click()`);
    await sleep(200);
    const v = await evaluate(
      `!document.getElementById('page-library').hidden && document.querySelectorAll('#lib-list .gcard').length`
    );
    return typeof v === 'number' && v === 60 ? true : '卡片=' + v;
  });

  await check('分类筛选生效', async () => {
    const v = await evaluate(`(()=>{
      const chips=[...document.querySelectorAll('#cat-chips .chip')];
      const c=chips.find(x=>x.textContent==='出行');
      c.click();
      return {n:document.querySelectorAll('#lib-list .gcard').length, active:document.querySelectorAll('#cat-chips .chip.active').length};
    })()`);
    if (v.n !== 6 || v.active !== 1) return JSON.stringify(v);
    await evaluate(`document.querySelector('#cat-chips .chip').click()`);
    return true;
  });

  await check('搜索过滤生效', async () => {
    const v = await evaluate(`(()=>{
      const s=document.getElementById('search');
      s.value='周三';
      s.dispatchEvent(new Event('input',{bubbles:true}));
      return document.querySelectorAll('#lib-list .gcard').length;
    })()`);
    await evaluate(`(()=>{const s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    return v >= 1 && v < 60 ? true : '命中=' + v;
  });

  const firstId = await evaluate(`document.querySelector('#lib-list .gcard').dataset.id`);

  await check('打开详情抽屉', async () => {
    await evaluate(`document.querySelector('#lib-list .gcard').click()`);
    await sleep(220);
    const v = await evaluate(
      `!document.getElementById('sheet-mask').hidden && document.querySelector('#sheet-body .sheet-kv').children.length`
    );
    return v >= 12 ? true : '字段=' + v;
  });

  await check('详情中标为已完成', async () => {
    await evaluate(`document.querySelector('#detail-state .seg-item[data-s="done"]').click()`);
    await sleep(200);
    const v = await evaluate(`window.__sq.status(${JSON.stringify(firstId)})`);
    return v === 'done' ? true : '状态=' + v;
  });

  await check('收藏按钮可用', async () => {
    await evaluate(`document.getElementById('d-fav').click()`);
    await sleep(150);
    const v = await evaluate(`(JSON.parse(localStorage.getItem('shengqian.v1')).meta[${JSON.stringify(firstId)}]||{}).fav`);
    return v === 1 ? true : 'fav=' + v;
  });

  await check('关闭抽屉', async () => {
    await evaluate(`document.getElementById('d-ok') ? document.getElementById('d-ok').click() : document.getElementById('sheet-mask').click()`);
    await sleep(150);
    const v = await evaluate(`document.getElementById('sheet-mask').hidden`);
    return v === true ? true : '未关闭';
  });

  await check('记一笔能保存', async () => {
    await evaluate(`document.getElementById('fab-add').click()`);
    await sleep(200);
    await evaluate(`(()=>{
      document.getElementById('add-amount').value='12.5';
      document.getElementById('add-note').value='冒烟测试';
      document.getElementById('add-save').click();
    })()`);
    await sleep(200);
    const v = await evaluate(
      `({n:window.__sq.ledgerCount(), hidden:document.getElementById('add-mask').hidden})`
    );
    return v.n === 1 && v.hidden === true ? true : JSON.stringify(v);
  });

  await check('台账金额正确', async () => {
    await evaluate(`document.querySelector('#tabbar .tab[data-tab="ledger"]').click()`);
    await sleep(250);
    const v = await evaluate(
      `({m:document.getElementById('ledger-month').textContent, t:document.getElementById('ledger-total').textContent, c:document.getElementById('ledger-count').textContent})`
    );
    return v.m === '12.5' && v.t === '12.5' && v.c === '1 条' ? true : JSON.stringify(v);
  });

  await check('柱状图绘制出像素', async () => {
    const v = await evaluate(`(()=>{
      const c=document.getElementById('chart');
      const ctx=c.getContext('2d');
      const d=ctx.getImageData(0,0,c.width,c.height).data;
      let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>0) n++;
      return {w:c.width,h:c.height,px:n};
    })()`);
    return v.w > 0 && v.h > 0 && v.px > 200 ? true : JSON.stringify(v);
  });

  await check('我的页统计正确', async () => {
    await evaluate(`document.querySelector('#tabbar .tab[data-tab="me"]').click()`);
    await sleep(200);
    const v = await evaluate(
      `({done:document.getElementById('me-done').textContent, rec:document.getElementById('me-records').textContent, fav:document.getElementById('me-fav').textContent})`
    );
    return v.done === '1' && v.rec === '1' && v.fav === '1' ? true : JSON.stringify(v);
  });

  await check('避坑指南可打开', async () => {
    await evaluate(`document.getElementById('menu-avoid').click()`);
    await sleep(200);
    const v = await evaluate(
      `document.querySelectorAll('#sheet-body .sheet-block').length + '|' + !document.getElementById('sheet-mask').hidden`
    );
    await evaluate(`document.getElementById('d-ok').click()`);
    return v === '3|true' ? true : '结果=' + v;
  });

  await check('刷新后数据仍在', async () => {
    await cdp('Page.reload', { ignoreCache: true });
    await sleep(1400);
    const v = await evaluate(`(async()=>{for(let i=0;i<50;i++){if(window.__sqReady)return {n:window.__sq.ledgerCount(),s:window.__sq.status(${JSON.stringify(firstId)})};await new Promise(r=>setTimeout(r,100))}return null})()`);
    return v && v.n === 1 && v.s === 'done' ? true : JSON.stringify(v);
  });

  await check('无外链资源（完全离线）', async () => {
    const v = await evaluate(`(()=>{
      const ext=performance.getEntriesByType('resource').filter(r=>!r.name.startsWith(location.origin));
      const links=[...document.querySelectorAll('a[href^="http"]')];
      return {ext:ext.length, links:links.length};
    })()`);
    return v.ext === 0 && v.links === 0 ? true : JSON.stringify(v);
  });

  await check('无横向溢出', async () => {
    const v = await evaluate(`({sw:document.documentElement.scrollWidth, iw:window.innerWidth})`);
    return v.sw <= v.iw + 1 ? true : JSON.stringify(v);
  });

  await check('页面无 JS 报错', async () => {
    return errors.length === 0 ? true : errors.slice(0, 3).join(' | ');
  });

  // 截图留档
  try {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    const dir = path.join(ROOT, 'test-artifacts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke.png'), Buffer.from(shot.data, 'base64'));
  } catch {}

  // 让浏览器自己有序退出，比外部强杀更干净
  try {
    await cdp('Browser.close');
  } catch {}
  ws.close();

  const pass = results.filter((r) => r.ok).length;
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
  }
  console.log('');
  console.log(`SMOKE_RESULT ${pass}/${results.length} ${pass === results.length ? 'ALL_PASS' : 'HAS_FAILURE'}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟测试异常：', e.message);
  process.exit(1);
});
