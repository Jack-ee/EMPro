# EMPro v108 — 修复云端构建 17 秒崩溃（Stories 无声的根因）

## 根因
词表头 `# sentence_voice: alloy   (long entries use this voice ...)`
的括号说明被解析成了 15 个"音色"，"(long" 作为 voice 调 OpenAI 立即
致命报错，构建 17 秒中止。故事分包 p10001+ 因此从未被构建发布，
Stories 一直回落设备机器声。

## 修复
- tools/generate_audio_pack.py：音色头解析在 '(' / '#' 处截断，并按
  KNOWN_VOICES 白名单过滤（未知名仅警告丢弃）；selftest 增 4 条回归。
- app.js：词表导出时说明文字改为独立注释行。
- 版本升 v108（index 21 处 / sw CACHE_NAME）。

## 操作
1. 解压覆盖 → 提交推送（本次不含 wordlist，构建不会自动触发）。
2. 【建议】先只建故事分包：在 App 里导出词表前设置 range 为
   10001-10080（或手工在 wordlist.txt 头部加一行
   `# range: 10001-10080`），提交 wordlist → 构建约数分钟完成
   464 条故事剪辑并发布 p10001-10080。
3. 手机进 App 重新下载音频包（只会拉新增的故事分包），Stories
   即有真人语音。
4. 之后去掉 range 行再提交一次 wordlist，让后续构建按时间预算
   分批补齐 p00161-00640 六个词汇分包。
5. 已发布的 p00001-00080 / p00081-00160 原样复用，不会重合成。
