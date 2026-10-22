#!/usr/bin/env node
/**
 * igd.mjs — Instagram Reel / Post 下载器
 *
 * Instagram 的媒体地址是按会话签名的，网页版用 MSE 播放，DOM 里只有 blob: URL。
 * 本脚本负责「选轨 + 下载 + 合轨 + 命名」：给它 m86（视频）和 m78（音频）两条
 * scontent-*.cdninstagram.com 地址，它去掉 bytestart/byteend 拉全量，
 * 再用 ffmpeg 合并成普通 mp4。
 *
 * 这两条地址一般由 igauto.mjs 自动抓取后传进来；也可以自己从 DevTools 复制。
 *
 * 用法：
 *   node igd.mjs --from <地址文件> --out-dir downloads
 *   node igd.mjs --video <url> --audio <url> -o out.mp4
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, ensureFfmpeg, FFMPEG_HINT } from './get-ffmpeg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// ---------- 小工具 ----------
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

// ffmpeg 的查找/自动下载都在 get-ffmpeg.mjs 里，仓库里不存这个 105 MB 的 exe
const ffPath = () => findFfmpeg([opt(['--ffmpeg'])]);

// ---------- efg 解码：判断音频/视频、取 asset id ----------
function decodeEfg(url) {
  try {
    const u = new URL(url);
    const raw = u.searchParams.get('efg');
    if (!raw) return {};
    const j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const tag = j.vencode_tag || '';
    return {
      tag,
      asset: j.xpv_asset_id,
      duration: j.duration_s,
      bitrate: j.bitrate || 0,
      useCase: j.vi_use_case_id,
      // 广告轨的 tag 形如 ad.igwww-C3.dash_h264-basic-gen2_720p，use_case_id 是 12373
      isAd: /(^|\.)ad\./i.test(tag) || j.vi_use_case_id === 12373,
      isAudio: /audio/i.test(tag),
    };
  } catch {
    return {};
  }
}

/**
 * 从一堆 CDN 地址里挑出「同一条 reel」的最高画质视频轨 + 音频轨。
 * 页面上会预加载一堆别的视频和广告，所以不能见一条用一条。
 */
function pickBestTracks(urls, wantAsset) {
  const items = urls.map((u) => ({ url: u, e: decodeEfg(u) }))
    .filter((x) => x.e && x.e.asset != null && !x.e.isAd);
  if (!items.length) return {};
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.e.asset)) groups.set(it.e.asset, []);
    groups.get(it.e.asset).push(it);
  }
  const summarized = [];
  for (const [asset, list] of groups) {
    const vids = list.filter((x) => !x.e.isAudio);
    const auds = list.filter((x) => x.e.isAudio);
    const vmax = Math.max(0, ...vids.map((x) => x.e.bitrate));
    summarized.push({
      asset, list, vmax, nAudio: auds.length,
      // 同一条 URL 因分片会重复出现多次；重复越多说明这条正在被播放
      hits: list.length,
      duration: list[0]?.e.duration,
      tags: [...new Set(vids.map((x) => x.e.tag))],
    });
  }
  const complete = summarized.filter((g) => g.vmax && g.nAudio);
  // 排序：正在播放的那条（分片请求最多）优先，其次码率最高的
  complete.sort((a, b) => b.hits - a.hits || b.vmax - a.vmax);
  const chosen = wantAsset != null
    ? complete.find((g) => String(g.asset) === String(wantAsset))
    : complete[0];
  if (!chosen) return { groups: summarized };
  const pick = (pred) => chosen.list.filter(pred).sort((a, b) => b.e.bitrate - a.e.bitrate)[0]?.url;
  return {
    videoUrl: pick((x) => !x.e.isAudio),
    audioUrl: pick((x) => x.e.isAudio),
    asset: chosen.asset,
    duration: chosen.duration,
    groups: summarized,
  };
}

