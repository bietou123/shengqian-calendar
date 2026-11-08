/**
 * 省钱日历 · 主程序
 * 纯前端、离线、localStorage 持久化。
 * 不含任何网络请求，不收集、不上传任何数据。
 */
import { GUIDES, CATEGORIES } from '../data/guides.js';

const APP_VERSION = '0.1.0';
const STORE_KEY = 'shengqian.v1';
const DAY = 86400000;

// ── 存储 ──────────────────────────────────────────────
function defaultState() {
  return {
    meta: {}, // id -> { fav:0|1, status:'none'|'done'|'eligible', donePeriod:'', doneCount:0 }
    ledger: [], // { id, type, amount, note, guideId, ts }
    settings: { notify: false, notifyTime: '20:00' },
    firstAt: Date.now(),
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const d = JSON.parse(raw);
    const base = defaultState();
    return {
      meta: d.meta && typeof d.meta === 'object' ? d.meta : base.meta,
      ledger: Array.isArray(d.ledger) ? d.ledger : base.ledger,
      settings: { ...base.settings, ...(d.settings || {}) },
      firstAt: d.firstAt || base.firstAt,
    };
  } catch {
    return defaultState();
  }
}

let state = load();
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('本地存储不可用，数据可能无法保留');
  }
}

// ── 小工具 ────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function pad(n) {
  return String(n).padStart(2, '0');
}
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function weekKey(d = new Date()) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // 周一为 0
  t.setDate(t.getDate() - day);
  return dateKey(t);
}
function periodKey(g) {
  if (g.cycle === 'daily') return dateKey();
  if (g.cycle === 'weekly') return 'W' + weekKey();
  if (g.cycle === 'monthly') return 'M' + monthKey();
  return 'FOREVER';
}
function money(n) {
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function midGain(g) {
  return (g.gain.min + g.gain.max) / 2;
}
function hourlyWage(g) {
  // 少于 2 分钟也按 2 分钟算：否则"0 分钟省 20 元"会算出荒谬的时薪。
  const t = Math.max(g.cost.time, 2);
  return Math.min((midGain(g) / t) * 60, 500);
}
function isFast(g) {
  return g.cost.time <= 5 && midGain(g) >= 5;
}
function daysToExpire(g) {
  if (!g.expiresAt || g.expiresAt === '长期') return Infinity;
  const t = new Date(g.expiresAt + 'T23:59:59').getTime();
  if (Number.isNaN(t)) return Infinity;
  return (t - Date.now()) / DAY;
}
function isSoon(g) {
  return daysToExpire(g) <= 7;
}

function metaOf(id) {
  if (!state.meta[id]) state.meta[id] = { fav: 0, status: 'none', donePeriod: '', doneCount: 0 };
  return state.meta[id];
}
function isFav(id) {
  return !!(state.meta[id] && state.meta[id].fav);
}
function statusOf(g) {
  const m = state.meta[g.id];
  if (!m) return 'none';
  if (m.status === 'done') {
    if (g.cycle === 'once' || g.cycle === 'longterm') return 'done';
    return m.donePeriod === periodKey(g) ? 'done' : 'none';
  }
  return m.status === 'eligible' ? 'eligible' : 'none';
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1700);
}

// ── 今日清单 ──────────────────────────────────────────
function isScheduledToday(g) {
  const d = new Date();
  if (g.cycle === 'daily') return true;
  if (g.cycle === 'weekly') return g.cycleDetail && g.cycleDetail.weekday === d.getDay();
  if (g.cycle === 'monthly') {
    const day = g.cycleDetail && g.cycleDetail.dayOfMonth;
    if (!day) return false;
    if (Array.isArray(day)) return day.includes(d.getDate());
    // 每月 1 号起为「临近提醒」的宽限：当天或前 2 天之内提前看到
    return d.getDate() === day;
  }
  return false;
}

function sortToday(a, b) {
  const sa = isSoon(a) ? 2 : isFast(a) ? 1 : 0;
  const sb = isSoon(b) ? 2 : isFast(b) ? 1 : 0;
  if (sa !== sb) return sb - sa;
  return hourlyWage(b) - hourlyWage(a);
}

