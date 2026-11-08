#!/usr/bin/env node
/**
 * make-icons.cjs —— 生成安卓启动图标（无头 Chrome 渲染 SVG → PNG）
 *
 * 输出：
 *   assets/icons/<size>.png                  方形旧版图标
 *   assets/icons/round-<size>.png            圆形旧版图标
 *   assets/icons/fg-<size>.png               自适应图标前景（透明底）
 * 若 android/ 已存在，同时写入 mipmap-* 并调整自适应图标底色。
 *
 * 用法：node tools/make-icons.cjs
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'icons');
const CDP_PORT = 9334;
const GOLD = '#d9a441';
const GOLD_L = '#f0c674';
const BG = '#0d0f14';
const CARD = '#171b24';

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('等待超时：' + url);
}

/** 画一个日历 + 金币的主图形 */
function glyph(size, { bg, round, transparent }) {
  const S = 192; // 逻辑坐标
  const bgShape = transparent
    ? ''
    : round
      ? `<circle cx="96" cy="96" r="96" fill="${bg}"/>`
      : `<rect x="0" y="0" width="192" height="192" rx="44" fill="${bg}"/>`;

  const glow = transparent
    ? ''
    : `<circle cx="150" cy="42" r="66" fill="url(#g1)" opacity="0.55"/>`;

  // 日历主体
  const calTop = 62;
  const calW = 92;
  const calH = 84;
  const calX = 50;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 192 192">
  <defs>
    <radialGradient id="g1" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${GOLD_L}"/>
      <stop offset="100%" stop-color="${GOLD}"/>
    </linearGradient>
  </defs>
  ${bgShape}
  ${glow}

  <!-- 日历 -->
  <rect x="${calX}" y="${calTop}" width="${calW}" height="${calH}" rx="16" fill="${CARD}" stroke="${GOLD}" stroke-width="4"/>
  <path d="M${calX} ${calTop + 18} h${calW} v-2 a16 16 0 0 0 -16 -16 h-${calW - 32} a16 16 0 0 0 -16 16 z" fill="${GOLD}"/>
  <rect x="${calX + 18}" y="${calTop - 10}" width="7" height="18" rx="3.5" fill="${GOLD_L}"/>
  <rect x="${calX + calW - 25}" y="${calTop - 10}" width="7" height="18" rx="3.5" fill="${GOLD_L}"/>
  <!-- 日历上的省钱刻度 -->
  <circle cx="${calX + 26}" cy="${calTop + 42}" r="7" fill="${GOLD}" opacity="0.9"/>
  <circle cx="${calX + 46}" cy="${calTop + 42}" r="7" fill="#3a4150"/>
  <circle cx="${calX + 66}" cy="${calTop + 42}" r="7" fill="${GOLD}" opacity="0.55"/>
  <circle cx="${calX + 26}" cy="${calTop + 62}" r="7" fill="#3a4150"/>
  <circle cx="${calX + 46}" cy="${calTop + 62}" r="7" fill="${GOLD}" opacity="0.9"/>
  <circle cx="${calX + 66}" cy="${calTop + 62}" r="7" fill="#3a4150"/>

  <!-- 金币 -->
  <circle cx="136" cy="140" r="26" fill="url(#g2)" stroke="#8a6a2a" stroke-width="3"/>
  <text x="136" y="150" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="bold" fill="#2a1e0a">¥</text>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = CHROMES.find((p) => fs.existsSync(p));
  if (!chrome) {
    console.error('未找到 Chrome/Edge');
    process.exit(1);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-icon-'));
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  // 同步杀，否则脚本退出后无头浏览器会留在后台占着调试端口
  const kill = () => {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(browser.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
        const ps =
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        browser.kill('SIGKILL');
      }
    } catch {}
  };
  process.on('exit', kill);
  process.on('SIGINT', () => process.exit(130));

  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);
    const target = await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    ).json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP 连接失败'));
    });

    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    const cdp = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    const shot = async (svg, size, file) => {
      await cdp('Emulation.setDeviceMetricsOverride', {
        width: size,
        height: size,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;
      const doc = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
      await cdp('Page.navigate', { url: doc });
      await sleep(260);
      const r = await cdp('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
        captureBeyondViewport: false,
      });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return Buffer.from(r.data, 'base64');
    };

    // 旧版方形/圆形图标尺寸
    const legacy = [
      ['mdpi', 48],
      ['hdpi', 72],
      ['xhdpi', 96],
      ['xxhdpi', 144],
      ['xxxhdpi', 192],
    ];
    // 自适应前景 108dp
    const fg = [
      ['mdpi', 108],
      ['hdpi', 162],
      ['xhdpi', 216],
      ['xxhdpi', 324],
      ['xxxhdpi', 432],
    ];

    for (const [d, px] of legacy) {
      await shot(glyph(px, { bg: BG, round: false, transparent: false }), px, path.join(OUT, `${d}.png`));
      await shot(glyph(px, { bg: BG, round: true, transparent: false }), px, path.join(OUT, `round-${d}.png`));
    }
    for (const [d, px] of fg) {
      await shot(glyph(px, { bg: BG, round: false, transparent: true }), px, path.join(OUT, `fg-${d}.png`));
    }
    ws.close();

    console.log('图标已生成到 assets/icons');
    for (const f of fs.readdirSync(OUT).sort()) console.log('   ', f);

    // 若已有安卓工程，直接铺进去
    const res = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
    if (fs.existsSync(res)) {
      for (const [d] of legacy) {
        const dir = path.join(res, `mipmap-${d}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(OUT, `${d}.png`), path.join(dir, 'ic_launcher.png'));
        fs.copyFileSync(path.join(OUT, `round-${d}.png`), path.join(dir, 'ic_launcher_round.png'));
      }
      for (const [d] of fg) {
        const dir = path.join(res, `mipmap-${d}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(OUT, `fg-${d}.png`), path.join(dir, 'ic_launcher_foreground.png'));
      }
      const values = path.join(res, 'values');
      fs.mkdirSync(values, { recursive: true });
      fs.writeFileSync(
        path.join(values, 'ic_launcher_background.xml'),
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0d0f14</color>\n</resources>\n'
      );
      console.log('已写入 android/app/src/main/res/mipmap-*（含自适应前景）');
    } else {
      console.log('android/ 还不存在，先跑 npx cap add android 再重跑本脚本即可自动铺图标');
    }
  } finally {
    kill();
  }
}

main().catch((e) => {
  console.error('生成图标失败：', e.message);
  process.exit(1);
});
