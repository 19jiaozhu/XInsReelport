# XInsReelport

# X / Instagram 视频下载工具

# 如果你这个工具对你用帮助，请给我一颗⭐，谢谢！

![Node](https://img.shields.io/badge/node-18%2B-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Dependencies](https://img.shields.io/badge/dependencies-0-success)

不用装浏览器扩展，不用注册第三方账号，不用 `npm install`。双击 `ui.cmd` 打开本地界面，粘链接，点开始。

---

## 特性

| | X（推特） | Instagram |
|---|---|---|
| 输入 | 推文链接（可批量） | Reel / 帖子链接（可批量） |
| 需要登录 | **不需要** | **需要一次**（专用浏览器，登一次长期有效） |
| 画质 | 该推可用的最高档 mp4 | 原视频档（视频轨 + 音频轨） |
| 自动命名 | ✅ 13 个占位符 | ✅ 10 个占位符 |
| 批量 | ✅ 清单文件 / 目录 / 剪贴板 / 管道 | ✅ 同左 |
| 断点容错 | 失败自动重试、直链过期自动重取 | 自动重试、失败不留半截文件 |

- **最高画质优先**：X 侧按「像素总数优先、码率其次」排序，HLS 只在天梯里没有 mp4 时兜底。
- **自动命名**：默认模板直接出来可读的文件名，撞名自动加 ` (2)`，不覆盖。
- **零依赖**：只用 Node 内置模块。
- **ffmpeg 自动获取**：仓库里不带二进制，第一次需要合轨时自己下一份。

---

## 快速开始

### 环境要求

- **Node.js 18+**（Instagram 自动模式要 **22+**，它用内置的 `WebSocket` 连浏览器调试协议；走代理下载要 **24+**，脚本会自动加 `--use-env-proxy`）
- **Windows**（`.cmd` 启动器是批处理；核心 `.mjs` 脚本本身是跨平台的）
- **Edge 或 Chrome**（只有 Instagram 的自动模式需要）

不需要 `npm install`。

### 运行

```powershell
# 图形界面（推荐）
双击 ui.cmd

# 或者命令行
node xvideo.mjs "https://x.com/<user>/status/<id>"
node igauto.mjs "https://www.instagram.com/reels/<shortcode>/"
```

首次打开 Instagram 会自动弹出一个专用浏览器窗口，登录一次即可。**它不碰你日常用的浏览器**，配置目录在 `.ig-browser\`。

---

## 目录结构

```
XInsReelport\
├── ui.cmd            图形界面入口（双击这个）
├── ui.html           图形界面本身
├── igx-server.mjs    本地服务（127.0.0.1:8737）
├── xvideo.mjs        X：取直链 / 批量 / 下载 / 命名
├── igauto.mjs        Instagram：自动模式（自己起浏览器抓地址）
├── igd.mjs           Instagram：选轨 + 下载 + 合轨 + 命名
├── get-ffmpeg.mjs    找 ffmpeg，找不到就自动下一份
├── x-video.cmd       X：拖拽 / 双击入口
├── ig-video.cmd      Instagram：手动路线入口
├── README.md
├── LICENSE
│
├── .ig-browser\      （自动生成）Instagram 专用浏览器配置 + 登录态
└── downloads\        （自动生成）下载的文件
```

> `.ig-browser\` 里有登录 cookie，`downloads\` 里有你下的东西。**这两个目录不要提交、不要分享。**

---

## 图形界面

双击 `ui.cmd`，浏览器自动打开 `http://127.0.0.1:8737/`（端口被占自动顺延到 8738、8739…）。关掉那个命令行窗口，服务就停了。

- **X 标签页**：贴链接 → 选保存目录 / 命名模板 → 勾「直接下载视频」→ 开始。想先看画质就勾「列出所有清晰度档位」。
- **Instagram 标签页**：直接贴链接，`/reel/`、`/reels/`、`/p/` 都认，可以一次贴一批。第一次点「登录 Instagram（第一次）」。
- 底部是实时日志和已下载文件列表（可直接播放 / 另存）。

所有子进程都是隐藏运行的，不会额外弹黑框；日志走本地文件，由页面轮询。

---

## X（推特）

### 命令行

```powershell
# 只输出最高画质直链（一行，方便复制）
node xvideo.mjs "https://x.com/<user>/status/<id>/video/1"

# 列出所有档位
node xvideo.mjs "https://x.com/<user>/status/<id>" --all

# 直接下载
node xvideo.mjs "https://x.com/<user>/status/<id>" --download --out downloads
```

### 批量

```powershell
node xvideo.mjs --file links.txt -d                      # 清单文件
node xvideo.mjs --file "D:\some\dir" -d                  # 目录（扫 .txt/.md/.csv）
node xvideo.mjs "链接1 链接2 链接3" -d                    # 直接当参数
type links.txt | node xvideo.mjs --stdin -d              # 管道
node xvideo.mjs --clip -d                                # 剪贴板
```

清单里 `#` 开头的行忽略，重复的推文 id 会自动去重。并发默认 3（上限 16），失败重试 2 次，直链过期会重新取一次。

### 参数

| 参数 | 作用 |
|---|---|
| （不加） | 只输出最高画质直链 |
| `-f, --file <路径>` | 清单文件或目录 |
| `--stdin` / `--clip` | 从管道 / 剪贴板读 |
| `-d, --download` | 下载最高画质 |
| `-o, --out <目录>` | 下载目录（默认当前目录） |
| `-N, --name <模板>` | 文件名模板，默认 `{user}_{date}_{title}` |
| `-c, --concurrency <N>` | 并发数，默认 3，上限 16 |
| `--all-media` | 一条推有多个视频时全部下载 |
| `-n, --index <N>` | 只取第 N 个视频（从 0 起） |
| `-a, --all` | 列出所有档位和 HLS |
| `--force` | 同名也重下（默认跳过） |
| `--list <文件>` | 只写直链进文件 |
| `--json` | 结束时输出 JSON 汇总 |
| `-p, --proxy <url\|auto>` | 走代理；`auto` 探测常见端口 |

### 命名占位符

| 占位符 | 含义 | 例子 |
|---|---|---|
| `{user}` | 用户名 | `someone` |
| `{name}` | 显示名 | `Some One` |
| `{id}` | 推文 id | `1234567890123456789` |
| `{date}` `{time}` | 发布时间 | `2026-01-15` / `195801` |
| `{title}` | 正文第一行（去链接/@/#，截 40 字） | `这是一条示例推文的正文` |
| `{size}` `{w}` `{h}` | 分辨率 | `720x1280` / `720` / `1280` |
| `{dur}` | 时长（秒） | `16` |
| `{i}` `{n}` | 本条推第几个 / 共几个 | `1` / `2` |
| `{src}` | 数据来源 | `fxtwitter` |

---

## Instagram

Instagram 和 X 完全是两回事：网页版用 MSE 播放，DOM 里只有 `blob:` 地址；媒体 URL 按会话签名、并且被切成 Range 分片。**无登录的纯 HTTP 路线已经全线失效**（og 标签 / `api/v1/media/<id>/info/` / GraphQL / oEmbed / 各种爬虫 UA / 各种第三方解析站，实测均拿不到）。

所以这里的做法是：**自己起一个专用浏览器，在真实播放时把两条 DASH 轨截下来，再本地合轨。**

### 用法

```powershell
node igauto.mjs --login                                    # 第一次：登录一次
node igauto.mjs "https://www.instagram.com/reels/<code>/"   # 之后：只给链接
node igauto.mjs "链接1" "链接2" --out-dir downloads          # 多条，浏览器只起一次
node igauto.mjs --file list.txt --out-dir downloads         # 从文件读
node igauto.mjs "链接" --list                               # 只看抓到什么
```

### 它做了什么

1. 拉起专用 Edge（配置目录 `.ig-browser`，不碰你日常浏览器）；
2. 通过 DevTools 协议在后台打开页面，等播放器开始拉流；
3. 从网络请求里挑出 `m86`（视频轨）和 `m78`（音频轨）两条 CDN 地址；
4. 去掉 Range 参数拿到完整文件；
5. `ffmpeg -c copy -movflags +faststart` 合轨，**不重新编码**。

页面上会预加载一堆别人的推荐视频和广告，脚本按 `efg` 参数里的 `xpv_asset_id` 分组，再用「分片请求次数最多」判断哪条是你正在看的那条。拿不准就用 `--list` 看一眼，带 `*` 的是会选中的。

### 参数

| 参数 | 作用 |
|---|---|
| `--login` | 打开窗口登录一次 |
| `--logout` | 清掉本机保存的登录态（分享前用） |
| `--list, -l` | 只列识别到的媒体，不下载 |
| `-f, --file <文件>` | 从文件读链接，一行一条 |
| `--out-dir <目录>` | 输出目录（配合自动命名） |
| `-N, --name <模板>` | 文件名模板，默认 `{user}_{date}_{dur}s` |
| `--user <名字>` | 手动指定 `{user}` 的值（链接里没有用户名时用） |
| `--headful` | 显示浏览器窗口（排查用） |
| `--profile <目录>` | 换一个配置目录 |
| `--browser <exe>` | 指定 Edge / Chrome 路径 |
| `--proxy <url>` | 指定代理，默认读 `HTTPS_PROXY` |
| `--timeout <毫秒>` | 抓取超时，默认 45000 |
| `--force` | 同名重新下载 |
| `--login-wait <分钟>` | 等登录的时间，默认 10 |

### 命名占位符

| 占位符 | 含义 | 例子 |
|---|---|---|
| `{user}` | 作者用户名 | `someuser` |
| `{date}` `{time}` | 下载日期 / 时分秒 | `2026-01-15` / `082650` |
| `{dur}` | 时长（秒） | `8` |
| `{asset}` | `efg` 里的 `xpv_asset_id` | `1234567890123456` |
| `{shortcode}` | 链接里的短码 | `CxAbCdEfGh1` |
| `{vbr}` | 视频码率（kbps） | `731` |
| `{w}` `{h}` | 分辨率（从 mp4 的 `avc1` 里读） | `720` / `1280` |
| `{tag}` | 编码档位 tag | `dash_baseline_1_v1` |

`{user}` 和 `{shortcode}` 只能从**页面链接**里取（CDN 地址里没有用户名），所以想让它们有值，就把页面链接一起传给脚本；或者用 `--user <name>` 手动指定。

### 手动路线（自动模式失灵时）

浏览器里打开那条 Reel，等它播起来 → F12 → Network → 筛 `mp4` → 全选复制 → 粘进脚本：

```powershell
node igd.mjs --from dump.txt --out-dir downloads   # 自动挑轨、下载、合轨、命名
node igd.mjs --from dump.txt --list                # 先看认出了哪些
node igd.mjs --clip --out-dir downloads            # 读剪贴板
node igd.mjs --video "<m86>" --audio "<m78>" -o reel.mp4   # 手动指定两条轨
```

`bytestart` / `byteend` 不用删，脚本自己会去掉。

---

## 关于 ffmpeg

**仓库里不带 `ffmpeg.exe`**（105 MB，不适合当提交物）。程序在真正需要合轨时才去找，顺序：

1. `--ffmpeg <路径>`、环境变量 `FFMPEG` / `FFMPEG_PATH`
2. 工具目录的 `ffmpeg.exe`（或 `bin\ffmpeg.exe`）
3. `%USERPROFILE%\.x-ins-video\ffmpeg.exe`（工具目录不可写时放这儿）
4. `PATH` 里的 `ffmpeg`
5. 都没有 → **自动下载**一份静态版（约 105 MB，只下载这一次）

```powershell
node get-ffmpeg.mjs          # 需要就下
node get-ffmpeg.mjs --check  # 只看有没有
node get-ffmpeg.mjs --force  # 重新下
```

不想让它自动下载：加 `--no-fetch`，或设 `IGD_NO_FETCH=1`。

> 下载下来的 ffmpeg 来自 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)（GPL 构建），版权归其作者，本仓库不分发该二进制。

