# EMPro v109 — NPR 音频白名单修复

根因：NPR 音频链第一跳换成了 prfx.byspotify.com，Worker 白名单不认，
?media 返回 400，App 静默降级纯文字。

操作：
1. 解压覆盖 → 提交推送。
2. empro-tts-proxy.js 重新粘贴到 Cloudflare Worker → Deploy（必须）。
3. 手机刷两次到 emp-v109，删掉之前无声的那篇，重新点击下载。
4. 之后音频若再失败会弹出带 HTTP 状态码的提示，截图即可定位。
