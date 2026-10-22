#!/usr/bin/env node
/**
 * igx-server.mjs — X / Instagram 下载器的本地网页界面
 *
 * 启动后监听 127.0.0.1 上一个端口，浏览器里点几下就能下载。
 * 真正的活还是交给 xvideo.mjs / igd.mjs（都已单独测试过），这里只做壳。
 *
 * 为什么要用子进程 + 日志文件：某些受限环境里 spawnSync 用管道收 stdout 会 EPERM，
 * 只能把子进程的 stdout/stderr 重定向到文件，前端轮询文件增量。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { findFfmpeg } from './get-ffmpeg.mjs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, 'ui.html');
const JOBS = path.join(os.tmpdir(), 'igx-jobs');
const DEFAULT_OUT = path.join(HERE, 'downloads');
const PORT_START = 8737;

fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(DEFAULT_OUT, { recursive: true });

// 上个进程留下的任务文件里有完整链接和日志，属使用痕迹，启动时清掉。
// 只删 10 分钟以前的老文件，这样同时开着的另一个实例不会被打断。
const STALE_MS = 10 * 60 * 1000;
for (const f of fs.readdirSync(JOBS)) {
  const full = path.join(JOBS, f);
  try {
    if (Date.now() - fs.statSync(full).mtimeMs < STALE_MS) continue;
    fs.rmSync(full, { recursive: true, force: true });
  } catch { /* 被占用就跳过 */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ---------- 小工具 ----------
function probePort(port, host = '127.0.0.1', timeout = 350) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { try { s.destroy(); } catch { /* */ } resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function detectProxy() {
  const env = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (env) return env;
  for (const p of [7890, 7897, 2080, 1080, 10809, 8889, 4780, 7891]) {
    if (await probePort(p)) return `http://127.0.0.1:${p}`;
  }
  return null;
}

function findExe(name, extra = []) {
  const cands = [...extra, path.join(HERE, name), path.join(HERE, name + '.exe')].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of [name + '.exe', name]) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- 任务 ----------
const jobs = new Map();
let seq = 0;

function startJob(kind, argv, env, meta = {}) {
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const logPath = path.join(JOBS, `${id}.log`);
  fs.writeFileSync(logPath, '');
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, argv, {
    cwd: HERE,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env },
  });
  // 父进程手里的副本立刻关掉，子进程仍持有自己的
  try { fs.closeSync(fd); } catch { /* */ }

  const job = { id, kind, logPath, child, done: false, exitCode: null, startedAt: Date.now(), meta };
  jobs.set(id, job);

  child.on('exit', (code, signal) => {
    job.done = true;
    job.exitCode = code == null ? -1 : code;
    job.signal = signal;
    job.endedAt = Date.now();
    // 链接清单只是在任务期间给子进程传参用的，跑完立刻删，不留使用痕迹
    if (job.meta && job.meta.listFile) {
      try { fs.rmSync(job.meta.listFile, { force: true }); } catch { /* */ }
    }
  });
  child.on('error', (e) => {
    job.done = true;
    job.exitCode = -1;
    fs.appendFileSync(logPath, `\n[启动失败] ${e.message}\n`);
  });

  return job;
}

