#!/usr/bin/env node
// xvideo.mjs — 输入 X/Twitter 视频链接，输出最高画质直链；支持批量、自动命名、批量下载。
//
// 单条:
//   node xvideo.mjs https://x.com/someone/status/1234567890123456789/video/1
//   node xvideo.mjs 1234567890123456789 --all
//   node xvideo.mjs <url> --download
//
// 批量:
//   node xvideo.mjs --file links.txt --out D:\下载
//   node xvideo.mjs --file D:\链接目录 --concurrency 4
//   node xvideo.mjs "https://x.com/a/status/111 https://x.com/b/status/222"
//   type links.txt | node xvideo.mjs --stdin --download
//
// 只依赖 Node 18+ 自带的 fetch，不需要 npm install。
// 走代理需要 Node 24+（脚本会自动带 --use-env-proxy 重启自己）。

const TIMEOUT_MS = 30000;
// fxtwitter 在高频调用时会对真实存在的推文间歇性返回 404，多给几次机会
const MAX_RETRY = 3;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 代理自举 ----------
// Node 24 才有 --use-env-proxy。有代理但没开这个开关时，用子进程重新跑一遍自己。
// 不这么做的话，video.twimg.com 在本机会直接连不上（UND_ERR_CONNECT_TIMEOUT）。

const RAW_ARGV = process.argv.slice(2);

function pickProxyArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--proxy' || a === '-p') return argv[i + 1] || '';
    if (a.startsWith('--proxy=')) return a.slice(8);
  }
  return null;
}

async function probeProxy() {
  const net = await import('node:net');
  const ports = [7890, 7897, 2080, 8889, 10809, 4780, 33210, 7891];
  for (const p of ports) {
    const ok = await new Promise((res) => {
      const s = net.connect({ host: '127.0.0.1', port: p });
      const done = (v) => { try { s.destroy(); } catch { /* ignore */ } res(v); };
      s.setTimeout(300);
      s.once('connect', () => done(true));
      s.once('timeout', () => done(false));
      s.once('error', () => done(false));
    });
    if (ok) return `http://127.0.0.1:${p}`;
  }
  return null;
}

async function bootstrapProxy() {
  if (process.env.__XVIDEO_REEXEC === '1') return;
  if (process.execArgv.includes('--use-env-proxy') || process.env.NODE_USE_ENV_PROXY === '1') return;

  let proxy = pickProxyArg(RAW_ARGV);
  if (proxy === 'auto' || proxy === '') proxy = await probeProxy();
  if (!proxy) proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || null;

  if (!proxy) {
    // 没有代理：`--proxy auto` 明确要过代理却找不到，直接说清楚
    if (pickProxyArg(RAW_ARGV) === 'auto') {
      console.error('错误: --proxy auto 没在本机找到可用的 HTTP 代理端口（试过 7890/7897/2080/8889/10809/4780/33210/7891）。');
      process.exitCode = 7;
      return 'exit';
    }
    return;
  }

  if (NODE_MAJOR < 24) {
    console.error(`错误: 走代理需要 Node 24+（当前 v${process.versions.node}）。`);
    console.error('不升级的话，可以只在浏览器里取直链，下载交给下载器。');
    process.exitCode = 7;
    return 'exit';
  }

  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const env = {
    ...process.env,
    __XVIDEO_REEXEC: '1',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
  };
  const child = spawn(
    process.execPath,
    ['--use-env-proxy', fileURLToPath(import.meta.url), ...RAW_ARGV],
    { stdio: 'inherit', env }
  );
  await new Promise((r) => child.on('exit', r));
  process.exitCode = child.exitCode ?? 1;
  return 'exit';
}

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = {
    inputs: [],          // 位置参数里的链接 / id / 文件
    files: [],           // --file
    stdin: false,
    clip: false,
    all: false,
    download: false,
    index: 0,
    allMedia: false,
    out: null,
    name: null,
    concurrency: 3,
    force: false,
    list: false,          // --list：只打印所有档位的直链，不下载
    listFile: null,       // --list-file <文件>：同时把这些直链写进文件
    json: false,
    proxy: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--all' || a === '-a') out.all = true;
    else if (a === '--download' || a === '-d') out.download = true;
    else if (a === '--index' || a === '-n') out.index = Math.max(0, Number(next()) || 0);
    else if (a === '--all-media' || a === '--media') out.allMedia = true;
    else if (a === '--file' || a === '-f') out.files.push(next());
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--clip' || a === '--clipboard') out.clip = true;
    else if (a === '--out' || a === '-o') out.out = next();
    else if (a === '--name' || a === '-N') out.name = next();
    else if (a === '--concurrency' || a === '-c') out.concurrency = Math.max(1, Math.min(16, Number(next()) || 3));
    else if (a === '--force') out.force = true;
    else if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--list-file') out.listFile = next();
    else if (a === '--json') out.json = true;
    else if (a === '--proxy' || a === '-p') out.proxy = next();
    else if (a.startsWith('--proxy=')) out.proxy = a.slice(8);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.inputs.push(a);
  }
  return out;
}

