#!/usr/bin/env node
/**
 * cdp — 直接操作「你自己打开的浏览器标签页」
 *
 * 走 DSH 浏览器专用 profile 的 CDP 调试端口（Edge），绕开插件工具层的
 * per-task 会话模型，所以能读/点/填/截图 你正在看的那一页。
 *
 * 用法（node tools/cdp.mjs <命令> [选项]）：
 *   port                                     显示当前调试端口与浏览器版本
 *   list                                     列出浏览器里所有真实页面
 *   read   [--target X|--match 关键字] [--selector css] [--chars N] [--html]
 *   eval   [--target X|--match 关键字] --expr "js" | --expr-file 文件
 *   click  [--target X|--match 关键字] (--selector css | --text 文本) [--index N] [--js]
 *   type   [--target X|--match 关键字] --selector css (--value 文本 | --value-file 文件) [--enter] [--clear]
 *   keys   [--target X|--match 关键字] --key Enter|Tab|Escape|ArrowDown...
 *   wait   [--target X|--match 关键字] (--selector css | --text 文本) [--timeout ms]
 *   shot   [--target X|--match 关键字] --out 文件.png [--full]
 *   nav    [--target X|--match 关键字] --url https://...
 *   open   --url https://...                 新开一个标签页并返回 target id
 *   activate [--target X|--match 关键字]     把该页切到前台
 *   close  --target X                        关闭该页（浏览器级）
 *
 * 通用选项：--profile <目录>  覆盖 profile 目录（默认 DSH edge-profile）
 *          --port <端口>      跳过 DevToolsActivePort 自动探测
 *          --json             结构化输出
 *
 * target 选择：--target <完整id|id前缀|#序号>，或 --match <url/标题关键字>。
 * 都不给且只有一个候选页时才自动选中，否则列出候选让你指定（防止点错页）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_PROFILE = process.env.DSH_CDP_PROFILE
  ?? 'C:\\Users\\xianchen\\AppData\\Roaming\\dsh-desktop\\harness\\dsh-builtin-browser-host\\edge-profile';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { (opt._ ??= []).push(a); continue; }
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[key] = true;
  else { opt[key] = next; i++; }
}
const need = (k) => { if (opt[k] === undefined) fail(`缺少必需参数 --${k}`); return String(opt[k]); };
function fail(msg) { console.error('cdp: ' + msg); process.exit(2); }
function out(text) { if (!opt.json) console.log(text); }
function jsonOut(obj) { if (opt.json) console.log(JSON.stringify(obj, null, 2)); }

// ---------- 端口探测 ----------
function resolvePort() {
  if (opt.port) return Number(opt.port);
  const dir = String(opt.profile ?? DEFAULT_PROFILE);
  const pf = resolve(dir, 'DevToolsActivePort');
  if (!existsSync(pf)) fail(`找不到 ${pf}（浏览器还没用这个 profile 启动过？先点桌面上的 “DSH 工作窗”）`);
  const port = Number(readFileSync(pf, 'utf8').split('\n')[0].trim());
  if (!Number.isInteger(port) || port <= 0) fail(`${pf} 里的端口无效`);
  return port;
}

// ---------- 极简 CDP 客户端 ----------
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.waiting = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error('连接 CDP 超时')), 8000);
      ws.onopen = () => { clearTimeout(t); ok(); };
      ws.onerror = (e) => { clearTimeout(t); bad(new Error('CDP 连接失败: ' + (e?.message ?? 'error'))); };
    });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const w = c.waiting.get(msg.id);
      if (w) { c.waiting.delete(msg.id); w(msg); }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((ok, bad) => {
      const t = setTimeout(() => { this.waiting.delete(id); bad(new Error(`CDP ${method} 超时`)); }, 30000);
      this.waiting.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) bad(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result ?? {});
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const base = () => `http://127.0.0.1:${resolvePort()}`;

/** 端口文件的位置与写入时间——排错时最有用的那句话 */
function portFileInfo() {
  const pf = resolve(String(opt.profile ?? DEFAULT_PROFILE), 'DevToolsActivePort');
  try { return `${pf}（${new Date(statSync(pf).mtimeMs).toLocaleString('zh-CN')} 写入）`; }
  catch { return pf; }
}

