# EMPro v110 — feed 解析三修（含 v109 白名单，一并部署）

1. 解压覆盖 → 提交推送。
2. empro-tts-proxy.js 重新粘贴 Cloudflare Worker → Deploy
   （含 v109 的 byspotify/simplecast 白名单，若已粘贴过 v109 也无妨）。
3. 手机刷两次到 emp-v110。
4. News Now / BBC 刷新应出列表且带 audio 徽标；之前无声的 Up First
   条目直接再点一次——缓存无音频而 feed 声明有音频时会自动重下补齐。
