#!/usr/bin/env node
/**
 * get-ffmpeg.mjs — 找 ffmpeg；找不到就自动下载一个（静态版，只解出 ffmpeg.exe）
 *
 * 为什么单独一个文件：ffmpeg.exe 有 105 MB，不适合塞进代码仓库当提交物。
 * 所以仓库里不带它，运行时按「先找本地 → 找不到就下」的顺序处理：
 *
 *   1. --ffmpeg <路径> / 环境变量 FFMPEG、FFMPEG_PATH
 *   2. 与本脚本同目录的 ffmpeg.exe（或 bin/ffmpeg.exe）
 *   3. 用户目录下的 .x-ins-video\ffmpeg.exe（工具目录不可写时自动放这里）
 *   4. PATH 里任何 ffmpeg
 *   5. 都没有 → 从 gyan.dev / GitHub 下静态版，解出 ffmpeg.exe
 *
 * 单独用法：
 *   node get-ffmpeg.mjs           # 确保 ffmpeg 就位（需要就下）
 *   node get-ffmpeg.mjs --check   # 只报告，不下载；没有则退出码 1
 *   node get-ffmpeg.mjs --force   # 强制重新下载
 *
 * 走代理：本脚本用的是 Node 自带的 fetch，要让 HTTPS_PROXY 生效需要
 *   node --use-env-proxy get-ffmpeg.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
const CACHE_DIR = path.join(os.homedir(), '.x-ins-video');
const TIMEOUT_MS = 15 * 60 * 1000;

// 依次尝试；第一个带 .sha256 可以做完整性校验
export const SOURCES = [
  {
    name: 'gyan.dev',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    sha256Url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256',
  },
  {
    name: 'GitHub (BtbN)',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    sha256Url: null,
  },
];

export const FFMPEG_HINT = [
  '找不到 ffmpeg —— 合轨（把视频轨和音频轨拼成一个 mp4）必须要它。',
  '',
  '正常情况不用管：脚本会自动下载一份（约 105 MB，只解出 ffmpeg.exe）。',
  '如果自动下载失败，可以手动来：',
  '',
  '  1. 在本目录运行   node get-ffmpeg.mjs',
  '  2. 自己下：https://www.gyan.dev/ffmpeg/builds/  （release-essentials 的 zip）',
  '     把 bin\\ffmpeg.exe 抽出来，放到本目录即可。',
  '  3. 已经有 ffmpeg 的话：加到 PATH，或 --ffmpeg <路径>，或设环境变量 FFMPEG。',
  '',
  '不想让它自动下载，加 --no-fetch（环境变量 IGD_NO_FETCH=1 同样效果）。',
].join('\n');

/** 按优先级找一个可用的 ffmpeg，找不到返回 null */
export function findFfmpeg(extra = []) {
  const cands = [
    ...extra,
    process.env.FFMPEG,
    process.env.FFMPEG_PATH,
    path.join(HERE, EXE),
    path.join(HERE, 'bin', EXE),
    path.join(CACHE_DIR, EXE),
    path.join(CACHE_DIR, 'bin', EXE),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of IS_WIN ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function log(quiet, msg) {
  if (!quiet) console.log(msg);
}

/** 挑一个能写的落盘目录：优先工具目录，其次 ~/.x-ins-video */
function pickTargetDir() {
  for (const dir of [HERE, CACHE_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.rmSync(probe, { force: true });
      return dir;
    } catch { /* 换下一个 */ }
  }
  throw new Error('工具目录和用户目录都不能写，没法保存 ffmpeg。');
}

async function download(url, dest, { quiet, what }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    log(quiet, `下载 ${what}：${url}`);
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('响应没有内容');
    const total = Number(res.headers.get('content-length') || 0);
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader();
    let got = 0;
    let nextTick = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) {
          await new Promise((r) => out.once('drain', r));
        }
        if (!quiet && total && got >= nextTick) {
          const pct = Math.floor((got / total) * 100);
          const mb = (got / 1048576).toFixed(1);
          const all = (total / 1048576).toFixed(1);
          console.log(`  ${pct}%  ${mb} / ${all} MB`);
          nextTick = Math.floor(total * (pct + 10)) / 100;
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total && got !== total) throw new Error(`只下到 ${got}/${total} 字节，不完整`);
    return dest;
  } finally {
    clearTimeout(timer);
  }
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 从 zip 里抽出第一个匹配的条目（支持 store / deflate，够用即可） */
function readZipEntry(zipPath, match) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.statSync(zipPath).size;
    const tailLen = Math.min(size, 66000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip（找不到目录尾）');

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);

    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const cmtLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + cmtLen;

      if (!match(name)) continue;
      if (compSize === 0xffffffff) throw new Error('压缩包用了 zip64，暂不支持');

      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip 局部文件头损坏');
      const dataOff = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

      const raw = Buffer.alloc(compSize);
      fs.readSync(fd, raw, 0, compSize, dataOff);
      const data = method === 0 ? raw : zlib.inflateRawSync(raw);
      return { name, data };
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function verify(bin) {
  // 注意：不能用 encoding/'pipe' 收 stdout —— 某些沙箱环境里管道会 EPERM。
  // 只看退出码就够了。
  try {
    const r = spawnSync(bin, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 30000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 确保有 ffmpeg 可用：有就直接返回路径，没有就下载。
 * 失败时抛错（调用方自己决定退出码和文案）。
 */
export async function ensureFfmpeg({ quiet = false, force = false } = {}) {
  if (!force) {
    const found = findFfmpeg();
    if (found) return found;
  }

  // 本机有代理、但当前进程没开 --use-env-proxy 时，fetch 会走直连（实测慢到 20 KB/s）。
  // 用一个带开关的子进程去下，父进程只等结果。
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  const proxyOn = process.execArgv.includes('--use-env-proxy') || process.env.NODE_USE_ENV_PROXY === '1';
  if (proxy && !proxyOn) {
    log(quiet, `检测到代理 ${proxy}，用子进程带 --use-env-proxy 下载…`);
    const child = spawnSync(
      process.execPath,
      ['--use-env-proxy', fileURLToPath(import.meta.url), ...(quiet ? ['--quiet'] : []), ...(force ? ['--force'] : [])],
      { stdio: 'inherit', env: { ...process.env, __XVIDEO_FFMPEG_CHILD: '1' } }
    );
    if (child.status === 0) {
      const p = findFfmpeg();
      if (p) return p;
    }
    throw new Error('走代理下载 ffmpeg 失败（子进程退出码 ' + child.status + '）。');
  }

  const dir = pickTargetDir();
  const target = path.join(dir, EXE);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-get-'));
  const errors = [];

  try {
    for (const src of SOURCES) {
      const zip = path.join(tmpDir, 'ffmpeg.zip');
      try {
        await download(src.url, zip, { quiet, what: `ffmpeg 静态版（${src.name}）` });

        if (src.sha256Url) {
          try {
            const r = await fetch(src.sha256Url, { signal: AbortSignal.timeout(30000) });
            if (r.ok) {
              const want = (await r.text()).trim().split(/\s+/)[0].toLowerCase();
              const got = sha256File(zip).toLowerCase();
              if (want && want !== got) throw new Error(`sha256 对不上（期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
              log(quiet, '  sha256 校验通过');
            }
          } catch (e) {
            if (/sha256 对不上/.test(String(e && e.message))) throw e;
            // 拿不到校验文件就跳过，不影响主流程
          }
        }

        log(quiet, '  解包中…');
        const entry = readZipEntry(zip, (n) => /(^|\/)bin\/ffmpeg\.exe$/i.test(n) || n === 'ffmpeg.exe');
        if (!entry) throw new Error('压缩包里没找到 bin/ffmpeg.exe');

        fs.writeFileSync(target, entry.data, { mode: 0o755 });
        if (!verify(target)) {
          try { fs.rmSync(target, { force: true }); } catch { /* */ }
          throw new Error('解出来的 ffmpeg 跑不起来（可能被杀软拦了）');
        }
        log(quiet, `ffmpeg 就位：${target}`);
        return target;
      } catch (e) {
        errors.push(`${src.name}: ${e && e.message ? e.message : e}`);
        try { fs.rmSync(zip, { force: true }); } catch { /* */ }
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  }

  throw new Error(`自动下载 ffmpeg 失败：\n  ${errors.join('\n  ')}\n如果本机要走代理，用 node --use-env-proxy 重跑，或先设好 HTTPS_PROXY。`);
}

// ---------- 命令行 ----------
const isMain = (() => {
  try {
    const a = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const b = fileURLToPath(import.meta.url);
    return a.toLowerCase() === b.toLowerCase();
  } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const has = (n) => argv.includes(n);
  if (has('--help') || has('-h')) {
    console.log(
      '用法：\n' +
      '  node get-ffmpeg.mjs           确保 ffmpeg 就位（没有就下载）\n' +
      '  node get-ffmpeg.mjs --check   只报告路径，不下载（没有则退出码 1）\n' +
      '  node get-ffmpeg.mjs --force   强制重新下载\n' +
      '  node get-ffmpeg.mjs --quiet   安静模式\n' +
      '\n走代理：node --use-env-proxy get-ffmpeg.mjs'
    );
  } else if (has('--check')) {
    const p = findFfmpeg();
    console.log(p || 'missing');
    process.exitCode = p ? 0 : 1;
  } else {
    ensureFfmpeg({ quiet: has('--quiet') || has('-q'), force: has('--force') })
      .then((p) => { console.log(p); })
      .catch((e) => {
        console.error(e && e.message ? e.message : String(e));
        console.error('');
        console.error(FFMPEG_HINT);
        process.exitCode = 7;
      });
  }
}