function buildToday() {
  const core = GUIDES.filter((g) => isScheduledToday(g) && statusOf(g) !== 'done').sort(sortToday);
  const anytime = GUIDES.filter(
    (g) => (g.cycle === 'longterm' || g.cycle === 'once') && statusOf(g) !== 'done'
  )
    .sort((a, b) => hourlyWage(b) - hourlyWage(a))
    .slice(0, 6);
  return { core, anytime };
}

function renderToday() {
  const { core, anytime } = buildToday();
  const all = core.concat(anytime);
  const total = core.reduce((s, g) => s + midGain(g), 0);
  const mins = all.reduce((s, g) => s + g.cost.time, 0);

  $('today-total').textContent = money(total);
  $('today-meta').textContent = `${core.length} 条今天可做 · 约 ${mins} 分钟`;
  $('today-count').textContent = String(core.length);

  const list = $('today-list');
  list.innerHTML = '';

  if (core.length === 0) {
    list.appendChild(el('div', 'empty', '今天没有固定周期的活动。<br>可以去「攻略」里找随时能做的。'));
  } else {
    for (const g of core) list.appendChild(renderCard(g));
  }

  if (anytime.length) {
    const head = document.createElement('div');
    head.className = 'section-head';
    head.innerHTML = '<h2>随时可做</h2><span class="section-count">按折合时薪排序</span>';
    list.appendChild(head);
    for (const g of anytime) list.appendChild(renderCard(g));
  }
}

// ── 卡片 ──────────────────────────────────────────────
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html) n.innerHTML = html;
  return n;
}

const STATE_LABEL = { none: '完成', done: '已完成', eligible: '可参与' };

function renderCard(g) {
  const st = statusOf(g);
  const card = el('div', 'gcard');
  if (st === 'done') card.classList.add('is-done');
  if (isSoon(g)) card.classList.add('is-soon');
  card.dataset.id = g.id;

  const badges = [];
  const seen = new Set();
  const pushBadge = (cls, text) => {
    if (seen.has(text)) return; // 例如 tags 里写了"快薅"，这里又自动加一次
    seen.add(text);
    badges.push(`<span class="badge${cls ? ' ' + cls : ''}">${text}</span>`);
  };
  if (isSoon(g)) {
    const d = Math.ceil(daysToExpire(g));
    pushBadge('badge-soon', d <= 0 ? '今天到期' : d + ' 天后到期');
  }
  if (isFast(g)) pushBadge('badge-hot', '快薅');
  if (g.cycle === 'weekly') pushBadge('badge-gold', '每周固定');
  if (g.cycle === 'monthly') pushBadge('badge-gold', '每月一次');
  if (g.cycle === 'once') pushBadge('', '一次性');
  if (isFav(g.id)) pushBadge('badge-gold', '已收藏');
  for (const t of g.tags || []) pushBadge('', t);

  card.innerHTML = `
    <div class="gcard-top">
      <div>
        <div class="gcard-title">${g.title}</div>
        <div class="gcard-sub">${g.category}${g.platforms && g.platforms.length ? ' · ' + g.platforms.join(' / ') : ''}</div>
      </div>
    </div>
    <div class="badges">${badges.join('')}</div>
    <div class="gcard-foot">
      <div>
        <div class="gain">${g.gain.label}</div>
        <div class="wage">约 ¥${money(hourlyWage(g))}/时 · ${g.cost.time} 分钟</div>
      </div>
      <button class="state-btn" data-state="${st}">${STATE_LABEL[st]}</button>
    </div>`;

  card.addEventListener('click', (e) => {
    const btn = e.target.closest('.state-btn');
    if (btn) {
      e.stopPropagation();
      toggleDone(g);
      return;
    }
    openDetail(g.id);
  });

  return card;
}