// ---------- 从链接里抠推文 id ----------

function extractStatusId(input) {
  const s = String(input).trim();
  if (/^\d{5,25}$/.test(s)) return s;
  let m = s.match(/(?:^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
  if (m) return m[1];
  m = s.match(/\/status(?:es)?\/(\d+)/i);
  if (m) return m[1];
  m = s.match(/(\d{15,25})/);
  if (m) return m[1];
  return null;
}

// 一段文本 -> 若干 token（空格、换行、逗号、中文逗号、分号都算分隔）
function splitTokens(text) {
  return String(text || '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- 网络 ----------

async function getJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt) await sleep(700 * attempt * attempt + Math.floor(Math.random() * 350));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': UA, accept: 'application/json' },
      });
      const text = await res.text();
      // 注意：fxtwitter 偶尔会对着**真实存在**的推文返回 404 NOT_FOUND（限流的表现），
      // 所以 404/403 也必须重试，不能当成「这条推不存在」直接放弃。
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!text.trimStart().startsWith('{')) throw new Error('返回的不是 JSON（可能被 CDN 拦了）');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      // 只有明确是「请求本身有问题」的状态码才不重试
      if (/^HTTP (400|401|422)/.test(e.message || '')) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------- 把两种接口的返回统一成同一种结构 ----------
// { tweet: {id, text, author, created, duration}, videos: [{mediaId, url, width, height, bitrate, container, isHls, thumbnail, duration}] }

