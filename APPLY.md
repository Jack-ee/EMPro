# EMPro v115 — News 页签（含 v113/v114 全部内容，替代此前两包）

- 导航页签 Reader 更名为 News（📰），打开即是在线资源列表，
  Extract 退为第二子页签；页签内部 id 不变，排序偏好与各模块不受影响。
- 源胶囊自动换行，不再横向截断。
- 纯文字源（Guardian）豁免 Audio only 过滤：直接显示文章并提示
  「Text-only source — audio filter not applied」，不再出现空列表。
- 含 v113（移出 VOA）与 v114（品牌胶囊、真实时长、日期人性化）。

操作：
1. 解压覆盖 → 提交推送；Cloudflare 无需粘贴。
2. ⚙ 删掉两行 VOA 源；删除仓库遗留 test/test-audio-pack-parts.js。
3. 刷两次到 emp-v115。
