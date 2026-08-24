# NotebookLM 音频 · Google Drive 模式配置指南（EMPro v117+）

整条链路：你的 PC（有代理）把 NotebookLM 音频放进一个公开分享的
Drive 文件夹 → EMPro 通过 Cloudflare Worker 代理列出并下载文件 →
手机/平板全程无需代理。API 密钥只存于 Worker，客户端永远拿不到。

一次性配置约 15 分钟，分四段。

---

## 第一段：Google Cloud 创建 API 密钥（PC，需代理）

1. 打开 console.cloud.google.com，用你的 Google 账号登录。
2. 顶栏项目选择器 → 「新建项目」→ 名称随意（如 EMPro）→ 创建，
   并切换到该项目。（已有项目可直接复用。）
3. 左侧菜单 → 「API 和服务」→ 「库」→ 搜索 **Google Drive API**
   → 点进去 → 「启用」。
4. 「API 和服务」→ 「凭据」→ 「+ 创建凭据」→ **API 密钥**。
   弹窗立即显示密钥（AIza 开头），复制保存。
5. 【建议】点密钥旁「修改 API 密钥」做两个限制，防止泄露被盗刷：
   - API 限制 → 「限制密钥」→ 只勾选 Google Drive API；
   - 应用限制保持「无」（请求来自 Cloudflare 服务器，IP 不固定，
     不要设 IP 限制，否则会被拒）。
6. 全程免费：Drive API 只读公开文件不产生费用，无需绑卡。

## 第二段：准备 Drive 文件夹（PC，需代理）

1. drive.google.com → 新建文件夹，如 `EMPro-Audio`。
2. 把 NotebookLM 导出的音频拖进去。
   - NotebookLM 的音频概览默认导出 **wav，动辄 50 MB+**；建议先用
     任意工具转成 mp3（体积约十分之一，弱网下载快得多，App 的
     200 MB 离线缓存也能多存几集）。
3. 右键文件夹 → 「共享」→ 「常规访问权限」改为
   **「知道链接的任何人」· 查看者** → 完成。
   （必须设在文件夹上，之后放入的新文件自动继承，不用逐个设置。）
4. 双击进入该文件夹，从浏览器地址栏复制文件夹 ID——即
   `.../folders/` 后面那串字符，形如：
   `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv`
   ID 就是 `1AbCdEfGhIjKlMnOpQrStUv`。

## 第三段：Worker 配置密钥（PC）

1. Cloudflare 控制台 → Workers & Pages → **empro-tts** →
   Settings → Variables and Secrets → Add。
2. Type 选 **Secret**；Name 填 `GOOGLE_API_KEY`（全大写下划线，
   一字不差）；Value 粘贴第一段的密钥 → 保存。
3. 保存后按提示 **Deploy** 一次——环境变量必须随部署注入，
   不部署不生效（Guardian key 当时同款流程）。
4. 前提确认：v117+ 的 empro-tts-proxy.js 已粘贴部署过
   （含 ?drive 路由）。若不确定，重新粘贴最新版再 Deploy 即可。

## 第四段：App 添加源（手机）

1. News 页 → ⚙ → 文本框末尾加一行（竖线两侧空格随意）：

       NotebookLM 播客 | drive:1AbCdEfGhIjKlMnOpQrStUv

2. Save sources → 源胶囊栏出现蓝色 **NLM** 徽章。
3. 点击该胶囊 → 列表按修改时间倒序显示文件夹里的音频，
   条目带 🎧 徽章和文件大小。
4. 点一条 → 进度实时显示（v118 起分块下载，弱信号断线只重试
   当前 3 MB 块）→ 下载完弹出播放窗，息屏、锁屏控制照常。

---

## 验证与排错

| 现象 | 原因与处理 |
| --- | --- |
| GOOGLE_API_KEY is not set | Worker 没配密钥，或配了没 Deploy |
| HTTP 403 | Drive API 未启用，或密钥的 API 限制没勾 Drive API |
| HTTP 404 或列表为空 | 文件夹没设「知道链接的任何人」，或 ID 复制不全 |
| Bad folder id | 源行里的 ID 混入了多余字符（如 ?usp=sharing 尾巴） |
| 列表有但全无条目 | 文件夹里没有音频类文件（只认 audio/* 与 mp3/m4a/wav/aac/ogg 后缀） |

快速自检（部署完在任意浏览器打开，ID 换成你的）：

    https://empro-tts.bangqian-chen.workers.dev/?drive=list&folder=文件夹ID

返回含 "files" 的 JSON 即全链路通；返回上表中的错误文字则按表处理。

## 日常使用

生成播客（有代理）→ 拖进 Drive 文件夹（同一会话顺手的事）→
手机端点开 NLM 胶囊 Refresh 即见新文件，无需任何其他操作。
删除旧音频直接在 Drive 里删即可，列表随 Refresh 同步。
