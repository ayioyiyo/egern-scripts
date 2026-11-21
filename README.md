# Egern Scripts

Egern 定时脚本集合（ayioyiyo）。

---

## 星驰API公益站 自动签到

站点：https://api.xingchiapi.com ｜ 每日 +300 额度，0 点（UTC+8）刷新

两个文件配合工作：

| 文件 | 类型 | 作用 |
|---|---|---|
| `xingchi_capture.js` | http_response | 浏览器登录/续期时截获 `refresh_token`，验证后存入 Egern 存储，然后**自动停机** |
| `xingchi_checkin.js` | schedule | 每天读存储里的登录态调签到接口 |

### 为什么要「抓取」

站点登录接口开了 Cloudflare Turnstile 人机验证，纯脚本无法用邮箱密码登录。
所以只能复用浏览器登录后产生的 `refresh_token`（RT）来换 access_token。

站点 RT 是**一次性轮换**的：每次刷新都换发新 RT，旧的立刻作废。
`xingchi_capture.js` 抓一次并验证，之后所有续期都由 `xingchi_checkin.js` 独占地做，
链条不会断；就算断了，签到脚本失败时会自动重新武装抓取脚本，你下次登录浏览器就自动续上。

### 部署步骤（一次性，3 分钟）

#### 1. 装 CA + 开 MITM（抓取需要）

- Egern → 工具 → 证书 → 生成新证书 → 安装并信任（设置 → 通用 → 关于 → 证书信任设置）
- Egern → 全部连接 → 右上角 `...` → 开启 **全局 MITM**（或确保 MITM 主机名包含 `api.xingchiapi.com`）

#### 2. 添加「HTTP 请求脚本」（抓 access_token）

Egern → 工具 → 脚本 → `+` → 类型选 **http_request（HTTP 请求脚本）**

| 项 | 值 |
|---|---|
| 名称 | `星驰Token抓取` |
| 匹配 | `^https://api\.xingchiapi\.com` |
| 脚本 URL | `https://raw.githubusercontent.com/ayioyiyo/egern-scripts/main/xingchi_capture.js` |
| 需要请求体 | 开启 |
| 超时 | 30 |

#### 3. 添加「HTTP 响应脚本」（抓 refresh_token）

Egern → 工具 → 脚本 → `+` → 类型选 **http_response（HTTP 响应脚本）**

| 项 | 值 |
|---|---|
| 名称 | `星驰Token抓取（响应）` |
| 匹配 | `^https://api\.xingchiapi\.com/api/v1/auth/` |
| 脚本 URL | `https://raw.githubusercontent.com/ayioyiyo/egern-scripts/main/xingchi_capture.js` |
| 需要响应体 | 开启 |
| 超时 | 30 |

> ⚠️ **Egern 脚本文件默认缓存 24 小时。** 每次改动脚本后，
> 必须到「工具 → 脚本」里手动点一下刷新，否则改动不会生效。
> 这是最容易踩的坑。

#### 4. 添加「定时脚本」

Egern → 工具 → 脚本 → `+` → 类型选 **schedule（定时脚本）**

| 项 | 值 |
|---|---|
| 名称 | `星驰API签到` |
| Cron | `5 8 * * *` |
| 脚本 URL | `https://raw.githubusercontent.com/ayioyiyo/egern-scripts/main/xingchi_checkin.js` |
| 超时 | 60 |
| 环境变量 | **可以不填**，靠抓取自动获得 |

> 想手动指定账号可以加 env `XINGCHI_REFRESH_TOKEN=rt_xxx` 和 `XINGCHI_EMAIL=xxx@x.com`。

#### 5. 触发一次抓取

手机上用 Safari（或任意浏览器，只要走 Egern 代理并 MITM 生效）打开
`https://xingchiapi.com/dashboard`，**登录一次**（或退出重登）。