function toggleDone(g) {
  const m = metaOf(g.id);
  if (statusOf(g) === 'done') {
    m.status = 'none';
    m.donePeriod = '';
  } else {
    m.status = 'done';
    m.donePeriod = periodKey(g);
    m.doneCount = (m.doneCount || 0) + 1;
    toast('已标记完成 · 别忘了记一笔');
  }
  save();
  refreshAll();
}

// ── 攻略库 ────────────────────────────────────────────
const lib = { cat: '全部', q: '', wage: false, fast: false, low: false, fav: false };

function renderChips() {
  const box = $('cat-chips');
  box.innerHTML = '';
  for (const c of ['全部', ...CATEGORIES]) {
    const b = el('button', 'chip' + (lib.cat === c ? ' active' : ''), c);
    b.addEventListener('click', () => {
      lib.cat = c;
      renderChips();
      renderLibrary();
    });
    box.appendChild(b);
  }
}

function filteredGuides() {
  const q = lib.q.trim().toLowerCase();
  let arr = GUIDES.filter((g) => {
    if (lib.cat !== '全部' && g.category !== lib.cat) return false;
    if (lib.fav && !isFav(g.id)) return false;
    if (lib.fast && !isFast(g)) return false;
    if (lib.low && (g.requirement || []).length) return false;
    if (q) {
      const hay = [g.title, g.category, ...(g.platforms || []), ...(g.tags || []), ...(g.steps || [])]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (lib.wage) arr = arr.slice().sort((a, b) => hourlyWage(b) - hourlyWage(a));
  else {
    arr = arr.slice().sort((a, b) => {
      const da = statusOf(a) === 'done' ? 1 : 0;
      const db = statusOf(b) === 'done' ? 1 : 0;
      return da - db;
    });
  }
  return arr;
}

function renderLibrary() {
  const arr = filteredGuides();
  $('lib-count').textContent = `${arr.length} 条`;
  const box = $('lib-list');
  box.innerHTML = '';
  if (!arr.length) {
    box.appendChild(el('div', 'empty', '没有匹配的攻略。<br>换个关键词或清掉筛选试试。'));
    return;
  }
  for (const g of arr) box.appendChild(renderCard(g));
}

// ── 详情抽屉 ──────────────────────────────────────────
let currentGuide = null;

function openDetail(id) {
  const g = GUIDES.find((x) => x.id === id);
  if (!g) return;
  currentGuide = g;
  const st = statusOf(g);
  const cyc = { daily: '每天', weekly: '每周', monthly: '每月', once: '一次性', longterm: '长期有效' }[g.cycle];

  const steps = (g.steps || []).map((s) => `<li>${s}</li>`).join('');
  const risks = (g.risks || []).map((s) => `<li>${s}</li>`).join('');
  const req = (g.requirement || ['无']).join('、');

  $('sheet-body').innerHTML = `
    <h2>${g.title}</h2>
    <div class="sheet-meta">${g.category} · ${cyc}${g.platforms && g.platforms.length ? ' · ' + g.platforms.join(' / ') : ''}</div>
    <div class="sheet-block">
      <dl class="sheet-kv">
        <dt>预计收益</dt><dd>${g.gain.label}（区间预估）</dd>
        <dt>耗时</dt><dd>约 ${g.cost.time} 分钟</dd>
        <dt>折合时薪</dt><dd>约 ¥${money(hourlyWage(g))}/时</dd>
        <dt>前置条件</dt><dd>${req}</dd>
        <dt>核对时间</dt><dd>${g.verifiedAt}</dd>
        <dt>有效期</dt><dd>${g.expiresAt === '长期' ? '长期（以平台当期规则为准）' : g.expiresAt}</dd>
      </dl>
    </div>
    <div class="sheet-block">
      <h4>怎么做</h4><ol>${steps}</ol>
    </div>
    <div class="sheet-block">
      <h4>注意事项</h4><ul>${risks}</ul>
    </div>
    <div class="sheet-block">
      <h4>我的状态</h4>
      <div class="seg" id="detail-state">
        <button class="seg-item ${st === 'none' ? 'active' : ''}" data-s="none">未参与</button>
        <button class="seg-item ${st === 'eligible' ? 'active' : ''}" data-s="eligible">可参与</button>
        <button class="seg-item ${st === 'done' ? 'active' : ''}" data-s="done">已完成</button>
      </div>
    </div>`;

  $('sheet-actions').innerHTML = `
    <button class="btn ghost" id="d-fav">${isFav(g.id) ? '取消收藏' : '收藏'}</button>
    <button class="btn primary" id="d-add">省了钱，记一笔</button>`;

  $('detail-state').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-item');
    if (!b) return;
    const m = metaOf(g.id);
    const s = b.dataset.s;
    if (s === 'done' && statusOf(g) !== 'done') {
      m.doneCount = (m.doneCount || 0) + 1;
      m.donePeriod = periodKey(g);
    }
    m.status = s;
    if (s !== 'done') m.donePeriod = '';
    save();
    openDetail(g.id);
    refreshAll();
  });

  $('d-fav').addEventListener('click', () => {
    const m = metaOf(g.id);
    m.fav = m.fav ? 0 : 1;
    save();
    toast(m.fav ? '已收藏' : '已取消收藏');
    openDetail(g.id);
    refreshAll();
  });

  $('d-add').addEventListener('click', () => {
    closeSheet();
    openAdd(g.id, midGain(g));
  });

  $('sheet-mask').hidden = false;
}

function openGuidePage(html, title) {
  $('sheet-body').innerHTML = `<h2>${title}</h2>${html}`;
  $('sheet-actions').innerHTML = '<button class="btn primary" id="d-ok">知道了</button>';
  $('d-ok').addEventListener('click', closeSheet);
  $('sheet-mask').hidden = false;
}

function closeSheet() {
  $('sheet-mask').hidden = true;
  currentGuide = null;
}

// ── 应用内对话框 ──────────────────────────────────────
// 不用 window.confirm / prompt：WebView 里它们是白底英文按钮，和暗色界面冲突。
let askResolve = null;

function askSettle(value) {
  const resolve = askResolve;
  askResolve = null;
  $('ask-mask').hidden = true;
  if (resolve) resolve(value);
}

// 返回 true（确定）或 false（取消）
function askConfirm({ title, body, okText = '确定', cancelText = '取消', okClass = 'primary' }) {
  return new Promise((resolve) => {
    askResolve = resolve;
    $('ask-title').textContent = title;
    $('ask-body').textContent = body || '';
    $('ask-body').hidden = !body;
    $('ask-time-field').hidden = true;
    const box = $('ask-actions');
    box.innerHTML = '';
    const cancel = el('button', 'btn ghost', cancelText);
    const ok = el('button', 'btn ' + okClass, okText);
    cancel.addEventListener('click', () => askSettle(false));
    ok.addEventListener('click', () => askSettle(true));
    box.appendChild(cancel);
    box.appendChild(ok);
    $('ask-mask').hidden = false;
  });
}

// 返回 'HH:MM' 或 null（取消）
// 用两个下拉而不是 input[type=time]：后者的显示格式跟随系统语言，
// 英文系统会显示成 "8:00 PM"，和中文界面不一致。
const MIN_STEP = 5;

function fillTimeSelects(hh, mm) {
  const hSel = $('ask-hour');
  const mSel = $('ask-min');
  const hOpts = [];
  for (let h = 0; h < 24; h++) {
    const v = String(h).padStart(2, '0');
    hOpts.push(`<option value="${v}">${v}</option>`);
  }
  const mOpts = [];
  for (let m = 0; m < 60; m += MIN_STEP) {
    const v = String(m).padStart(2, '0');
    mOpts.push(`<option value="${v}">${v}</option>`);
  }
  hSel.innerHTML = hOpts.join('');
  mSel.innerHTML = mOpts.join('');
  hSel.value = hh;
  mSel.value = String(Math.floor(mm / MIN_STEP) * MIN_STEP).padStart(2, '0');
}

function askTime({ title, body, value = '20:00', okText = '开启' }) {
  return new Promise((resolve) => {
    askResolve = resolve;
    $('ask-title').textContent = title;
    $('ask-body').textContent = body || '';
    $('ask-body').hidden = !body;
    $('ask-time-field').hidden = false;
    const [hh = '20', mm = '00'] = String(value).split(':');
    fillTimeSelects(hh.padStart(2, '0'), Number(mm) || 0);
    const box = $('ask-actions');
    box.innerHTML = '';
    const cancel = el('button', 'btn ghost', '取消');
    const ok = el('button', 'btn primary', okText);
    cancel.addEventListener('click', () => askSettle(null));
    ok.addEventListener('click', () => {
      askSettle($('ask-hour').value + ':' + $('ask-min').value);
    });
    box.appendChild(cancel);
    box.appendChild(ok);
    $('ask-mask').hidden = false;
  });
}

// ── 记一笔 ────────────────────────────────────────────
let addType = 'cash';
let addGuideId = '';

function openAdd(guideId = '', amount = 0) {
  addType = 'cash';
  addGuideId = guideId || '';
  for (const b of document.querySelectorAll('#add-type .seg-item')) {
    b.classList.toggle('active', b.dataset.type === 'cash');
  }
  $('add-amount').value = amount ? String(Math.round(amount * 10) / 10) : '';
  const g = GUIDES.find((x) => x.id === guideId);
  $('add-note').value = g ? g.title : '';
  $('add-guide').value = guideId || '';
  $('add-mask').hidden = false;
  setTimeout(() => $('add-amount').focus(), 120);
}

function fillGuideSelect() {
  const sel = $('add-guide');
  const opts = ['<option value="">不关联</option>'];
  for (const c of CATEGORIES) {
    const items = GUIDES.filter((g) => g.category === c);
    if (!items.length) continue;
    opts.push(`<optgroup label="${c}">`);
    for (const g of items) opts.push(`<option value="${g.id}">${g.title}</option>`);
    opts.push('</optgroup>');
  }
  sel.innerHTML = opts.join('');
}

function saveRecord() {
  const amount = parseFloat($('add-amount').value);
  if (!(amount > 0)) {
    toast('请填写大于 0 的金额');
    return;
  }
  if (amount > 100000) {
    toast('金额过大，请确认');
    return;
  }
  state.ledger.unshift({
    id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6),
    type: addType,
    amount: Math.round(amount * 100) / 100,
    note: $('add-note').value.trim(),
    guideId: $('add-guide').value || '',
    ts: Date.now(),
  });
  save();
  $('add-mask').hidden = true;
  toast('已记录');
  refreshAll();
}