---

## 关于代理

在中国大陆网络下，`video.twimg.com` 和 `cdninstagram.com` 往往直连不通。

- **X 取直链**只访问 `api.fxtwitter.com`，一般能通；
- **真正下载**和 **Instagram 全流程**通常必须走代理。

脚本会自动检测：有 `HTTPS_PROXY` / `HTTP_PROXY` 且当前没开 `--use-env-proxy` 时，带该参数重启自己。`--proxy auto` 会扫常见端口（7890 / 7897 / 2080 / 8889 / 10809 / 4780 / 33210 / 7891）。

> `--use-env-proxy` 需要 **Node 24+**。Node 22 上会明确报错，而不是悄悄失败。

---

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 输入有问题（链接认不出 / 文件找不到 / 剪贴板空） |
| 3 | 接口都失败（推文被删 / 私密 / 网络不通） |
| 4 | 没有视频 / 没抓到媒体 |
| 5 | 下载失败 |
| 6 | 部分失败 / 需要登录 / 登录态失效 |
| 7 | 浏览器起不来 / 缺 ffmpeg / 代理或 Node 版本问题 |

---

## 隐私

- 工具里**不含任何账号信息**。
- Instagram 登录态只存在本机的 `.ig-browser\` 目录里，不会上传到任何地方。
- 下载时输入的链接会短暂写到系统临时目录当命令行参数，**任务结束就删**；服务启动时还会清理 10 分钟前的旧文件。
- **分享给别人之前**，跑一次 `node igauto.mjs --logout`（或界面上点「清除本机登录态」）。它会把 cookie（含 HttpOnly 的 `sessionid`）、localStorage、IndexedDB 全部清掉，并把整个 `.ig-browser\` 目录删除，连带浏览历史和缓存。跑完打印「已删除整个配置目录」就干净了。

对方拿到后第一次用时登录的是**他自己的**账号，登录态只存在他电脑上。

---

## 已知限制

- Instagram **必须登录过一次**，这是平台侧的硬限制，不是本工具的取巧。
- Instagram 自动模式需要一个**能正常启动浏览器的环境**。如果日志里出现「浏览器没有起来」或「拒绝访问 (0x5)」，说明当前环境禁掉了子进程的命名管道（某些沙箱式终端会这样），改成从资源管理器直接双击 `ui.cmd` 即可。
- 拿到的是带签名（`oh` / `oe`）的临时地址，约几小时后过期。脚本每次现抓现用，正常流程不会碰到。
- 多图帖、纯文字帖没有视频轨，会报「抓到了地址但挑不出可用的视频轨」。
- 同一个视频有多档音频时取码率最高的那条。
- X 侧不支持从**账号主页**批量扒推文——只处理给定的链接（`api.fxtwitter.com/<用户名>` 只返回用户资料，不含时间线）。
- X 侧走的是第三方公开镜像（[fxtwitter](https://github.com/FixTweet/FxTwitter) / vxtwitter）。镜像只返回**地址清单**，字节仍然从 `video.twimg.com` 直取，不转码、不二次压缩。镜像挂了会导致 X 功能一次性失效（脚本有主备切换）。

---

## 免责声明

本工具仅供**个人学习、研究，以及下载你有权保存的内容**（自己的作品、已获授权的内容、明确允许下载的内容）使用。

- 请遵守你所访问平台的服务条款与当地法律。
- 请勿用于批量抓取、二次分发或任何侵犯版权与他人权益的用途。
- 使用者对自己的行为负责，作者不对因使用本工具产生的任何后果承担责任。

如果内容作者或平台方认为本项目不妥，请开 issue，会及时处理。

---

## License

[MIT](LICENSE)
