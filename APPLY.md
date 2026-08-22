# EMPro v102 — 音频分包 + 每日阅读·原速音频（合并交付）

本包同时包含 v99（音频分包）与 v100（Daily Reading）两轮改动，
解压覆盖到仓库根目录即可（无外层文件夹）。

## 文件清单
- index.html / sw.js / app.js / style.css — 版本升至 v100，接入新模块
- reading-feeds.js — 新增：Reader 页签内的 Daily Reading（按需下载）
- tts-pack.js — 分包差量下载 + sha256 校验 + manifest 绕缓存
- tools/generate_audio_pack.py — 按词块切分分包，v2 顶层清单
- .github/workflows/audio-pack.yml — 发布分包 + 清理旧资产
- empro-tts-proxy.js — Worker v3：?fetch / ?media / ?guardian 三个新路由
- test/test-audio-pack-parts.js / test/test-reading-feeds.js — 测试套件
- .github/workflows/tests.yml — 新增 CI：每次 push 自动跑两套测试
  （fake-indexeddb 在 CI 里安装，本地无需 npm；本地想跑的话在仓库
  根目录 npm i fake-indexeddb 后 node test/test-audio-pack-parts.js）

## 部署顺序（重要）
1. 解压覆盖 → GitHub Desktop 提交推送（App 必须先于分包构建上线）。
2. empro-tts-proxy.js 全文粘贴到 Cloudflare Worker → Deploy。
3. Worker 控制台 Settings → Variables and Secrets 新增
   GUARDIAN_API_KEY（在 open-platform.theguardian.com 免费注册
   Developer key，邮件即发）→ 再次 Deploy。
4. Actions → Build audio pack → Run workflow（手动触发一次分包迁移；
   会下载现有全量包直接切分，不重新合成，随后自动删除旧 full/delta 资产）。
5. 手机端刷新两次让 SW 接管，Reader 页签出现 Daily Reading。

## 音频源（均为原速）
默认源：VOA 三个播客栏目（Worldwide in Five / International Edition /
Issues in the News，RSS 自带每集 MP3，列表直接显示 🎧）+ VOA 两个
文章栏目（下载时自动从文章页挖掘内嵌的原速语音报道，有则附带）+
Guardian 两栏目（纯文字）。工具栏有「🎧 Audio only」过滤开关。
注意：如果之前在 ⚙ 里点过 Save sources，旧列表会盖住新默认——
打开 ⚙ 清空文本框重新保存，或粘贴 APPLY 同目录下最新默认即可。

## 验证要点
- 控制台出现 emp-v100 与 Boot complete
- Reader → Daily Reading：Guardian 列表可刷出；点一篇 → 下载后弹出
  阅读窗，点词入笔记本；断网后"Downloaded"里仍可打开
- VOA 文章带 🎧 徽标的下载后有音频条，可拖动进度