/**
 * 所有 CDP HTTP 调用都经过这里：连不上时给出可执行的下一步，而不是裸的 "fetch failed"。
 * 最常见的原因：DevToolsActivePort 是上一次的遗留文件——那个带调试端口的浏览器
 * 窗口已经被关掉了（普通 Edge 窗口没有调试端口，所以连不上）。
 */
async function cdpFetch(path) {
  const url = `${base()}${path}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    fail(`连不上 ${url}\n`
      + `      原因通常是：带调试端口的浏览器窗口已经关闭（端口文件是遗留的），\n`
      + `      或当前运行的 Edge 不是用 --remote-debugging-port 启动的。\n`
      + `      端口文件：${portFileInfo()}\n`
      + `      处理：点一下桌面「DSH 工作窗」快捷方式重新打开窗口，再重跑本命令（端口会自动重新读取）。`);
  }
  if (!res.ok) fail(`CDP 返回 HTTP ${res.status}：${url}`);
  return res.json();
}
const listAll = () => cdpFetch('/json/list');
const pageTargets = async () => (await listAll())
  .filter(t => (t.type === 'page' || t.type === 'other') && /^(https?|file|edge):/.test(t.url ?? ''))
  .filter(t => (t.url ?? '') !== 'edge://newtab/');

/** 挑一个页面：--target / --match，或唯一候选时的默认值 */
async function pickTarget() {
  const pages = await pageTargets();
  if (pages.length === 0) fail('浏览器里没有可操作的页面');
  const t = opt.target !== undefined ? String(opt.target) : undefined;
  const m = opt.match !== undefined ? String(opt.match) : undefined;
  let chosen;
  if (t) {
    if (/^#\d+$/.test(t)) chosen = pages[Number(t.slice(1)) - 1];
    else chosen = pages.find(p => p.id === t) ?? pages.find(p => p.id.startsWith(t));
    if (!chosen) fail(`找不到 target ${t}`);
  } else if (m) {
    chosen = pages.find(p => (p.url ?? '').includes(m) || (p.title ?? '').includes(m));
    if (!chosen) fail(`没有 URL/标题包含 “${m}” 的页面`);
  } else if (pages.length === 1) {
    chosen = pages[0];
  } else {
    console.error('cdp: 有多个页面，请用 --target 或 --match 指定：');
    pages.forEach((p, i) => console.error(`  #${i + 1}  [${p.id}]  ${p.title}  ${p.url}`));
    process.exit(2);
  }
  return chosen;
}

async function withPage(fn) {
  const target = await pickTarget();
  const c = await Cdp.connect(target.webSocketDebuggerUrl);
  try { return await fn(c, target); } finally { c.close(); }
}
async function withBrowser(fn) {
  const v = await cdpFetch('/json/version');
  const c = await Cdp.connect(v.webSocketDebuggerUrl);
  try { return await fn(c, v); } finally { c.close(); }
}

/** 在页面里定位元素，返回视口坐标（供真实鼠标事件使用） */
const LOCATE = `function locate(o) {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let cands = [];
  if (o.selector) {
    cands = Array.from(document.querySelectorAll(o.selector));
    if (cands.length === 0) return { ok: false, why: '选择器没匹配到元素' };
    const el = cands[o.index ?? 0];
    if (!el) return { ok: false, why: '索引超出范围' };
    return hit(el);
  }
  const all = Array.from(document.querySelectorAll('body *')).filter(vis);
  const q = o.text;
  const exact = all.filter(el => (el.textContent || '').trim() === q);
  const loose = all.filter(el => (el.textContent || '').includes(q));
  const pool = exact.length ? exact : loose;
  if (pool.length === 0) return { ok: false, why: '没找到包含该文本的可见元素' };
  pool.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return ra.width * ra.height - rb.width * rb.height; });
  const el = pool[o.index ?? 0] ?? pool[0];
  return hit(el);
  function hit(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2,
      tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80),
      id: el.id || '', cls: String(el.className || '').slice(0, 60) };
  }
}`;

