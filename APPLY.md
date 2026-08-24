# EMPro v114 — Reader 界面焕新（已并入 v113 移出 VOA，替代 v113 包）

- 源选择改为品牌胶囊栏：NPR 红 / BBC 黑 / Guardian 蓝字标，
  点击切换；自行添加的源自动生成首字母徽章与配色。
- 播客条目显示真实单集时长（解析 itunes:duration，如 24 min），
  不再显示按简介字数误算的 ~1 min；阅读时长仅用于纯文字条目。
- 日期显示 Today / Yesterday；已下载列表带源徽章。
- 含 v113 全部内容：VOA 移出默认源及其专属机制、失败原因常驻
  状态栏、仓库版 Worker 与线上对齐。

操作：
1. 解压覆盖 → 提交推送（若已推过 v113 也可直接覆盖，兼容）。
2. Cloudflare 无需重新粘贴。
3. ⚙ 里删掉两行 VOA 源；删除仓库遗留 test/test-audio-pack-parts.js。
4. 刷两次到 emp-v114。