// 通过临时文件读剪贴板：管道读 stdout 在受限环境里会被 EPERM 挡掉
function readClipboard() {
  const tmp = path.join(os.tmpdir(), `igd-clip-${process.pid}.txt`);
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `$t = Get-Clipboard -Raw; if ($null -ne $t) { [System.IO.File]::WriteAllText('${tmp.replace(/'/g, "''")}', $t, (New-Object System.Text.UTF8Encoding($false))) }`,
    ], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
    return fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
  } catch {
    return '';
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

function stripRange(url) {
  const u = new URL(url);
  u.searchParams.delete('bytestart');
  u.searchParams.delete('byteend');
  return u.toString();
}

async function getTrack(url, label) {
  const clean = stripRange(url);
  const r = await fetch(clean, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) die(5, `[${label}] HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2000 || buf.subarray(4, 8).toString('latin1') !== 'ftyp') {
    die(5, `[${label}] 拿到的不是 mp4（${buf.length} 字节，可能是过期签名或被拦）`);
  }
  return buf;
}

// ---------- 自动命名 ----------
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

function pad2(n) { return String(n).padStart(2, '0'); }

// 从 mp4 的 avc1 采样描述里读宽高（IG 的 efg 不带分辨率）
function mp4Dims(buf) {
  for (let i = 0; i + 36 < buf.length; i++) {
    if (buf[i] === 0x61 && buf[i + 1] === 0x76 && buf[i + 2] === 0x63 && buf[i + 3] === 0x31) {
      const w = buf.readUInt16BE(i + 28);
      const h = buf.readUInt16BE(i + 30);
      if (w >= 64 && w <= 8192 && h >= 64 && h <= 8192) return { w, h };
    }
  }
  return { w: 0, h: 0 };
}

const DEFAULT_NAME = '{user}_{date}_{dur}s';

// 文件名必须以发布者账号开头：模板里没写 {user} 就自动补在最前面
function withAuthorPrefix(template) {
  const t = String(template || '').trim();
  if (!t) return DEFAULT_NAME;
  return /\{user\}/i.test(t) ? t : `{user}_${t}`;
}

function buildName(template, ctx) {
  let name = String(template).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] === undefined ? '' : String(ctx[k])));
  name = sanitize(name, 110);
  name = name.replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!name || name.length < 2) name = `ig_${ctx.asset || Date.now()}`;
  if (!/\.(mp4|m4v|mov|webm)$/i.test(name)) name += '.mp4';
  const stem = name.replace(/\.(mp4|m4v|mov|webm)$/i, '');
  if (WIN_RESERVED.test(stem)) name = '_' + name;
  return name;
}

// 目标目录里已有同名文件就加 (2)(3)，绝不覆盖
function uniqueName(dir, name) {
  const exists = (n) => fs.existsSync(path.join(dir, n));
  if (!exists(name)) return name;
  const m = name.match(/^(.*?)(\.(?:mp4|m4v|mov|webm))$/i);
  const stem = m ? m[1] : name;
  const ext = m ? m[2] : '';
  for (let i = 2; i < 999; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!exists(cand)) return cand;
  }
  return `${stem}_${Date.now()}${ext}`;
}

const USAGE =
  '用法：\n' +
  '  node igd.mjs --from <地址文件> --out-dir downloads   # DevTools 复制的地址列表 / Copy as cURL\n' +
  '  node igd.mjs --clip --out-dir downloads             # 同上，从剪贴板读\n' +
  '  node igd.mjs --video <m86> --audio <m78> --out-dir downloads\n' +
  '  文件名模板 --name "{user}_{date}_{dur}s"（开头永远是发布者账号，没写 {user} 会自动补）\n' +
  '  可用占位符：{user} {date} {time} {dur} {asset} {shortcode} {vbr} {w} {h} {tag} {src}\n' +
  '  {date}/{time} 是发布时间；拿不到时退回下载时刻。可用 --taken-at <unix秒> 手动指定。\n' +
  '  {user} 只有在同时给出 instagram 页面链接、或用 --user 指定时才有值，否则是 ig。\n' +
  '  ffmpeg 找不到会自动下载一份（--no-fetch 可禁用）。\n' +
  '  加 --list/-l：只列出所有清晰度档位的直链，不下载。';

// 只给了页面链接、没给轨道地址时的提示：告诉用户该往哪走
const PAGE_ONLY_HINT = (link) =>
  `只给了 Instagram 页面链接，没有可用的轨道地址。\n` +
  `  Instagram 的媒体地址必须先在登录态浏览器里取出来，路线有两条：\n` +
  `  1) 全自动：node igauto.mjs "${link}"\n` +
  `     （会自己起专用浏览器抓 m86/m78，再把地址交给本脚本）\n` +
  `  2) 手动：浏览器里播这条视频 → F12 → Network → 筛选 mp4 → 找到 m86（视频）和\n` +
  `     m78（音频）两条 scontent-*.cdninstagram.com 请求，全选复制后\n` +
  `     node igd.mjs --from dump.txt --out-dir downloads\n` +
  `   分片地址里的 bytestart/byteend 不用删，脚本会自动去掉。`;

// ---------- 主流程 ----------
async function main() {
  const urlArg = args.find((a) => /^https?:\/\/(www\.)?instagram\.com\//i.test(a));

  let videoUrl = opt(['--video']);
  let audioUrl = opt(['--audio']);
  const outOpt = opt(['--out', '-o']);
  const outDirOpt = opt(['--out-dir', '--dir']);
  const nameTpl = withAuthorPrefix(opt(['--name', '-N']));
  const quiet = has(['--quiet', '-q']);
  let pickedAsset = null;
  let pageUser = null;
  let pageShortcode = null;
  let allText = args.join('\n');

  if (has(['--help', '-h'])) {
    console.log(USAGE);
    return null;
  }

  // 允许把两条 URL 直接跟在命令后面（自动按 efg 分类）
  if (!videoUrl && !audioUrl) {
    let urls = args.filter((a) => /^https?:\/\/.*(cdninstagram|fbcdn)/i.test(a));
    // 也支持从文件 / 剪贴板 / stdin 读一堆地址（DevTools 里全选复制下来的那坨）
    const srcFile = opt(['--from', '--file', '-f']);
    if (srcFile) {
      if (!fs.existsSync(srcFile)) die(2, `找不到地址文件：${srcFile}`);
      urls = urls.concat(fs.readFileSync(srcFile, 'utf8').match(/https?:\/\/[^\s"'<>]+/g) || []);
    }
    if (has(['--clip'])) {
      urls = urls.concat(readClipboard().match(/https?:\/\/[^\s"'<>]+/g) || []);
    }
    if (has(['--stdin'])) {
      urls = urls.concat(fs.readFileSync(0, 'utf8').match(/https?:\/\/[^\s"'<>]+/g) || []);
    }
    // 注意：这里**故意不去重**。同一条视频会被切成很多 Range 分片请求，
    // 「请求条数最多」正是判断「页面上正在播放的是哪条」的唯一可靠信号。
    // 去重只发生在真正下载的时候（pickBestTracks 内部）。
    allText = args.concat(urls).join('\n');
    const candidates = urls.map((u) => u.replace(/[),;]+$/, ''));
    const picked = pickBestTracks(candidates, opt(['--asset', '--media']));
    pickedAsset = picked.asset != null ? String(picked.asset) : null;
    // 从粘贴内容里找页面链接：能拿到短码，有时还能拿到用户名
    const pageHit = allText.match(/instagram\.com\/(?:([A-Za-z0-9._]{1,30})\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/i);
    if (pageHit) {
      if (pageHit[1] && !/^(p|reel|reels|tv|explore)$/i.test(pageHit[1])) pageUser = pageHit[1];
      pageShortcode = pageHit[2];
    }

    // --list：把每个媒体、每档清晰度的直链全打出来，不下任何字节
    if (has(['--list', '-l'])) {
      if (!picked.groups || !picked.groups.length) die(4, '没从这些地址里认出任何 Instagram 媒体（efg 参数缺失或不是 CDN 地址）。');
      const sorted = picked.groups.slice().sort((a, b) => b.hits - a.hits || b.vmax - a.vmax);
      // 同一个码率可能有多个 tag（不同编码规格），这里按「码率 + tag」去重后再编号
      const dedupe = (list) => {
        const seen = new Set();
        const out = [];
        for (const x of list.slice().sort((a, b) => b.e.bitrate - a.e.bitrate)) {
          const key = `${x.e.bitrate}|${x.e.tag}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(x);
        }
        return out;
      };
      for (const g of sorted) {
        const mark = g.asset === picked.asset ? '*' : ' ';
        const vids = dedupe(g.list.filter((x) => !x.e.isAudio));
        const auds = dedupe(g.list.filter((x) => x.e.isAudio));
        console.log(`${mark} media ${g.asset}  ${g.duration ?? '?'}s  ${vids.length} 个视频档  ${auds.length ? `带音频（${auds.length} 档）` : '无音频轨'}  请求 ${g.hits} 条`);
        vids.forEach((x, i) => {
          const top = i === 0 ? '   ← 最高（默认下这个）' : '';
          console.log(`    视频 ${i + 1}. ${(x.e.bitrate / 1000).toFixed(0)}kbps  ${x.e.tag}${top}`);
          console.log(`      ${stripRange(x.url)}`);
        });
        auds.forEach((x, i) => {
          console.log(`    音频 ${i + 1}. ${(x.e.bitrate / 1000).toFixed(0)}kbps  ${x.e.tag}`);
          console.log(`      ${stripRange(x.url)}`);
        });
      }
      console.log('\n直链已去掉 bytestart/byteend，可直接整段下载。* 是会自动选中的那条，不勾「只列出」时下载的就是它最高的一档。');
      return null;
    }

    videoUrl = picked.videoUrl;
    audioUrl = picked.audioUrl;
    if (picked.asset != null && !quiet) {
      console.log(`选中 media ${picked.asset}${picked.duration ? `，时长 ${picked.duration}s` : ''}（共 ${urls.length} 条候选地址，${picked.groups?.length ?? 0} 个媒体）`);
    }
    if (!videoUrl && !audioUrl) {
      const noInput = !urls.length && !has(['--list', '-l']);
      if (noInput && urlArg) die(2, PAGE_ONLY_HINT(urlArg));
      die(noInput ? 2 : 4, noInput ? USAGE
        : '没认出可用的视频轨。用 --list 看看识别到什么，或用 --video/--audio 手动指定。');
    }
    if (!audioUrl && !quiet) console.log('（这批地址里没有音频轨，将只下载视频）');
  }

  // 路线 B：直链
  if (videoUrl) {
    let ff = ffPath();
    if (!ff) {
      const noFetch = has(['--no-fetch']) || process.env.IGD_NO_FETCH === '1';
      if (noFetch) die(7, FFMPEG_HINT);
      if (!quiet) console.log('没找到 ffmpeg，自动下载一份（约 105 MB，只需下载这一次）…');
      try {
        ff = await ensureFfmpeg({ quiet });
      } catch (e) {
        die(7, `${e && e.message ? e.message : e}\n\n${FFMPEG_HINT}`);
      }
    }
    const ve = decodeEfg(videoUrl);
    if (!quiet) console.log(`视频轨 ${ve.tag || ''} ${ve.duration || '?'}s`);
    if (!quiet && audioUrl) console.log(`音频轨 ${decodeEfg(audioUrl).tag || ''}`);
    const v = await getTrack(videoUrl, 'video');
    const a = audioUrl ? await getTrack(audioUrl, 'audio') : null;
    if (!quiet) console.log(`已下载 video ${v.length}${a ? ` / audio ${a.length}` : ''} 字节，合并中…`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'igd-'));
    const vp = path.join(tmp, 'v.mp4');
    const ap = path.join(tmp, 'a.mp4');
    fs.writeFileSync(vp, v);
    if (a) fs.writeFileSync(ap, a);

    // 输出位置：-o 是完整路径（照旧），--out-dir 是目录 + 模板自动命名
    let dst;
    if (outOpt) {
      dst = path.resolve(outOpt);
    } else {
      const dir = path.resolve(outDirOpt || path.join(HERE, 'downloads'));
      fs.mkdirSync(dir, { recursive: true });
      const sc = pageShortcode || (urlArg || '').match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/)?.[1];
      const dims = mp4Dims(v);
      // {date}/{time} 统一是「发布时间」，跟 X 那边对齐。发布时间由 igauto.mjs 从
      // /api/v1/media/<id>/info/ 里读出来，用 --taken-at 传进来（unix 秒）。
      // 手动路线只喂 CDN 地址时拿不到发布时间，退回下载时刻，并在下面提示一句。
      const takenAt = Number(opt(['--taken-at'])) || 0;
      const d = takenAt > 0 ? new Date(takenAt * 1000) : new Date();
      if (!quiet && !takenAt && !outOpt) {
        console.log('（没拿到发布时间，{date}/{time} 用下载时刻代替；自动模式会自动读发布时间）');
      }
      const ctx = {
        user: sanitize(opt(['--user']) || pageUser || 'ig', 30),
        date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
        time: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
        dur: String(ve.duration || 0),
        asset: pickedAsset || '',
        shortcode: sc || pickedAsset || '',
        vbr: String(Math.round(ve.bitrate / 1000) || 0),
        w: dims.w || 0,
        h: dims.h || 0,
        tag: (ve.tag || '').split('.').pop().replace(/[^A-Za-z0-9_-]/g, ''),
        src: 'ig',
      };
      dst = path.join(dir, uniqueName(dir, buildName(nameTpl, ctx)));
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const ffArgs = ['-y', '-loglevel', 'error', '-i', vp];
    if (a) ffArgs.push('-i', ap);
    ffArgs.push('-c', 'copy', '-movflags', '+faststart', dst);
    const r = spawnSync(ff, ffArgs, { stdio: 'inherit' });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (r.status !== 0) die(5, `ffmpeg 合并失败（exit ${r.status}）`);
    const size = fs.statSync(dst).size;
    if (!quiet) console.log(`完成 ${dst}  ${(size / 1048576).toFixed(2)} MB`);
    return dst;
  }

  // 既没有轨道地址，也没给 CDN 地址 → 说明只给了个页面链接
  die(2, urlArg ? PAGE_ONLY_HINT(urlArg) : USAGE);
}

main().then((p) => {
  if (p && process.argv.includes('--json')) console.log(JSON.stringify({ ok: true, file: p }));
}).catch((e) => {
  if (e && e.message === '__exit__') return;
  console.error(e && e.stack ? e.stack : String(e));
  process.exitCode = process.exitCode || 1;
});