function sizeFromUrl(url) {
  const m = String(url || '').match(/\/(\d{2,4})x(\d{2,4})\//);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
}

function normalizeFx(fx) {
  const t = fx?.tweet;
  if (!t) throw new Error(fx?.message || '接口没有返回 tweet 字段');
  const videos = [];
  for (const m of t?.media?.all || []) {
    if (m.type !== 'video' && m.type !== 'gif') continue;
    const formats = Array.isArray(m.formats) ? m.formats : [];
    for (const f of formats) {
      if (!f.url) continue;
      const container = f.container || (f.content_type || '').replace('video/', '');
      const isHls = /\.m3u8(\?|$)/i.test(f.url) || /mpegurl/i.test(container);
      const s = f.width && f.height ? { width: f.width, height: f.height } : sizeFromUrl(f.url);
      videos.push({
        mediaId: String(m.id),
        url: f.url,
        width: s.width,
        height: s.height,
        bitrate: f.bitrate || 0,
        container,
        isHls,
        thumbnail: m.thumbnail_url || '',
        duration: m.duration || 0,
        altText: m.altText || null,
      });
    }
  }
  return {
    tweet: {
      id: String(t.id),
      text: t.text || '',
      author: t.author || {},
      created: Number(t.created_timestamp || 0),
      duration: videos[0]?.duration || 0,
    },
    videos,
  };
}

function normalizeVx(vx) {
  if (!vx?.tweetID) throw new Error(vx?.error || '接口没有返回 tweetID 字段');
  const videos = [];
  for (const m of vx.media_extended || []) {
    if (m.type !== 'video' && m.type !== 'gif') continue;
    const s = m.size || sizeFromUrl(m.url);
    videos.push({
      mediaId: String(m.id_str || ''),
      url: m.url,
      width: s.width || 0,
      height: s.height || 0,
      bitrate: 0,
      container: 'mp4',
      isHls: /\.m3u8(\?|$)/i.test(m.url || ''),
      thumbnail: m.thumbnail_url || '',
      duration: (m.duration_millis || 0) / 1000,
      altText: m.altText || null,
    });
  }
  return {
    tweet: {
      id: String(vx.tweetID),
      text: vx.text || '',
      author: { screen_name: vx.user_screen_name, name: vx.user_name },
      created: 0,
      duration: videos[0]?.duration || 0,
    },
    videos,
  };
}

// ---------- 排序 ----------

function score(v) {
  // 先看像素总数，再看码率；HLS 兜底时按分片名猜的尺寸算
  return v.width * v.height * 1e6 + v.bitrate;
}

function rank(videos) {
  const mp4 = videos.filter((v) => !v.isHls);
  const pool = mp4.length ? mp4 : videos;
  return pool.slice().sort((a, b) => score(b) - score(a));
}

// 一条推的文 → 按 mediaId 分组，每组各自排序
function groupMedia(videos) {
  const groups = [];
  for (const v of videos) {
    let g = groups.find((x) => x.mediaId === v.mediaId);
    if (!g) { g = { mediaId: v.mediaId, list: [] }; groups.push(g); }
    g.list.push(v);
  }
  return groups.map((g) => ({ ...g, sorted: rank(g.list) }));
}

function humanDuration(sec) {
  if (!sec) return '?';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function label(v) {
  const size = v.width && v.height ? `${v.width}x${v.height}` : '尺寸未知';
  const br = v.bitrate ? `  ${(v.bitrate / 1000).toFixed(0)}kbps` : '';
  return `${size}${br}`;
}

// ---------- 自动命名 ----------
// 模板占位符: {user} {name} {id} {date} {time} {title} {size} {w} {h} {dur} {i} {n} {src} {media}

const WIN_BAD = /[\\/:*?"<>|]/g;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitize(s, max = 60) {
  let out = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(WIN_BAD, ' ')
    .replace(/[#*?_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, max)
    .replace(/[.\s]+$/, '');
  if (WIN_RESERVED.test(out)) out = '_' + out;
  return out;
}

// 从推文正文抽一个像标题的短串：取第一行，去掉链接、@、#、纯符号
function titleFrom(text) {
  const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const cleaned = line
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/[→←↓↑]|\.{3,}|…+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateParts(ts) {
  const d = ts ? new Date(ts * 1000) : new Date();
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
  };
}

const DEFAULT_TEMPLATE = '{user}_{date}_{title}';

// 文件名必须以发布者账号开头。用户自己写的模板里没有 {user} 就自动补成 {user}_<模板>，
// 这样不管模板怎么改，一眼都能看出这条是谁发的。
function withAuthorPrefix(template) {
  const t = String(template || '').trim();
  if (!t) return DEFAULT_TEMPLATE;
  return /\{user\}/i.test(t) ? t : `{user}_${t}`;
}

function makeContext(tweet, v, group, gi, groups, src) {
  const { date, time } = dateParts(tweet.created);
  const title = sanitize(titleFrom(tweet.text), 40) || String(tweet.id);
  return {
    user: sanitize(tweet.author?.screen_name || 'x', 30),
    name: sanitize(tweet.author?.name || '', 20),
    id: String(tweet.id),
    date,
    time,
    title,
    size: v.width && v.height ? `${v.width}x${v.height}` : 'video',
    w: v.width || 0,
    h: v.height || 0,
    dur: String(Math.round(group.list[0].duration || 0)),
    i: gi + 1,
    n: groups.length,
    src: src || '',
  };
}

function buildFileName(template, ctx) {
  let name = String(template).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] === undefined ? '' : String(ctx[k])));
  name = sanitize(name, 110);
  name = name.replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!name || name.length < 2) name = `xvideo_${ctx.id}`;
  if (!/\.(mp4|m4v|mov|webm)$/i.test(name)) name += '.mp4';
  // Windows 保留名是看「主名」的，加完扩展名再查一次
  const stem = name.replace(/\.(mp4|m4v|mov|webm)$/i, '');
  if (WIN_RESERVED.test(stem)) name = '_' + name;
  return name;
}