// ── 台账 ──────────────────────────────────────────────
function monthSum(prefix, items = state.ledger) {
  return items
    .filter((r) => r.type !== 'goods' && monthKey(new Date(r.ts)) === prefix)
    .reduce((s, r) => s + r.amount, 0);
}
function totalSum(items = state.ledger) {
  return items.filter((r) => r.type !== 'goods').reduce((s, r) => s + r.amount, 0);
}

function renderLedger() {
  $('ledger-month').textContent = money(monthSum(monthKey()));
  $('ledger-total').textContent = money(totalSum());
  $('ledger-count').textContent = `${state.ledger.length} 条`;

  const box = $('ledger-list');
  box.innerHTML = '';
  if (!state.ledger.length) {
    box.appendChild(el('div', 'empty', '还没有记录。<br>省到钱的时候点中间的 ＋ 记一笔。'));
    return;
  }
  for (const r of state.ledger.slice(0, 200)) {
    const g = GUIDES.find((x) => x.id === r.guideId);
    const d = new Date(r.ts);
    const typeName = { cash: '现金', discount: '抵扣券', goods: '实物' }[r.type] || '其他';
    const node = el('div', 'rec');
    node.innerHTML = `
      <div class="rec-main">
        <div class="rec-title">${r.note || (g ? g.title : typeName)}</div>
        <div class="rec-sub">${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${typeName}${g ? ' · ' + g.category : ''}</div>
      </div>
      <div class="rec-amt ${r.type === 'goods' ? 'goods' : ''}">${r.type === 'goods' ? '价值 ' : '+'}${money(r.amount)}${r.type === 'goods' ? '' : ' 元'}</div>
      <button class="rec-del" aria-label="删除">×</button>`;
    node.querySelector('.rec-del').addEventListener('click', async () => {
      const ok = await askConfirm({
        title: '删除这条记录',
        body: `将删除「${r.note || (g ? g.title : typeName)}」这条记账，无法恢复。`,
        okText: '删除',
        okClass: 'danger',
      });
      if (!ok) return;
      state.ledger = state.ledger.filter((x) => x.id !== r.id);
      save();
      refreshAll();
    });
    box.appendChild(node);
  }
}