验证是否被 MITM 接管：登录时打开 Egern → 全部连接（Requests），
应能看到 `api.xingchiapi.com/api/v1/auth/login` 或 `/auth/refresh`。如果看不到，
说明请求没有走 Egern 或证书/MITM 未生效。

看到通知「**星驰Token已抓取**」就完成了。之后每天 08:05 自动签到。

### 「抓一次就停」是怎么保证的

1. 存储键 `xingchi_capture_done = "1"` 时，抓取脚本第一行直接 return，零请求零开销；
2. 只有 RT **当场刷新验证成功**才落库并置停机标记（失效 RT 一律放行，继续等下一个）；
3. 停机标记**最后写**，保证先有可用种子再停机；
4. 签到脚本认证彻底失败时，会**自动删掉这个标记**重新武装抓取 —— 下次浏览器登录即自愈，不需要你进去点任何东西。

### 换账号 / 手动重置

删 Egern 持久化存储里的这两个键，再登录一次：

- `xingchi_capture_done`
- `xingchi_auth:captured`

### 已知限制

- 首次抓取必须**你本人在浏览器里登录一次**（Turnstile 无法脚本绕过）；
- 抓取脚本验证时会消费掉浏览器那份 RT，浏览器下次续期会被登出 —— 无所谓，登录态已归签到脚本；
- 若长期不打开浏览器且 RT 链条被外部打断（例如在网页上又登录了一次），
  签到会失败并通知你"重新开启抓取"，按提示登录一次即可。

### 多账号

用 `XINGCHI_ACCOUNTS`（JSON 数组）替代单账号 env，抓取的账号会自动并入，不冲突：

```json
[{"name":"主号","email":"a@x.com","refresh_token":"rt_xxx"},
 {"name":"小号","email":"b@x.com","password":"pwd","refresh_token":"rt_yyy"}]
```

## v9 变更

- **令牌持久化加固（本轮新增）**
  - 保留最近 2 个旧的 refresh_token 作为备份
  - 主 RT 失效时自动用备份恢复，避免整条登录链断掉
  - 抓取脚本接受浏览器回灌的最新 RT，并把旧值留档备份

- **抓取开关改为模块原生 Toggle**
  - 模块设置页新增「抓取令牌」开关（`env_schema`），开关是 `on` / `off`
  - 不再需要 `xingchi_toggle.js` 脚本，该文件已删除
  - 关闭后抓取脚本完全不拦截任何请求，签到照常运行
- **解决通知延迟**
  - 之前 `http_request` 匹配了整个域名，页面每次加载静态资源都会触发脚本，
    脚本排队执行导致通知迟到
  - 现在只匹配鉴权相关路径：`/api/v1/auth/` 与 `/api/v1/user/`
  - 静态资源、页面、图片一律不触发
- 签到通知显示账户余额
- 修复只有 access_token、没有 refresh_token 时误报“尚未获取到登录态”

## v5 变更

- 新增抓取开关：`xingchi_capture_enabled`
  - 存储里设为 `0` 即关闭抓取，抓取脚本直接放行不再拦截
  - 新增 `xingchi_toggle.js`（generic 脚本），运行一次切换开/关，通知里显示当前状态
  - 抓取脚本自身也支持在模块/脚本 env 里设 `XINGCHI_CAPTURE=off` 永久关闭
  - 签到脚本检测到登录态彻底失效时，会自动把开关重新打开以便下次登录被捕获
- 签到通知增加账户余额（调用 `GET /api/v1/user/profile`）
- 修复只有 access_token、没有 refresh_token 时误报“尚未获取到登录态”的问题

## v4 变更

- API 域名同时覆盖 `xingchiapi.com` 与 `api.xingchiapi.com`。
  站点前端页面在 `xingchiapi.com`，而 `api_base_url` 指向 `api.xingchiapi.com`，
  两个域名都会出现带 `Authorization` 的请求，之前只匹配后者会漏抓。
- 所有脚本名 / 通知标题 / 模块名加入版本号，便于确认设备上的脚本是否为最新。
