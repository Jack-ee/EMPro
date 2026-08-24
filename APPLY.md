# EMPro v117 — NotebookLM 音频接入（Google Drive 源）
# 含 v113—v116 全部内容，替代此前各包

## 新能力
源编辑器 ⚙ 新增一种源类型：
    NotebookLM 播客 | drive:文件夹ID
指向一个公开分享的 Google Drive 文件夹；其中的音频文件
（NotebookLM 生成的播客、任何 mp3/wav/m4a）会以列表呈现，
点击下载入离线缓存，播放、锁屏控制与播客源完全一致。

## 一次性配置（三步）
1. Google Cloud 控制台（console.cloud.google.com，需代理访问一次）：
   任意项目 → API 与服务 → 启用 "Google Drive API" →
   凭据 → 创建凭据 → API 密钥（免费，无需 OAuth）。
2. Drive 里建文件夹放 NotebookLM 音频，右键共享 →
   「知道链接的任何人 · 查看者」；从文件夹网址复制 ID
   （folders/ 后面那串）。
3. Cloudflare Worker → Settings → Variables and Secrets →
   新增 Secret：GOOGLE_API_KEY = 第 1 步的密钥 → Deploy。

## 部署
1. 解压覆盖 → 提交推送。
2. empro-tts-proxy.js 全文重新粘贴到 Worker → Deploy（本版必须，
   新增了 ?drive 路由）。
3. App ⚙ 里加一行 drive 源并保存；刷两次到 emp-v117。

## 说明
- API key 只存于 Worker 环境，客户端拿不到；文件夹/文件 ID 经
  严格校验，路由无法被用作开放代理。
- 上传文件到 Drive 需在你的 PC（有代理）上进行；家人设备只经
  Worker 取件，无需任何代理。
- NotebookLM 导出的 wav 体积较大（可能 50 MB+），200 MB 缓存
  上限会自动滚动淘汰；介意的话上传前转成 mp3。
- 手工遗留项（若仍未做）：⚙ 删两行 VOA；仓库删
  test/test-audio-pack-parts.js。