function jobState(job, offset) {
  let text = '';
  let size = 0;
  try {
    size = fs.statSync(job.logPath).size;
    if (size > offset) {
      const fd = fs.openSync(job.logPath, 'r');
      const len = Math.min(size - offset, 512 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      fs.closeSync(fd);
      text = buf.toString('utf8');
      offset += len;
    }
  } catch { /* 文件可能还没建好 */ }
  return {
    id: job.id,
    kind: job.kind,
    done: job.done,
    exitCode: job.exitCode,
    text,
    offset,
    size,
    elapsed: Math.round(((job.endedAt || Date.now()) - job.startedAt) / 100) / 10,
  };
}

// ---------- 请求处理 ----------
async function handle(req, res, urlObj) {
  const p = urlObj.pathname;

  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(UI);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length, 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  if (p === '/api/env') {
    const ffmpegPath = findFfmpeg();
    return sendJSON(res, 200, {
      node: process.version,
      ffmpeg: !!ffmpegPath,
      ffmpegPath: ffmpegPath || null,
      proxy: await detectProxy(),
      defaultOut: DEFAULT_OUT,
      toolDir: HERE,
    });
  }

  if (p === '/api/job' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: '请求格式不对' }); }

    const kind = body.kind;
    const proxy = await detectProxy();
    const env = {};
    if (proxy) { env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy; }
    // 走代理时要放过本机地址，否则 igauto 读调试端口（127.0.0.1）会被塞进代理
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = env.NO_PROXY;
    const nodeArgs = proxy ? ['--use-env-proxy'] : [];

    if (kind === 'x') {
      const links = String(body.links || '').trim();
      if (!links) return sendJSON(res, 400, { error: '还没有链接' });
      const outDir = body.outDir && body.outDir.trim() ? path.resolve(body.outDir.trim()) : DEFAULT_OUT;
      fs.mkdirSync(outDir, { recursive: true });

      const listFile = path.join(JOBS, `x-${Date.now()}-${seq}.txt`);
      fs.writeFileSync(listFile, links, 'utf8');

      const argv = [...nodeArgs, path.join(HERE, 'xvideo.mjs'), '--file', listFile, '--out', outDir];
      // 勾了「只列出直链」就只列不下载；否则默认下载最高清晰度
      if (body.allLevels) argv.push('--list');
      else argv.push('--download');
      if (body.force) argv.push('--force');
      if (body.nameTemplate && body.nameTemplate.trim()) argv.push('--name', body.nameTemplate.trim());
      const job = startJob('x', argv, env, { outDir, listFile });
      return sendJSON(res, 200, { id: job.id });
    }

    if (kind === 'ffmpeg') {
      // 运行时去取 ffmpeg（仓库里不带这 105 MB 的 exe）
      const argv = [...nodeArgs, path.join(HERE, 'get-ffmpeg.mjs')];
      const job = startJob('ffmpeg', argv, env, {});
      return sendJSON(res, 200, { id: job.id });
    }

    if (kind === 'iglogin') {
      const argv = [...nodeArgs, path.join(HERE, 'igauto.mjs'), '--login'];
      const job = startJob('iglogin', argv, env, {});
      return sendJSON(res, 200, { id: job.id });
    }

    if (kind === 'iglogout') {
      const argv = [...nodeArgs, path.join(HERE, 'igauto.mjs'), '--logout'];
      const job = startJob('iglogout', argv, env, {});
      return sendJSON(res, 200, { id: job.id });
    }

    if (kind === 'igauto') {
      const links = String(body.links || '').trim();
      if (!links) return sendJSON(res, 400, { error: '还没有链接' });
      const outDir = body.outDir && body.outDir.trim() ? path.resolve(body.outDir.trim()) : DEFAULT_OUT;
      fs.mkdirSync(outDir, { recursive: true });

      const listFile = path.join(JOBS, `iga-${Date.now()}-${seq}.txt`);
      fs.writeFileSync(listFile, links, 'utf8');

      const argv = [...nodeArgs, path.join(HERE, 'igauto.mjs'), '--file', listFile, '--out-dir', outDir];
      if (body.mode === 'list') argv.push('--list');
      const tpl = String(body.nameTemplate || '').trim();
      if (tpl && body.mode !== 'list') argv.push('--name', tpl);
      if (body.force) argv.push('--force');
      const job = startJob('igauto', argv, env, { outDir, listFile });
      return sendJSON(res, 200, { id: job.id });
    }

    if (kind === 'ig') {
      const dump = String(body.links || '').trim();
      const outDir = body.outDir && body.outDir.trim() ? path.resolve(body.outDir.trim()) : DEFAULT_OUT;
      fs.mkdirSync(outDir, { recursive: true });

      if (!dump) return sendJSON(res, 400, { error: '还没有粘贴 CDN 地址' });
      const listFile = path.join(JOBS, `ig-${Date.now()}-${seq}.txt`);
      fs.writeFileSync(listFile, dump, 'utf8');

      const argv = [...nodeArgs, path.join(HERE, 'igd.mjs'), '--from', listFile, '--out-dir', outDir];
      if (body.mode === 'list') {
        argv.push('--list');
      } else {
        // 留空 = 用 igd.mjs 的默认模板自动命名
        const tpl = String(body.nameTemplate || '').trim();
        if (tpl) argv.push('--name', tpl);
        if (body.asset && String(body.asset).trim()) argv.push('--asset', String(body.asset).trim());
      }
      const job = startJob('ig', argv, env, { outDir, listFile });
      return sendJSON(res, 200, { id: job.id });
    }

    return sendJSON(res, 400, { error: '未知任务类型' });
  }

  if (p.startsWith('/api/job/')) {
    const id = p.slice('/api/job/'.length);
    const job = jobs.get(id);
    if (!job) return sendJSON(res, 404, { error: '没有这个任务' });
    const offset = Number(urlObj.searchParams.get('offset') || 0);
    return sendJSON(res, 200, jobState(job, Number.isFinite(offset) ? offset : 0));
  }

  if (p.startsWith('/api/stop/') && req.method === 'POST') {
    const job = jobs.get(p.slice('/api/stop/'.length));
    if (!job) return sendJSON(res, 404, { error: '没有这个任务' });
    try { job.child.kill(); } catch { /* */ }
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/files') {
    const dir = urlObj.searchParams.get('dir') || DEFAULT_OUT;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(mp4|m4v|webm)$/i.test(e.name))
        .map((e) => {
          const st = fs.statSync(path.join(dir, e.name));
          return { name: e.name, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 60);
    } catch { /* 目录不存在 */ }
    return sendJSON(res, 200, { dir, files: entries });
  }

  if (p === '/api/open' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* */ }
    const dir = (body.dir && body.dir.trim()) || DEFAULT_OUT;
    try { spawn('explorer.exe', [dir], { stdio: 'ignore', detached: true }).unref(); } catch { /* */ }
    return sendJSON(res, 200, { ok: true });
  }

  if (p.startsWith('/files/')) {
    const name = decodeURIComponent(p.slice('/files/'.length));
    const dir = urlObj.searchParams.get('dir') || DEFAULT_OUT;
    const full = path.join(dir, path.basename(name));
    if (!full.startsWith(path.resolve(dir))) return sendJSON(res, 403, { error: '路径不合法' });
    let st;
    try { st = fs.statSync(full); } catch { return sendJSON(res, 404, { error: '文件不存在' }); }

    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (!m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
        start = Math.max(0, start);
        end = Math.min(end, st.size - 1);
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        return fs.createReadStream(full, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(full).pipe(res);
  }

  sendJSON(res, 404, { error: '没有这个地址' });
}

// ---------- 启动 ----------
async function listen(port, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const p = port + i;
    const ok = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        const urlObj = new URL(req.url, `http://127.0.0.1:${p}`);
        handle(req, res, urlObj).catch((e) => {
          try { sendJSON(res, 500, { error: e.message }); } catch { /* */ }
        });
      });
      srv.once('error', () => resolve(null));
      srv.listen(p, '127.0.0.1', () => resolve(srv));
    });
    if (ok) return { server: ok, port: p };
  }
  throw new Error('找不到可用端口');
}

const { port } = await listen(PORT_START);
const url = `http://127.0.0.1:${port}/`;
console.log('');
console.log('  X / Instagram 下载器已启动');
console.log(`  ${url}`);
console.log('');
console.log('  关掉这个窗口即可停止。');
console.log('');

if (!process.argv.includes('--no-open')) {
  try { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref(); } catch { /* */ }
}