async function evalIn(c, expression, awaitPromise = true) {
  const r = await c.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  }
  return r.result?.value;
}

async function activate(target) {
  await withBrowser(b => b.send('Target.activateTarget', { targetId: target.id }));
}

async function mouseClick(c, x, y) {
  const common = { x, y, button: 'left', clickCount: 1 };
  await c.send('Input.dispatchMouseEvent', { ...common, type: 'mouseMoved' });
  await c.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed', buttons: 1 });
  await new Promise(r => setTimeout(r, 40));
  await c.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased', buttons: 0 });
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
};
async function pressKey(c, name) {
  const k = KEYMAP[name] ?? { key: name, code: name, vk: 0 };
  await c.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk, text: k.text,
  });
  if (k.text) {
    await c.send('Input.dispatchKeyEvent', {
      type: 'char', key: k.key, text: k.text, unmodifiedText: k.text,
    });
  }
  await c.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
  });
}

// ---------- 命令 ----------
const run = {
  async port() {
    const p = resolvePort();
    const v = await cdpFetch('/json/version');
    out(`端口      : ${p}`);
    out(`浏览器    : ${v.Browser}`);
    out(`CDP 端点  : ${v.webSocketDebuggerUrl}`);
    jsonOut({ port: p, browser: v.Browser });
  },

  async list() {
    const pages = await pageTargets();
    out(`浏览器里可操作的页面 ${pages.length} 个：`);
    pages.forEach((p, i) => out(`  #${i + 1}  [${p.id}]  ${p.title || '(无标题)'}\n        ${p.url}`));
    jsonOut(pages.map((p, i) => ({ n: i + 1, id: p.id, title: p.title, url: p.url })));
  },

  async read() {
    await withPage(async (c, t) => {
      // 后台标签页的 layout 可能没更新，innerText 会偏短 —— 需要精确内容时加 --activate
      if (opt.activate) { await activate(t); await new Promise(r => setTimeout(r, 200)); }
      const expr = opt.selector
        ? `(() => { const el = document.querySelector(${JSON.stringify(String(opt.selector))});
             return el ? { found: true, vis: document.visibilityState, text: ${opt.html ? 'el.outerHTML' : 'el.innerText'} } : { found: false }; })()`
        : `({ found: true, vis: document.visibilityState, title: document.title, url: location.href,
             text: ${opt.html ? 'document.documentElement.outerHTML' : 'document.body.innerText'} })`;
      const r = await evalIn(c, expr);
      if (!r.found) fail(`选择器 ${opt.selector} 没匹配到元素`);
      const text = String(r.text ?? '');
      const cap = opt.full ? text.length : Number(opt.chars ?? 3000);
      out(`标题: ${r.title ?? t.title}`);
      out(`URL : ${r.url ?? t.url}`);
      if (r.vis === 'hidden' && !opt.activate) {
        out('提示: 该页在后台，Chromium 可能没更新它的 layout，读到的文本会偏短；加 --activate 可切到前台再读。');
      }
      out(`---- 正文（${Math.min(cap, text.length)}/${text.length} 字符）----`);
      out(text.slice(0, cap));
      jsonOut({ title: r.title ?? t.title, url: r.url ?? t.url, text: text.slice(0, cap), length: text.length });
    });
  },

  async eval() {
    const expr = opt['expr-file'] ? readFileSync(String(opt['expr-file']), 'utf8') : need('expr');
    await withPage(async (c) => {
      const v = await evalIn(c, String(expr));
      const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      out(s ?? String(v));
      jsonOut({ result: v });
    });
  },

  async click() {
    if (!opt.selector && !opt.text) fail('需要 --selector 或 --text');
    await withPage(async (c, t) => {
      await activate(t);
      const info = await evalIn(c, `(${LOCATE})(${JSON.stringify({
        selector: opt.selector ? String(opt.selector) : undefined,
        text: opt.text ? String(opt.text) : undefined,
        index: opt.index ? Number(opt.index) : 0,
      })})`);
      if (!info?.ok) fail(info?.why ?? '没定位到元素');
      if (opt.js) {
        await evalIn(c, `(() => { const el = document.elementFromPoint(${info.x}, ${info.y}); if (!el) return false; el.click(); return true; })()`);
      } else {
        await mouseClick(c, info.x, info.y);
      }
      out(`已点击 <${info.tag.toLowerCase()}> “${info.text}” @ (${Math.round(info.x)}, ${Math.round(info.y)})`);
      jsonOut({ clicked: true, ...info });
    });
  },

  async type() {
    const value = opt['value-file'] ? readFileSync(String(opt['value-file']), 'utf8') : need('value');
    await withPage(async (c, t) => {
      await activate(t);
      const sel = need('selector');
      const r = await evalIn(c, `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { ok: false, why: '选择器没匹配到元素' };
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const val = ${JSON.stringify(String(value))};
        const isArea = el instanceof HTMLTextAreaElement;
        const proto = isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        if (!el.isContentEditable && (el instanceof HTMLInputElement || isArea)) {
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
        } else if (el.isContentEditable) { el.textContent = val; }
        else { return { ok: false, why: '该元素不是输入框（' + el.tagName + '）' }; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: ('value' in el ? el.value : el.textContent).slice(0, 60), tag: el.tagName };
      })()`);
      if (!r?.ok) fail(r?.why ?? '输入失败');
      if (opt.enter) { await new Promise(x => setTimeout(x, 120)); await pressKey(c, 'Enter'); }
      out(`已填入 <${(r.tag ?? '').toLowerCase()}>：${r.value}${opt.enter ? ' 并回车' : ''}`);
      jsonOut({ typed: true, ...r });
    });
  },

  async keys() {
    const key = need('key');
    await withPage(async (c, t) => {
      await activate(t);
      await pressKey(c, key);
      out(`已发送按键 ${key}`);
      jsonOut({ pressed: key });
    });
  },

  async wait() {
    const timeout = Number(opt.timeout ?? 8000);
    await withPage(async (c) => {
      const cond = opt.selector
        ? `!!document.querySelector(${JSON.stringify(String(opt.selector))})`
        : `(document.body ? document.body.innerText : '').includes(${JSON.stringify(String(opt.text))})`;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evalIn(c, cond, false)) { out('条件已满足'); jsonOut({ ok: true }); return; }
        await new Promise(r => setTimeout(r, 250));
      }
      fail(`${timeout}ms 内条件未满足`);
    });
  },

  async shot() {
    const file = resolve(String(need('out')));
    await withPage(async (c, t) => {
      // 隐藏的标签页截图会拿到过期/空白帧，所以默认先把它切到前台渲染一帧
      if (!opt['no-activate']) { await activate(t); await new Promise(r => setTimeout(r, 300)); }
      if (opt.full) await evalIn(c, `(window.scrollTo(0,0), true)`);
      const r = await c.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: !!opt.full, fromSurface: true,
      });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      out(`已保存截图：${file}`);
      jsonOut({ saved: file, url: t.url });
    });
  },

  async nav() {
    const url = need('url');
    await withPage(async (c, t) => {
      await c.send('Page.enable');
      await c.send('Page.navigate', { url });
      await activate(t);
      out(`已导航 ${t.url} → ${url}`);
      jsonOut({ navigated: url });
    });
  },

  async open() {
    const url = need('url');
    await withBrowser(async (b) => {
      const r = await b.send('Target.createTarget', { url });
      out(`已新开标签页 ${r.targetId} → ${url}`);
      jsonOut({ targetId: r.targetId, url });
    });
  },

  async activate() {
    await withPage(async (_c, t) => {
      await activate(t);
      out(`已切到前台：${t.title} (${t.url})`);
      jsonOut({ activated: t.id });
    });
  },

  async close() {
    const id = need('target');
    await withBrowser(async (b) => {
      await b.send('Target.closeTarget', { targetId: id });
      out(`已关闭 ${id}`);
      jsonOut({ closed: id });
    });
  },
};

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
  process.exit(0);
}
if (typeof run[cmd] !== 'function') fail(`未知命令 ${cmd}（可用：${Object.keys(run).join(', ')}）`);
try {
  await run[cmd]();
} catch (e) {
  fail(e?.message ?? String(e));
}