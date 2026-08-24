# EMPro v118 — 弱网抗性下载（含 v113—v117 全部内容，替代此前各包）

- Daily Reading 音频（播客与 Drive 文件）改为 3 MB 分块 Range 下载：
  单块失败自动重试 3 次，断线只损失当前块；进度实时显示
  「37% · 12.4/33.0 MB」。不支持 Range 的服务器自动退回整流下载。
- Worker 本版无改动；若 v117 的 ?drive 路由尚未粘贴部署，
  用包内 empro-tts-proxy.js 粘贴一次。
- Drive 模式完整配置流程见 DRIVE-SETUP.md。

操作：解压覆盖 → 提交推送 → 刷两次到 emp-v118。
