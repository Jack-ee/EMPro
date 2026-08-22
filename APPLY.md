# EMPro v107 — 修复性发布：还原 v106 + 嫁接 Daily Reading

## 事故说明
v100–v102 三个交付包基于 8 月 10 日的陈旧快照（v98）构建，解压时
覆盖了你 v99–v106 的全部工作（Stories 模块入口、分包实现、语音链、
句子音色策略）。本包以 Git 历史中的 6cfb8a7（v106）为基底整体还原，
仅把 Daily Reading 重新嫁接上去；我此前的分包实现全部废弃，
生成器、tts-pack、audio-pack workflow 均为你的 v106 原版字节。

## 好消息
线上 audio-pack release 始终是你的 p 段格式（p00001-00080 等），
音频数据完好，无需重跑构建，恢复客户端后即可正常播放。

## 操作
1. 解压覆盖到仓库根目录。
2. 手动删除 test/test-audio-pack-parts.js（我旧包引入的重复测试，
   ZIP 无法删除文件）。
3. GitHub Desktop 提交推送。CI（tests.yml）会自动跑你的全部套件
   + 新挂入 npm test 的 feeds 套件。
4. empro-tts-proxy.js 全文重新粘贴到 Cloudflare Worker → Deploy
   （合并版：保留你的 sha 不可变缓存策略 + Daily Reading 三路由；
   GUARDIAN_API_KEY 已配置的保持不动）。
5. 手机刷新两次到 emp-v107。若个别词仍是本地音，在设置里点一次
   音频包下载让客户端按自己的记录对账即可。

## 本包文件
还原你的原版：tts-pack.js、tools/generate_audio_pack.py、
.github/workflows/audio-pack.yml、.github/workflows/tests.yml
嫁接改动：index.html（Reader 子页签 + 面板 + 阅读窗，21 处 v107）、
app.js（+1 行 boot 钩子）、sw.js（+预缓存与 v107）、style.css（+rf 样式）、
empro-tts-proxy.js（合并）、package.json（test:feeds）
新增：reading-feeds.js、test/test-reading-feeds.js