function drawChart() {
  const c = $('chart');
  if (!c || c.offsetParent === null) return;
  const w = c.clientWidth || 320;
  const h = 150;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: monthKey(d), label: d.getMonth() + 1 + '月', value: monthSum(monthKey(d)) });
  }
  const max = Math.max(1, ...months.map((m) => m.value));
  const padL = 6;
  const padR = 6;
  const baseY = h - 24;
  const topY = 12;
  const cw = (w - padL - padR) / months.length;
  const bw = Math.min(34, cw * 0.54);

  ctx.strokeStyle = '#262c38';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, baseY + 0.5);
  ctx.lineTo(w - padR, baseY + 0.5);
  ctx.stroke();

  months.forEach((m, i) => {
    const cx = padL + cw * i + cw / 2;
    const bh = m.value > 0 ? Math.max(3, ((baseY - topY) * m.value) / max) : 0;
    const x = cx - bw / 2;
    const y = baseY - bh;

    if (bh > 0) {
      const grd = ctx.createLinearGradient(0, y, 0, baseY);
      grd.addColorStop(0, '#f0c674');
      grd.addColorStop(1, 'rgba(217,164,65,0.18)');
      ctx.fillStyle = grd;
      const r = Math.min(5, bw / 2, bh);
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + bw - r, y);
      ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
      ctx.lineTo(x + bw, baseY);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = '#6c7381';
    ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(m.label, cx, h - 7);

    if (m.value > 0) {
      ctx.fillStyle = '#d9a441';
      ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(money(m.value), cx, y - 5);
    }
  });

  if (!months.some((m) => m.value > 0)) {
    ctx.fillStyle = '#6c7381';
    ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('还没有记账，点下方 ＋ 记一笔', w / 2, (baseY + topY) / 2);
  }
}

