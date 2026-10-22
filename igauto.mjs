#!/usr/bin/env node
/**
 * igauto.mjs —— 只给一条 Instagram 链接，自动抓直链并下载
 *
 * 原理：
 *   Instagram 网页播放器只吐 blob: 地址，媒体真实地址是带签名的 DASH 分轨
 *   （m86 = 视频，m78 = 音频）。本脚本自己拉起一个 Edge（独立配置目录），
 *   通过 DevTools 协议监听网络请求，把这两条地址截下来，再交给 igd.mjs
 *   去 Range、下载、ffmpeg 合轨。
 *
 * 为什么要独立配置目录：
 *   你日常使用的 Edge 配置目录被正在运行的 Edge 独占锁定，cookie 库读不出来。
 *   所以这里用一个专用目录 .ig-browser —— 第一次需要你在弹出的窗口里登录一次，
 *   之后 cookie 就留在那个目录里，往后只输链接即可。
 *
 * 用法：
 *   node igauto.mjs --login                       # 第一次：打开窗口登录 Instagram
 *   node igauto.mjs <ig链接>                       # 之后：只给链接
 *   node igauto.mjs <ig链接> --list                # 只看抓到什么，不下载
 *   node igauto.mjs <ig链接> --out-dir downloads --name "{user}_{date}_{dur}s"
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function opt(names, dflt = undefined) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    const eq = names.find((n) => args[i].startsWith(n + '='));
    if (eq) return args[i].slice(eq.length + 1);
  }
  return dflt;
}
const has = (names) => args.some((a) => names.includes(a) || names.some((n) => a.startsWith(n + '=')));

function die(code, msg) {
  console.error(msg);
  process.exitCode = code;
  throw new Error('__exit__');
}
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 浏览器自己的 stderr 日志写在临时目录里，用完就删，别在 TEMP 里留垃圾
function dropLog(p) {
  try { fs.rmSync(p, { force: true }); } catch { /* 忽略 */ }
}