// 同名不覆盖：已存在（且不是 --force）或本轮已用过，就在扩展名前加 (2)(3)...
function uniqueName(name, used) {
  if (!used.has(name.toLowerCase())) return name;
  const m = name.match(/^(.*?)(\.(?:mp4|m4v|mov|webm))$/i);
  const stem = m ? m[1] : name;
  const ext = m ? m[2] : '';
  for (let i = 2; i < 999; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!used.has(cand.toLowerCase())) return cand;
  }
  return `${stem} (${Date.now()})${ext}`;
}

// ---------- 下载 ----------

async function downloadOnce(url, part, { progress }) {
  const fs = await import('node:fs');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS * 4);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, referer: 'https://x.com/' },
    });
  } catch (e) {
    clearTimeout(timer);
    const why = e.name === 'AbortError' ? `${(TIMEOUT_MS * 4) / 1000} 秒内没有响应` : (e.cause?.code || e.message);
    throw new Error(`连不上 video.twimg.com（${why}）`);
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`HTTP ${res.status}（直链可能已过期，重跑脚本取新链接）`);

  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(part);
  let got = 0;
  let failed = null;

  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
      if (progress && total && process.stdout.isTTY) {
        process.stdout.write(
          `\r  下载中 ${((got / total) * 100).toFixed(1)}%  ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`
        );
      }
    }
  } catch (e) {
    failed = e;
  } finally {
    await new Promise((r) => out.end(r));
    if (progress && process.stdout.isTTY) process.stdout.write('\n');
  }

  if (failed) throw new Error(`传输中断（${failed.cause?.code || failed.message}）`);
  if (total && got !== total) throw new Error(`文件不完整（${got}/${total} 字节）`);
  return { got, total };
}

async function download(url, finalName, { progress = true } = {}) {
  const fs = await import('node:fs');
  const part = finalName + '.part';
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const r = await downloadOnce(url, part, { progress });
      fs.renameSync(part, finalName);
      return r;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(part); } catch { /* 忽略 */ }
      if (/HTTP 4\d\d/.test(e.message) && !/HTTP 429/.test(e.message)) break;
    }
  }
  throw lastErr;
}

// ---------- 退出 ----------
// 注意：不能用 process.exit()。Windows 上 undici 还有未收尾的句柄时强退，
// 会触发 libuv 断言 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。
class Exit extends Error {
  constructor(code, lines) {
    super(lines ? lines.join('\n') : '');
    this.code = code;
    this.lines = lines || [];
  }
}

function fail(code, ...lines) { throw new Exit(code, lines); }

// ---------- 输入收集 ----------