// ── 我的 ──────────────────────────────────────────────
function renderMe() {
  const doneIds = Object.keys(state.meta).filter((k) => (state.meta[k].doneCount || 0) > 0);
  const favIds = Object.keys(state.meta).filter((k) => state.meta[k].fav);
  const days = new Set(state.ledger.map((r) => dateKey(new Date(r.ts))));
  $('me-done').textContent = String(doneIds.length);
  $('me-fav').textContent = String(favIds.length);
  $('me-records').textContent = String(state.ledger.length);
  $('me-days').textContent = String(days.size);
  $('me-since').textContent = `数据只保存在这台设备 · 起始 ${dateKey(new Date(state.firstAt))}`;
  $('notify-state').textContent = state.settings.notify ? '每天 ' + state.settings.notifyTime : '未开启';
  $('notify-state').className = state.settings.notify ? 'muted-gold' : 'muted';
}

const AVOID_HTML = `
  <div class="sheet-block">
    <h4>八种常见套路</h4>
    <ol>
      <li>先涨价再打折：所谓原价是活动前临时抬高的。</li>
      <li>券后价才是真价：显示的大字价格常是极难达成的条件价。</li>
      <li>自动续费陷阱：首月 1 元，次月原价，取消入口藏得很深。</li>
      <li>提现门槛：积分看着多，满 100 才能提，永远差一点。</li>
      <li>拉人头返利：本质是让亲友消费，收益来自关系而不是活动。</li>
      <li>押金与预付费：交钱才能享折扣，商家跑路就是全亏。</li>
      <li>假冒客服退差价：主动来电要验证码的，一律是骗子。</li>
      <li>代下单代操作：把账号给别人，等于把钱包给别人。</li>
    </ol>
  </div>
  <div class="sheet-block">
    <h4>三条黄金守则</h4>
    <ul>
      <li>省下来的钱才是钱，为了折扣而买不需要的东西是净亏损。</li>
      <li>折合时薪低于你上班时薪的玩法，不做。</li>
      <li>任何要验证码、要密码、要人脸、要代登录的，直接拒绝。</li>
    </ul>
  </div>
  <div class="sheet-block">
    <h4>被骗了怎么办</h4>
    <ul>
      <li>立刻改密码、解绑支付方式、关闭免密支付。</li>
      <li>保留聊天记录、转账截图、订单号。</li>
      <li>通过平台官方客服申诉，同时拨打 96110 反诈专线。</li>
    </ul>
  </div>`;

