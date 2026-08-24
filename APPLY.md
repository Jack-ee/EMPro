# EMPro v116 — News 页去除子页签（含 v113—v115 全部内容，替代此前各包）

- Extract / Daily Reading 两个子页签按钮移除：News 页打开即列表；
  Extract 变为工具栏小按钮，点击弹出提取面板（原粘贴界面原封
  不动地搬进弹层，Reader 模块零改动）；阅读窗的一键提取直接
  弹出该面板。
- 含 v113（移出 VOA）、v114（品牌胶囊/真实时长）、v115（News
  页签/胶囊换行/文字源豁免过滤）。

操作：
1. 解压覆盖 → 提交推送；Cloudflare 无需粘贴。
2. ⚙ 删掉两行 VOA 源；删除仓库遗留 test/test-audio-pack-parts.js。
3. 刷两次到 emp-v116。