async function collectInputs(args) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const chunks = [];

  for (const raw of args.inputs) {
    const s = String(raw).trim();
    if (!s) continue;
    // 位置参数给了一个真实存在的 .txt / .md / .csv 文件 -> 当清单
    try {
      if (/\.(txt|md|csv|list)$/i.test(s) && fs.existsSync(s) && fs.statSync(s).isFile()) {
        chunks.push(fs.readFileSync(s, 'utf8'));
        continue;
      }
    } catch { /* 忽略 */ }
    chunks.push(s);
  }

  for (const f of args.files) {
    if (!f) continue;
    if (!fs.existsSync(f)) fail(2, `错误: 找不到清单文件 ${f}`);
    const st = fs.statSync(f);
    if (st.isDirectory()) {
      const entries = fs.readdirSync(f).filter((n) => /\.(txt|md|csv|list)$/i.test(n));
      for (const n of entries) chunks.push(fs.readFileSync(path.join(f, n), 'utf8'));
    } else {
      chunks.push(fs.readFileSync(f, 'utf8'));
    }
  }

  if (args.clip) {
    // 通过临时文件取剪贴板：管道读 stdout 在部分受限环境里会被 EPERM 挡掉
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), `xvideo-clip-${process.pid}.txt`);
    try {
      const { execFileSync } = await import('node:child_process');
      const ps = [
        '-NoProfile',
        '-Command',
        `$t = Get-Clipboard -Raw; if ($null -ne $t) { [System.IO.File]::WriteAllText('${tmp.replace(/'/g, "''")}', $t, (New-Object System.Text.UTF8Encoding($false))) }`,
      ];
      execFileSync('powershell', ps, { timeout: 8000, windowsHide: true, stdio: 'ignore' });
      if (fs.existsSync(tmp)) chunks.push(fs.readFileSync(tmp, 'utf8'));
      else fail(2, '错误: 剪贴板是空的（或者只有图片）。');
    } catch (e) {
      if (e instanceof Exit) throw e;
      fail(2, `错误: 读剪贴板失败（${e.message}）`, '可以改用 --file 清单，或直接把链接当参数传进来。');
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }

  if (args.stdin) {
    const fs2 = await import('node:fs');
    try {
      chunks.push(fs2.readFileSync(0, 'utf8'));
    } catch { /* 没有 stdin */ }
  }

  const ids = [];
  const seen = new Set();
  for (const chunk of chunks) {
    for (const tok of splitTokens(chunk.replace(/^\uFEFF/, ''))) {
      if (tok.startsWith('#')) continue;
      const id = extractStatusId(tok);
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// ---------- 解析一条推 ----------

async function resolveTweet(id) {
  const sources = [
    { name: 'fxtwitter', url: `https://api.fxtwitter.com/status/${id}`, norm: normalizeFx },
    { name: 'vxtwitter', url: `https://api.vxtwitter.com/status/${id}`, norm: normalizeVx },
  ];
  const errors = [];
  for (const s of sources) {
    try {
      const raw = await getJSON(s.url);
      if (raw?.code && raw.code !== 200) throw new Error(`接口返回 code ${raw.code}: ${raw.message || ''}`);
      return { ...s.norm(raw), source: s.name };
    } catch (e) {
      errors.push(`  ${s.name}: ${e.message}`);
    }
  }
  const err = new Error('所有接口都失败了');
  err.detail = errors;
  throw err;
}

// ---------- 主流程 ----------

async function main() {
  const boot = await bootstrapProxy();
  if (boot === 'exit') return;

  const args = parseArgs(RAW_ARGV);
  if (args.help) {
    printHelp();
    return;
  }

  const ids = await collectInputs(args);
  if (!ids.length) {
    printHelp();
    console.error('\n错误: 没收到任何可识别的推文链接或 id。');
    process.exitCode = 2;
    return;
  }

  const fs = await import('node:fs');
  const path = await import('node:path');

  // 输出目录
  const outDir = args.out ? path.resolve(args.out) : process.cwd();
  const batch = ids.length > 1 || args.download || args.files.length > 0 || args.stdin || args.clip || !!args.list;
  if (batch || args.download) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const template = withAuthorPrefix(args.name || DEFAULT_TEMPLATE);
  const used = new Set();
  const records = [];
  const links = [];
  const started = Date.now();

  // 单条 & 不下载 & 不写清单 = 老行为：只打印直链
  if (!batch) {
    const id = ids[0];
    let result;
    try {
      result = await resolveTweet(id);
    } catch (e) {
      fail(3, '错误: 所有接口都失败了。', ...(e.detail || []), '',
        '常见原因:', '  - 推文已删除 / 设为私密 / 账号受限', '  - 本机网络到接口不通');
    }
    const { tweet, videos, source } = result;
    if (!videos.length) fail(4, '这条推文里没有视频（可能只有图片或纯文字）。');
    const groups = groupMedia(videos);
    const gi = Math.min(args.index, groups.length - 1);
    const group = groups[gi];
    const best = group.sorted[0];

    const a = tweet.author || {};
    console.log('');
    if (a.screen_name) console.log(`@${a.screen_name}  ${a.name || ''}`);
    if (tweet.text) console.log(tweet.text.replace(/\s*\n\s*/g, ' ').slice(0, 140));
    console.log(`时长 ${humanDuration(group.list[0].duration)}   视频 ${groups.length} 个   本视频 ${group.list.length} 档`);
    console.log('');

    if (args.all) {
      console.log('全部档位（从高到低）:');
      group.sorted.forEach((v, i) => {
        console.log(`  ${i + 1}. ${label(v)}${i === 0 ? '   ← 最高' : ''}`);
        console.log(`     ${v.url}`);
      });
      const hls = group.list.filter((v) => v.isHls);
      if (hls.length) {
        console.log('\nHLS 播放列表:');
        hls.forEach((v) => console.log(`  ${v.url}`));
      }
      console.log('');
    }

    console.log(best.url);
    if (args.name) {
      const ctx = makeContext(tweet, best, group, gi, groups, source);
      console.log(`\n按模板生成的文件名: ${buildFileName(template, ctx)}`);
    }
    return;
  }

  // 批量
  const total = ids.length;
  console.log(`\n共 ${total} 条待处理，并发 ${args.concurrency}，输出到 ${outDir}`);
  if (template !== DEFAULT_TEMPLATE) console.log(`命名模板: ${template}`);
  console.log('');

  let done = 0;
  const queue = ids.map((id, idx) => ({ id, seq: idx + 1 }));

  async function worker() {
    while (queue.length) {
      const task = queue.shift();
      const tag = `[${task.seq}/${total}]`;
      try {
        const { tweet, videos, source } = await resolveTweet(task.id);
        if (!videos.length) throw new Error('这条推没有视频');
        const groups = groupMedia(videos);

        // --all-media 时把这条推里每个视频都下；否则按 --index
        const picks = args.allMedia
          ? groups.map((g, i) => ({ group: g, gi: i }))
          : [{ group: groups[Math.min(args.index, groups.length - 1)], gi: Math.min(args.index, groups.length - 1) }];

        for (const { group, gi } of picks) {
          const best = group.sorted[0];
          // --list：只把「全部清晰度档位 + 直链」打出来，一个字节都不下
          if (args.list) {
            const tag2 = `${tag} @${tweet.author?.screen_name || '?'}`;
            console.log(`${tag2}  ${group.list.length} 个档位（从高到低）:`);
            group.sorted.forEach((v, i) => {
              console.log(`    ${i + 1}. ${label(v)}${i === 0 ? '   ← 最高（不勾选时下这个）' : ''}`);
              console.log(`       ${v.url}`);
            });
            const hls = group.list.filter((v) => v.isHls);
            if (hls.length) {
              console.log('    HLS 播放列表:');
              hls.forEach((v) => console.log(`       ${v.url}`));
            }
            for (const v of group.sorted) links.push(v.url);
            for (const v of hls) links.push(v.url);
            records.push({ id: task.id, ok: true, listed: true, url: best.url });
            continue;
          }
          // --all 在批量/单条统一走这条路径，所以档位信息在这里也要打出来，
          // 否则「文件已存在被跳过」时会一个字都不显示，看着像没执行
          if (args.all) {
            console.log(`${tag} 全部档位（从高到低）:`);
            group.sorted.forEach((v, i) => {
              console.log(`    ${i + 1}. ${label(v)}${i === 0 ? '   ← 最高' : ''}`);
              console.log(`       ${v.url}`);
            });
            const hls = group.list.filter((v) => v.isHls);
            if (hls.length) {
              console.log('    HLS 播放列表:');
              hls.forEach((v) => console.log(`       ${v.url}`));
            }
          }
          const ctx = makeContext(tweet, best, group, gi, groups, source);
          const base = buildFileName(template, ctx);

          // 本轮还没用过这个名字，且磁盘上已有 → 跳过（除非 --force）
          if (!args.force && !used.has(base.toLowerCase()) && fs.existsSync(path.join(outDir, base))) {
            used.add(base.toLowerCase());
            records.push({ id: task.id, ok: true, skipped: true, file: path.join(outDir, base), name: base });
            console.log(`${tag} 跳过（已存在）  ${base}`);
            continue;
          }

          const name = uniqueName(base, used);
          const finalPath = path.join(outDir, name);
          used.add(name.toLowerCase());
          console.log(`${tag} ↓ ${name}`);
          const { got } = await download(best.url, finalPath, { progress: total === 1 });
          records.push({ id: task.id, ok: true, file: finalPath, name, bytes: got, url: best.url });
          console.log(`${tag} ✓ ${name}  ${(got / 1048576).toFixed(2)} MB`);
        }
      } catch (e) {
        records.push({ id: task.id, ok: false, error: e.message, detail: e.detail });
        console.log(`${tag} ✗ ${task.id}  ${e.message}`);
        for (const d of e.detail || []) console.log(`        ${d.trim()}`);
      } finally {
        done++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(args.concurrency, total) }, worker));

  // 清单（--list 只打印；给了 --list-file 才额外写文件）
  if (args.list && args.listFile) {
    const p = path.resolve(args.listFile);
    fs.writeFileSync(p, links.join('\n') + (links.length ? '\n' : ''), 'utf8');
    console.log(`\n已写入 ${links.length} 条直链: ${p}`);
  }

  // 汇总
  const ok = records.filter((r) => r.ok).length;
  const skipped = records.filter((r) => r.skipped).length;
  const failed = records.filter((r) => !r.ok);
  const bytes = records.reduce((s, r) => s + (r.bytes || 0), 0);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log('──────── 汇总 ────────');
  console.log(`成功 ${ok}   跳过 ${skipped}   失败 ${failed.length}   用时 ${secs}s`);
  if (bytes) console.log(`下载 ${(bytes / 1048576).toFixed(2)} MB`);
  if (failed.length) {
    console.log('失败列表:');
    for (const f of failed) console.log(`  ${f.id}  ${f.error}`);
  }
  if (args.json) {
    console.log(JSON.stringify({ total, ok, skipped, failed: failed.length, bytes, records }, null, 2));
  }
  if (failed.length) process.exitCode = 6;
}

function printHelp() {
  console.log(`用法:
  单条:  node xvideo.mjs <链接或 id> [--all] [--index N] [--download]
  批量:  node xvideo.mjs --file <清单.txt 或 目录> [选项]
         node xvideo.mjs "链接1 链接2 链接3"
         type links.txt | node xvideo.mjs --stdin

选项:
  -f, --file <路径>       清单文件（.txt/.md/.csv）或一个目录（扫里面所有 .txt）
      --stdin             从管道读链接
      --clip              从剪贴板读链接（Windows）
  -d, --download          下载最高画质
  -o, --out <目录>        下载目录（默认当前目录）
  -N, --name <模板>       文件名模板，默认 ${DEFAULT_TEMPLATE}
                          占位符: {user} {name} {id} {date} {time} {title}
                                  {size} {w} {h} {dur} {i} {n} {src}
  -c, --concurrency <N>   并发数，默认 3（上限 16）
      --all-media         一条推里有多个视频时全部下载
  -n, --index <N>         只取一条推里第 N 个视频（从 0 起）
  -a, --all               列出全部档位
      --force             同名也重新下载（默认跳过已存在的）
  -l, --list              只列出所有清晰度档位的直链，不下载
      --list-file <文件>  同时把列出的直链写进文件
      --json              结束时输出 JSON 汇总
  -p, --proxy <url|auto>  走代理；auto 自动探测本机 7890 等端口
  -h, --help              帮助

例子:
  node xvideo.mjs https://x.com/someone/status/1234567890123456789/video/1
  node xvideo.mjs --file links.txt --out D:\\下载 --concurrency 4
  node xvideo.mjs --file links.txt --name "{date}_{user}_{title}" --download
  node xvideo.mjs "https://x.com/a/status/111 https://x.com/b/status/222" -d -p auto`);
}

main().catch((e) => {
  if (e instanceof Exit) {
    e.lines.forEach((l) => console.error(l));
    process.exitCode = e.code;
  } else {
    console.error('意外错误:', e?.message || e);
    process.exitCode = 1;
  }
});