// ── 提醒 ──────────────────────────────────────────────
// 注意：Capacitor 的插件对象是 Proxy，直接把它当 async 函数的返回值 await 会去读
// .then 属性，而 Proxy 会把它当成插件方法 "then" 去调用，报
// "LocalNotifications.then() is not implemented on android"。所以这里包一层普通对象。
async function getNotifications() {
  try {
    const mod = await import('@capacitor/local-notifications');
    const LN = mod.LocalNotifications;
    return LN ? { LN } : null;
  } catch {
    return null;
  }
}

async function toggleNotify() {
  const got = await getNotifications();
  if (!got) {
    toast('提醒仅在安卓 App 内可用');
    return;
  }
  const LN = got.LN;
  if (state.settings.notify) {
    state.settings.notify = false;
    save();
    try {
      await LN.cancel({ notifications: [{ id: 1 }] });
    } catch {}
    renderMe();
    toast('已关闭每日提醒');
    return;
  }
  try {
    const perm = await LN.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LN.requestPermissions();
      if (req.display !== 'granted') {
        toast('未获得通知权限');
        return;
      }
    }
    const [hh, mm] = state.settings.notifyTime.split(':').map(Number);
    await LN.schedule({
      notifications: [
        {
          id: 1,
          title: '省钱日历',
          body: '看看今天有哪些能省的',
          schedule: { on: { hour: hh, minute: mm }, allowWhileIdle: true },
        },
      ],
    });
    state.settings.notify = true;
    save();
    renderMe();
    toast('已开启，每天 ' + state.settings.notifyTime + ' 提醒');
  } catch (e) {
    toast('开启失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

async function setNotifyTime() {
  const v = await askTime({
    title: '提醒时间',
    body: '每天到点提醒你今天还能做哪些省钱项。',
    value: state.settings.notifyTime,
    okText: '保存',
  });
  if (!v) return;
  state.settings.notifyTime = v;
  save();
  if (state.settings.notify) {
    // 重排通知：先取消再按新时间开启
    state.settings.notify = false;
    await toggleNotify();
  } else {
    renderMe();
    toast('已设为每天 ' + v + ' 提醒');
  }
}

// ── 导出 ──────────────────────────────────────────────
async function exportData() {
  const payload = {
    app: '省钱日历',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    meta: state.meta,
    ledger: state.ledger,
    settings: state.settings,
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请检查剪贴板权限');
    }
    document.body.removeChild(ta);
  }
}

// ── 导航 ──────────────────────────────────────────────
const PAGE_TITLE = {
  today: '今日',
  library: '攻略',
  ledger: '台账',
  me: '我的',
};

function subFor(tab) {
  const d = new Date();
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  if (tab === 'today') return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${wd}`;
  if (tab === 'library') return `共 ${GUIDES.length} 条玩法`;
  if (tab === 'ledger') return '只记录，不鼓励为省钱而消费';
  return '数据不离开这台设备';
}

function switchTab(tab) {
  for (const p of document.querySelectorAll('.page')) p.hidden = true;
  const page = $('page-' + tab);
  if (page) page.hidden = false;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  $('page-title').textContent = PAGE_TITLE[tab];
  $('page-sub').textContent = subFor(tab);
  $('main').scrollTop = 0;
  if (tab === 'today') renderToday();
  if (tab === 'library') renderLibrary();
  if (tab === 'ledger') {
    renderLedger();
    requestAnimationFrame(drawChart);
  }
  if (tab === 'me') renderMe();
}

function refreshAll() {
  renderToday();
  renderLibrary();
  renderLedger();
  renderMe();
  if (!$('page-ledger').hidden) requestAnimationFrame(drawChart);
}

// ── 初始化 ────────────────────────────────────────────
function bind() {
  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  }
  $('fab-add').addEventListener('click', () => openAdd());

  $('search').addEventListener('input', (e) => {
    lib.q = e.target.value;
    renderLibrary();
  });

  for (const b of document.querySelectorAll('.filter-btn')) {
    b.addEventListener('click', () => {
      const k = b.dataset.filter;
      lib[k] = !lib[k];
      b.classList.toggle('active', lib[k]);
      renderLibrary();
    });
  }

  $('sheet-mask').addEventListener('click', (e) => {
    if (e.target === $('sheet-mask')) closeSheet();
  });
  $('add-mask').addEventListener('click', (e) => {
    if (e.target === $('add-mask')) $('add-mask').hidden = true;
  });
  $('ask-mask').addEventListener('click', (e) => {
    if (e.target === $('ask-mask')) askSettle(null);
  });

  $('add-type').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-item');
    if (!b) return;
    addType = b.dataset.type;
    for (const x of document.querySelectorAll('#add-type .seg-item')) {
      x.classList.toggle('active', x === b);
    }
  });
  $('add-cancel').addEventListener('click', () => ($('add-mask').hidden = true));
  $('add-save').addEventListener('click', saveRecord);

  $('btn-guide').addEventListener('click', () => openGuidePage(AVOID_HTML, '避坑指南'));
  $('menu-avoid').addEventListener('click', () => openGuidePage(AVOID_HTML, '避坑指南'));
  $('menu-notify').addEventListener('click', async () => {
    if (state.settings.notify) {
      await toggleNotify();
      return;
    }
    const v = await askTime({
      title: '每日提醒',
      body: '到点提醒你今天还能做哪些省钱项，可随时关闭。',
      value: state.settings.notifyTime,
      okText: '开启提醒',
    });
    if (!v) return;
    state.settings.notifyTime = v;
    save();
    await toggleNotify();
  });
  $('menu-export').addEventListener('click', exportData);
  $('menu-clear').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: '清空本机数据',
      body: '将删除本机全部收藏、状态和记账记录，且无法恢复。',
      okText: '清空',
      okClass: 'danger',
    });
    if (!ok) return;
    state = defaultState();
    save();
    refreshAll();
    toast('已清空');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSheet();
      $('add-mask').hidden = true;
      if (askResolve) askSettle(null);
    }
  });
}

function init() {
  $('about-ver').textContent = 'v' + APP_VERSION;
  fillGuideSelect();
  renderChips();
  bind();
  switchTab('today');
  drawChart();
  // 跨天回来后自动刷新今日清单
  let lastDay = dateKey();
  setInterval(() => {
    const d = dateKey();
    if (d !== lastDay) {
      lastDay = d;
      refreshAll();
    }
  }, 60000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// 供无头冒烟测试使用的只读钩子
window.__sq = {
  version: APP_VERSION,
  guidesCount: () => GUIDES.length,
  status: (id) => {
    const g = GUIDES.find((x) => x.id === id);
    return g ? statusOf(g) : null;
  },
  todayCount: () => buildToday().core.length,
  ledgerCount: () => state.ledger.length,
  categories: CATEGORIES,
};
window.__sqReady = true;