const PROFILE = path.resolve(opt(['--profile'], path.join(HERE, '.ig-browser')));
const PROXY = opt(['--proxy'], process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890');
const TIMEOUT = Number(opt(['--timeout'], 45000));

// 本机调试端口绝不能走代理（即使带着 --use-env-proxy 起来，也要让 127.0.0.1 直连）
if (!process.env.NO_PROXY) {
  process.env.NO_PROXY = '127.0.0.1,localhost,::1';
  process.env.no_proxy = process.env.NO_PROXY;
}

// ---------- 找浏览器 ----------
function findBrowser() {
  const env = process.env;
  const cands = [
    opt(['--browser']),
    env.IG_BROWSER,
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  for (const n of ['msedge.exe', 'chrome.exe']) {
    try {
      const r = spawnSync('where', [n], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    } catch { /* 忽略 */ }
  }
  return null;
}

// ---------- CDP 小客户端 ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(`${m.error.message}${m.error.data ? ' / ' + m.error.data : ''}`));
        else res(m.result);
        return;
      }
      const hs = this.handlers.get(m.method);
      if (hs) for (const h of hs) { try { h(m.params, m.sessionId); } catch { /* 忽略 */ } }
    };
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  off(method, fn) {
    const hs = this.handlers.get(method);
    if (!hs) return;
    const i = hs.indexOf(fn);
    if (i >= 0) hs.splice(i, 1);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP 超时：${method}`)); }, 30000);
      this.pending.set(id, { res, rej, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

async function waitFor(fn, ms, step = 250, label = '等待超时') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(label);
}

// 连上已经在跑的那个浏览器（比如上一次 --login 留下的窗口）
// 注意：Edge 刚启动时还在写这个文件，读会 EBUSY，所以读失败一律当作"还没好"。
function readDevToolsPort() {
  const pf = path.join(PROFILE, 'DevToolsActivePort');
  let txt;
  try {
    if (!fs.existsSync(pf)) return null;
    txt = fs.readFileSync(pf, 'utf8').trim();
  } catch {
    return null;
  }
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const port = Number(lines[0]);
  return Number.isFinite(port) && port > 0 ? { port, txt } : null;
}

async function tryAttach() {
  const info = readDevToolsPort();
  if (!info) return null;
  const { port } = info;
  try {
    const ver = await getJSON(port, '/json/version');
    return await connect(ver, port, null);
  } catch {
    return null;
  }
}

function getJSON(port, p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (r) => {
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rej);
  });
}

async function connect(ver, port, child, logPath = null) {
  if (typeof WebSocket !== 'function') {
    die(7, `需要 Node 22+（当前 v${process.versions.node}）：这个脚本用内置的 WebSocket 连浏览器调试协议，旧版本没这个全局对象。`);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
    setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 15000);
  });
  const cdp = new CDP(ws);
  return {
    cdp,
    port,
    adopted: !!child === false,
    browser: ver.Browser || '',
    close() {
      // 借用的浏览器（不是这次起的）不关，留着给下次复用
      if (!child) { cdp.close(); return; }
      cdp.close();
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
      try { child.kill(); } catch { /* 忽略 */ }
      // 浏览器进程活着的时候这个日志文件被它占着，删不掉；关了之后再删
      if (logPath) setTimeout(() => dropLog(logPath), 800);
    },
  };
}

// ---------- 启动浏览器 ----------
async function launch({ headless = true }) {
  const exe = findBrowser();
  if (!exe) die(7, '找不到 Edge / Chrome。用 --browser <路径> 指定。');

  // 已经有实例在这个配置目录里跑着，就直接接管，别再起第二个（同目录不能开两份）
  const adopted = await tryAttach();
  if (adopted) return adopted;

  fs.mkdirSync(PROFILE, { recursive: true });
  // 上次异常退出会留下锁文件，删掉才起得来
  for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(PROFILE, f), { force: true }); } catch { /* 忽略 */ }
  }

  const argv = [
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    // 用调试端口起的 Chromium 默认会把 navigator.webdriver 设成 true。
    // Instagram 登录页的风控（reCAPTCHA Enterprise）一看到这个标记就只给一个空白壳，
    // 永远不渲染验证框，表现为"卡在验证页、点什么都没反应"。加上这个开关就恢复成 false。
    '--disable-blink-features=AutomationControlled',
    'about:blank',
  ];
  if (headless) argv.unshift('--headless=new');
  if (PROXY) argv.push(`--proxy-server=${PROXY}`);

  const logPath = path.join(os.tmpdir(), `igauto-${process.pid}.log`);
  const fd = fs.openSync(logPath, 'w');
  const child = spawn(exe, argv, { stdio: ['ignore', fd, fd], windowsHide: headless });
  fs.closeSync(fd);
  child.on('error', () => { /* 交给下面超时处理 */ });

  let portTxt = null;
  try {
    portTxt = await waitFor(() => {
      const info = readDevToolsPort();
      return info ? info.txt : null;
    }, 25000, 200, '浏览器没有起来（调试端口没出现）');
  } catch (e) {
    try { child.kill(); } catch { /* 忽略 */ }
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').slice(0, 4).join('\n') : '';
    // 端口没出现，也许它其实起来了（比如窗口被别的实例挡住了），再试一次接管
    const late = await tryAttach();
    if (late) return late;
    dropLog(logPath);
    die(7, `${e.message}\n${tail}\n如果提示“拒绝访问”，说明这段程序被沙箱限制了，请直接双击 ui.cmd 运行。`);
  }

  const [port] = portTxt.split(/\r?\n/);
  let ver;
  try {
    ver = await getJSON(Number(port), '/json/version');
  } catch {
    try { child.kill(); } catch { /* 忽略 */ }
    dropLog(logPath);
    die(7, '浏览器起来了但调试端口连不上。');
  }
  return await connect(ver, Number(port), child, logPath);
}

// ---------- 退出登录（把本机登录态擦干净） ----------
// 分享工具给别人之前跑一次，保证对方用的是他自己的账号，而不是你的。
// 做法：先清 cookie / localStorage / IndexedDB，再把整个专用配置目录删掉。
// 配置目录只给本工具用，删掉最干净 —— 顺便把浏览历史、缓存的图片视频也一起清掉。
async function doLogout() {
  log('');
  log(`清理这个专用浏览器里的 Instagram 登录态：${PROFILE}`);

  let b = await tryAttach();
  const adopted = !!b;
  if (!b) b = await launch({ headless: true });

  let before = [];
  let still = true;
  try {
    try { await b.cdp.send('Network.enable', {}); } catch { /* 忽略 */ }
    before = await igCookies(b.cdp);
    const hadSession = before.some((c) => c.name === 'sessionid');
    log(`发现 ${before.length} 个 Instagram cookie${hadSession ? '（含登录凭据 sessionid）' : '（本来就没登录）'}。`);

    // 这个配置目录是专门给本工具用的，里面只有 Instagram 的东西，
    // 所以直接把整份 cookie 库清空最干净（比逐个删可靠，不同 CDP 版本支持的方法不一样）。
    try { await b.cdp.send('Network.clearBrowserCookies', {}); } catch { /* 忽略 */ }
    // localStorage / IndexedDB / service worker 里也可能留着账号痕迹
    for (const origin of ['https://www.instagram.com', 'https://instagram.com', 'https://i.instagram.com']) {
      try { await b.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }); } catch { /* 忽略 */ }
    }

    const after = await igCookies(b.cdp);
    still = after.some((c) => c.name === 'sessionid');
    if (still) log(`还有 ${after.length} 个 Instagram cookie 没清掉。`);
  } finally {
    b.close();
    if (!adopted) await sleep(600); // 等自己起的那个进程真的退出，否则目录删不掉
  }

  // 第二步：整个配置目录删掉（cookie 已经清了，这里主要清历史记录和缓存）
  let removed = false;
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    removed = !fs.existsSync(PROFILE);
  } catch (e) {
    log(`删目录失败：${e.message}`);
  }

  if (removed) {
    log(`已删除整个配置目录：${PROFILE}`);
    log('里面包括 cookie、浏览历史、缓存的图片和视频 —— 现在是一个全新的空目录。');
    log('把这个文件夹发给别人，对方第一次用时点「登录 Instagram」，登的是他自己的账号。');
  } else {
    log(`目录没能删干净，可能是专用浏览器窗口还开着（${PROFILE}）。`);
    log('关掉那个窗口，再跑一次这个命令；或者手动把上面那个文件夹删掉。');
    process.exitCode = 6;
  }
}

// ---------- 登录态 ----------
// 读的是这个专用配置目录里的 cookie。用 Storage.getCookies 是因为
// sessionid 是 HttpOnly，页面里的 document.cookie 拿不到。
async function igCookies(cdp) {
  try {
    const r = await cdp.send('Storage.getCookies', {});
    return (r.cookies || []).filter((c) => /(^|\.)instagram\.com$/.test(c.domain) && c.value);
  } catch {
    return [];
  }
}

async function hasLogin(cdp) {
  if (process.env.IGAUTO_ASSUME_LOGIN === '1') return true; // 调试用：跳过登录检查
  const list = await igCookies(cdp);
  return list.some((c) => c.name === 'sessionid');
}

// 等登录。返回 'ok' | 'closed'（窗口被关掉）| 'timeout'
async function waitLogin(b, ms, csp = null) {
  const end = Date.now() + ms;
  let dead = 0;
  let tick = 0;
  while (Date.now() < end) {
    try {
      if (await hasLogin(b.cdp)) return 'ok';
      dead = 0;
      // 每 3 秒瞅一眼有没有弹出人机验证页，弹了就帮它重新加载一次
      if (csp && tick++ % 2 === 0) {
        await csp.ensureCaptcha().catch(() => {});
      }
    } catch {
      // CDP 断了：多半是窗口被关了。连续几次都断就认定它没了。
      dead += 1;
      if (dead >= 3) return 'closed';
    }
    await sleep(1500);
  }
  return 'timeout';
}

// 登录页第一屏只是个落地页，要再点一次「登录」按钮才会长出发表单。
// 这里替用户点掉这一步，省得他到处找那个按钮。
async function nudgeLoginForm(b) {
  let infos = [];
  try { ({ targetInfos: infos } = await b.cdp.send('Target.getTargets')); } catch { return; }
  for (const ti of infos || []) {
    if (ti.type !== 'page') continue;
    if (!/instagram\.com\/accounts\/login/i.test(ti.url || '')) continue;
    let sessionId = null;
    try {
      ({ sessionId } = await b.cdp.send('Target.attachToTarget', { targetId: ti.targetId, flatten: true }));
    } catch { continue; }
    if (!sessionId) continue;
    try {
      const r = await b.cdp.send('Runtime.evaluate', {
        expression: `(() => {
          if (document.querySelectorAll('input').length > 0) return 'form-ready';
          const btn = [...document.querySelectorAll('button')].find((e) => (e.innerText || '').trim() === '登录');
          if (!btn) return 'no-btn';
          btn.click();
          return 'clicked';
        })()`,
        returnByValue: true,
      }, sessionId);
      const v = r && r.result && r.result.value;
      if (v === 'clicked') log('已替你点开登录表单。');
      return v;
    } catch {
      return null;
    }
  }
  return null;
}

// 关掉所有页面 / 框架的 CSP。
// 为什么需要：登录被拦到人机验证页时，Meta 用一个 fbsbx.com 的 iframe 装 reCAPTCHA，
// 那个 iframe 的 CSP 只放行 https://www.gstatic.com/recaptcha/，而中文环境下
// reCAPTCHA 的脚本是从 www.gstatic.cn 拉的 —— 不在白名单里，直接被 CSP 拦掉，
// 于是验证框永远渲染不出来，只留一个空白方块（点什么都没反应）。
// 把这层 CSP 关掉，脚本就能加载，勾选框才会出现。只在登录流程里开，抓视频时不开。
async function bypassCsp(cdp) {
  const sessions = new Map(); // targetId -> sessionId
  const apply = async (targetId) => {
    if (!targetId || sessions.has(targetId)) return sessions.get(targetId) || null;
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      if (!sessionId) return null;
      sessions.set(targetId, sessionId);
      try { await cdp.send('Page.enable', {}, sessionId); } catch { /* 忽略 */ }
      try { await cdp.send('Page.setBypassCSP', { enabled: true }, sessionId); } catch { /* 忽略 */ }
      return sessionId;
    } catch {
      return null;
    }
  };
  const onCreated = (p) => {
    const ti = (p && p.targetInfo) || {};
    if (ti.type === 'page' || ti.type === 'iframe') apply(ti.targetId);
  };
  cdp.on('Target.targetCreated', onCreated);
  try { await cdp.send('Target.setDiscoverTargets', { discover: true }); } catch { /* 忽略 */ }

  // 挨个扫一遍现在已有的目标，顺便把网址也带回来（要找验证页）
  async function sweep() {
    const out = [];
    let infos = [];
    try { ({ targetInfos: infos } = await cdp.send('Target.getTargets')); } catch { infos = []; }
    for (const ti of infos || []) {
      if (ti.type !== 'page' && ti.type !== 'iframe') continue;
      if (!/instagram\.com|fbsbx\.com|recaptcha\.net|gstatic|google\.com/.test(ti.url || '')) continue;
      const sid = await apply(ti.targetId);
      out.push({ targetId: ti.targetId, url: ti.url || '', sessionId: sid });
    }
    return out;
  }

  // 验证页是先加载、后弹出来的，等我们能挂上去时它的脚本已经被 CSP 拦掉了。
  // 所以发现验证框没渲染出来，就把那一层重载一次 —— 这次 CSP 是关着的，
  // 脚本能过，勾选框才会出现。已经渲染出来的不碰，免得把用户正在填的东西刷掉。
  const reloaded = new Set();
  const anchorCount = async (sid) => {
    if (!sid) return -1;
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: "document.querySelectorAll('#rc-anchor-container,.recaptcha-checkbox,[role=checkbox]').length",
        returnByValue: true,
      }, sid);
      return Number(r && r.result && r.result.value) || 0;
    } catch {
      return -1; // 评估不了（比如跨源），当成不知道
    }
  };

  async function ensureCaptcha() {
    const tabs = await sweep();
    for (const t of tabs) {
      if (!/auth_platform\/recaptcha|captcha\/recaptcha/i.test(t.url)) continue;
      if (reloaded.has(t.targetId)) continue;
      const n = await anchorCount(t.sessionId);
      if (n > 0) { reloaded.add(t.targetId); continue; }
      reloaded.add(t.targetId);
      // 等它把 iframe 建出来，再把新 iframe 也关掉 CSP，然后重载这一层
      await sleep(1200);
      await sweep();
      try { await cdp.send('Page.reload', { ignoreCache: true }, t.sessionId); } catch { /* 忽略 */ }
      await sleep(1500);
      await sweep();
      log('已让验证框重新加载（绕过了那条把它拦掉的浏览器安全策略）。');
    }
    return tabs;
  }

  return { sweep, ensureCaptcha, off: () => cdp.off('Target.targetCreated', onCreated) };
}


async function doLogin(existing = null) {
  const MAX_MIN = Number(opt(['--login-wait'], '10')) || 10;

  let b = existing;
  if (b && (await hasLogin(b.cdp).catch(() => false))) return b;
  if (b) { b.close(); b = null; }

  for (let attempt = 1; attempt <= 5; attempt++) {
    log('');
    log('需要在这个专用浏览器里登录一次 Instagram（只这一次，以后不用）。');
    log('已经打开一个浏览器窗口，请在里面登录；登录成功后会自动继续。');
    log(`登录态只存在这里：${PROFILE}`);
    log('这个目录是独立的，跟你在日常浏览器里的 Instagram 账号互不影响。');
    if (attempt > 1) log(`（第 ${attempt} 次尝试。）`);
    log('');

    b = await launch({ headless: false });
    // 登录过程中把 CSP 关掉，否则人机验证的勾选框永远渲染不出来
    const csp = await bypassCsp(b.cdp).catch(() => null);
    // 直接开登录表单页，省得用户还得自己点「登录」
    let targetId = null;
    try {
      ({ targetId } = await b.cdp.send('Target.createTarget', { url: 'https://www.instagram.com/accounts/login/' }));
      // 把窗口抬到最前，避免被别的窗口盖住
      try { await b.cdp.send('Target.activateTarget', { targetId }); } catch { /* 忽略 */ }
    } catch { /* 走下面的等待循环 */ }
    await sleep(1200);
    if (csp) await csp.sweep().catch(() => {});
    await nudgeLoginForm(b).catch(() => {});

    const r = await waitLogin(b, MAX_MIN * 60 * 1000, csp);
    if (csp) csp.off();
    if (r === 'ok') {
      log('登录成功。');
      return b;
    }
    try { b.close(); } catch { /* 忽略 */ }
    if (r === 'closed') {
      log('');
      log('窗口被关掉了，正在重新打开一个…（不想继续就按 Ctrl+C）');
      await sleep(1200);
      continue;
    }
    die(6, `等了 ${MAX_MIN} 分钟还没等到登录。重跑同一条命令即可，或者用 --login-wait <分钟> 把等待时间调长。`);
  }
  die(6, '连续几次窗口都被关掉了。想继续就再跑一次：node igauto.mjs --login');
}

// ---------- efg 解码（与 igd.mjs 同口径） ----------
function decodeEfg(url) {
  try {
    const raw = new URL(url).searchParams.get('efg');
    if (!raw) return {};
    const j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const tag = j.vencode_tag || '';
    return {
      tag,
      asset: j.xpv_asset_id,
      duration: j.duration_s,
      bitrate: j.bitrate || 0,
      isAd: /(^|\.)ad\./i.test(tag) || j.vi_use_case_id === 12373,
      isAudio: /audio/i.test(tag),
    };
  } catch {
    return {};
  }
}

// ---------- 抓一条 reel ----------
async function openBrowser() {
  const headless = !has(['--headful']);
  let b = await launch({ headless });
  if (await hasLogin(b.cdp)) return b;
  b.close();
  // 没登录过：开个可见窗口让用户登一次
  const hb = await doLogin();
  hb.close();
  b = await launch({ headless });
  if (!(await hasLogin(b.cdp))) {
    b.close();
    die(6, '登录之后仍然读不到 Instagram 的登录 cookie。\n' +
      `可以直接跑：node igauto.mjs --login\n（配置目录 ${PROFILE}）`);
  }
  return b;
}

async function grab(pageUrl, shared = null) {
  const b = shared || await openBrowser();
  const { cdp } = b;
  let sid = null;
  let targetId = null;
  let onReq = null;
  let onRes = null;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Network.enable', {}, sid);
    await cdp.send('Page.enable', {}, sid);

    const found = new Map(); // url -> 命中次数
    const add = (u) => {
      if (!u || !/cdninstagram\.com/i.test(u) || !/\.mp4([?#]|$)/i.test(u)) return;
      if (!/[?&]efg=/.test(u)) return;
      found.set(u, (found.get(u) || 0) + 1);
    };
    onReq = (p) => add(p.request?.url);
    onRes = (p) => add(p.response?.url);
    cdp.on('Network.requestWillBeSent', onReq);
    cdp.on('Network.responseReceived', onRes);

    log(`打开：${pageUrl}`);
    await cdp.send('Page.navigate', { url: pageUrl }, sid);

    // 等页面稳定 + 视频开始播
    await sleep(4000);

    const state = async () => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const u = location.href;
          const v = document.querySelector('video');
          let d = 0, t = 0;
          if (v) { try { d = v.duration || 0; } catch {} t = v.currentTime || 0; }
          return JSON.stringify({ url: u, title: document.title, dur: d, t,
            loginWall: /\\/accounts\\/login/.test(u) || !!document.querySelector('input[name="username"]'),
            videos: document.querySelectorAll('video').length });
        })()`,
        returnByValue: true,
      }, sid);
      try { return JSON.parse(r.result.value); } catch { return {}; }
    };

    let st = await state();
    if (st.loginWall) {
      die(6, `Instagram 要求登录（${PROFILE} 里的登录态可能过期了）。\n重新登录：node igauto.mjs --login`);
    }

    // 让主视频真的播起来：静音 + play + 轻推一下进度
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const vs = [...document.querySelectorAll('video')];
        if (!vs.length) return 'no-video';
        const v = vs[0];
        v.muted = true;
        v.play && v.play().catch(() => {});
        try { v.currentTime = Math.min(0.3, (v.duration || 1) / 4); } catch {}
        return 'ok';
      })()`,
      returnByValue: true,
    }, sid);

    // 轮询：等到有音频轨 + 视频轨，或者超时
    const deadline = Date.now() + TIMEOUT;
    let lastCount = 0;
    while (Date.now() < deadline) {
      await sleep(1200);
      st = await state();
      if (st.loginWall) die(6, '翻到登录页了，先跑 node igauto.mjs --login 重新登录。');
      const items = [...found.keys()].map((u) => ({ url: u, e: decodeEfg(u) })).filter((x) => x.e.asset != null && !x.e.isAd);
      const assets = new Set(items.map((x) => x.e.asset));
      const hasA = items.some((x) => x.e.isAudio);
      const hasV = items.some((x) => !x.e.isAudio);
      if (found.size !== lastCount) {
        log(`  已捕获 ${found.size} 条媒体请求（${assets.size} 个媒体，音频 ${hasA ? '有' : '无'}）`);
        lastCount = found.size;
      }
      if (hasA && hasV) break;
      // 有些 reel 没有独立音轨，再多等一轮就认了
      if (hasV && Date.now() > deadline - TIMEOUT / 2) break;
    }

    if (!found.size) {
      die(4, '没抓到任何媒体请求。可能是这条需要登录、或被地区/年龄门挡住。\n' +
        '可以先试：node igauto.mjs --headful 看看到底打开了什么页面。');
    }

    // 分组，选「正在播放的那条」
    const items = [...found.entries()].map(([url, n]) => ({ url, n, e: decodeEfg(url) })).filter((x) => x.e.asset != null && !x.e.isAd);
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.e.asset)) groups.set(it.e.asset, []);
      groups.get(it.e.asset).push(it);
    }
    const sums = [];
    for (const [asset, list] of groups) {
      const vids = list.filter((x) => !x.e.isAudio);
      const auds = list.filter((x) => x.e.isAudio);
      sums.push({
        asset,
        list,
        vmax: Math.max(0, ...vids.map((x) => x.e.bitrate)),
        nAudio: auds.length,
        hits: list.reduce((s, x) => s + x.n, 0),
        duration: list[0]?.e.duration,
      });
    }

    const domDur = Number(st.dur) || 0;
    const near = domDur ? sums.filter((g) => Math.abs((g.duration || 0) - domDur) <= 1.5) : [];
    const pool = (near.length ? near : sums).filter((g) => g.vmax);
    pool.sort((a, b) => b.hits - a.hits || b.vmax - a.vmax);
    const chosen = pool[0];

    if (has(['--list', '-l'])) {
      log('\n识别到的媒体（* 为选中项）：');
      const sorted = [...sums].sort((a, b) => b.hits - a.hits || b.vmax - a.vmax);
      for (const g of sorted) {
        log(`  ${g.asset === chosen?.asset ? '*' : ' '} media ${g.asset}  ${g.duration ?? '?'}s  视频 ${(g.vmax / 1000).toFixed(0)}kbps  ${g.nAudio ? '有音频' : '无音频'}  请求 ${g.hits} 条`);
      }
      return null;
    }
    if (!chosen) die(4, '抓到了地址但挑不出可用的视频轨。');

    const vUrl = chosen.list.filter((x) => !x.e.isAudio).sort((a, b) => b.e.bitrate - a.e.bitrate)[0]?.url;
    const aUrl = chosen.list.filter((x) => x.e.isAudio).sort((a, b) => b.e.bitrate - a.e.bitrate)[0]?.url;
    log(`\n选中 media ${chosen.asset}${chosen.duration ? `，${chosen.duration}s` : ''}（共 ${sums.length} 个媒体）`);

    // 交给 igd.mjs：它负责去 Range、下载、ffmpeg 合轨、命名
    const igdArgv = [path.join(HERE, 'igd.mjs'), pageUrl, '--video', vUrl];
    if (aUrl) igdArgv.push('--audio', aUrl);
    const outDir = opt(['--out-dir', '--dir']);
    if (outDir) igdArgv.push('--out-dir', outDir);
    const outFile = opt(['--out', '-o']);
    if (outFile) igdArgv.push('-o', outFile);
    const nameTpl = opt(['--name', '-N']);
    if (nameTpl) igdArgv.push('--name', nameTpl);
    const userName = opt(['--user']);
    if (userName) igdArgv.push('--user', userName);
    if (has(['--force'])) igdArgv.push('--force');

    // igd.mjs 用 fetch 直连 CDN，本机必须带 --use-env-proxy 才走代理。
    // 注意：子进程不会继承我们的 execArgv，所以只要环境里有代理变量就得传，
    // 不能因为「我自己已经带了 --use-env-proxy」就跳过（那样子进程反而拿不到）。
    const needProxy = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
    const nodeTls = needProxy ? ['--use-env-proxy'] : [];
    const child = spawn(process.execPath, [...nodeTls, ...igdArgv], { cwd: HERE, stdio: 'inherit' });
    const code = await new Promise((res) => child.on('exit', (c) => res(c ?? 1)));
    if (code !== 0) process.exitCode = code;
    return null;
  } finally {
    // 用完把监听摘掉、标签页关掉，批量跑的时候才不会越积越多
    if (onReq) cdp.off('Network.requestWillBeSent', onReq);
    if (onRes) cdp.off('Network.responseReceived', onRes);
    if (targetId) { try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* 忽略 */ } }
    if (!shared) b.close();
  }
}

const USAGE =
  '用法：\n' +
  '  node igauto.mjs --login                   # 第一次：打开窗口登录 Instagram（只需一次）\n' +
  '  node igauto.mjs <ig链接>                   # 之后：只给链接，自动抓直链并下载\n' +
  '  node igauto.mjs <链接1> <链接2> <链接3>     # 多条一起，浏览器只起一次\n' +
  '  node igauto.mjs --file list.txt            # 从文件读链接，一行一条\n' +
  '  node igauto.mjs <ig链接> --list            # 只看识别到什么，不下载\n' +
  '  node igauto.mjs <ig链接> --out-dir <目录> --name "{user}_{date}_{dur}s"\n' +
  '  node igauto.mjs --logout                  # 清掉本机登录态（把工具分享给别人之前跑）\n' +
  '可选：--login-wait <分钟>（等登录的时间，默认 10；窗口被关掉会自动重开）\n' +
  '      --headful（显示窗口，排查用）  --proxy <url>  --profile <目录>  --browser <exe>  --force\n' +
  '      --user <名字>（给 {user} 占位符用；链接里带用户名时不必给）';

async function main() {
  if (has(['--help', '-h'])) { console.log(USAGE); return null; }
  if (has(['--login'])) { await doLogin(); return null; }
  if (has(['--logout'])) { await doLogout(); return null; }

  const RE = /^https?:\/\/(www\.)?instagram\.com\//i;
  const urls = args.filter((a) => RE.test(a));

  const file = opt(['--file', '-f']);
  if (file) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) die(2, `找不到链接文件：${file}`);
    const fromFile = fs.readFileSync(p, 'utf8').split(/\r?\n/)
      .map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && RE.test(s));
    urls.push(...fromFile);
  }

  const uniq = [...new Set(urls)];
  if (!uniq.length) die(2, USAGE + '\n\n需要至少一条 instagram 链接。');
  if (uniq.length === 1) return await grab(uniq[0]);

  // 多条：浏览器只起一次，逐条抓
  const b = await openBrowser();
  let failed = 0;
  try {
    for (let i = 0; i < uniq.length; i++) {
      log(`\n———— [${i + 1}/${uniq.length}] ${uniq[i]} ————`);
      try {
        await grab(uniq[i], b);
        if (process.exitCode) { failed++; process.exitCode = 0; }
      } catch (e) {
        if (e && e.message === '__exit__') { failed++; process.exitCode = 0; continue; }
        failed++;
        console.error(`失败：${e && e.message ? e.message : e}`);
      }
    }
  } finally {
    b.close();
  }
  if (failed) {
    log(`\n完成：成功 ${uniq.length - failed} 条，失败 ${failed} 条。`);
    process.exitCode = 6;
  }
  return null;
}

main().catch((e) => {
  if (e && e.message === '__exit__') return;
  console.error(e && e.stack ? e.stack : String(e));
  if (!process.exitCode) process.exitCode = 1;
});
