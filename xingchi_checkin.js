/**
 * 星驰API公益站 每日自动签到 · Egern 定时脚本
 * 【版本 v6】
 * 站点：https://api.xingchiapi.com
 *
 * 用法（Profile.yaml，放在 scriptings 里）：
 *   scriptings:
 *     - schedule:
 *         name: "星驰API 签到"
 *         cron: "5 8 * * *"
 *         script_url: "<脚本地址>"
 *         timeout: 60
 *         env:
 *           XINGCHI_EMAIL: "your@email.com"
 *           XINGCHI_PASSWORD: "******"
 *           XINGCHI_REFRESH_TOKEN: "rt_****"
 *
 * 说明：
 *  - 站点登录接口开启了 Cloudflare Turnstile，纯脚本无法完成人机校验，
 *    所以脚本走「refresh_token 换 access_token」这条路，不需要每次登录。
 *  - 服务端每次刷新都会换发新的 refresh_token（旧的立刻失效），
 *    脚本会把新的写进 Egern 本地存储，下次继续用，链条不断。
 *  - env 里的 XINGCHI_REFRESH_TOKEN 只是「首次启动的种子」；
 *    一旦本地存储里有了更新的 token，优先用本地存储的。
 *  - 若存储里的 token 失效，脚本会回退用 env 里的种子，然后再尝试邮箱密码登录
 *    （Turnstile 关闭时才可能成功）。全部失败会发通知提示重新抓 token。
 *
 * 推荐用法（免手动抓 token）：搭配 xingchi_capture.js（http_response 脚本）。
 * 它在浏览器登录/续期时自动截获 refresh_token，验证后存入存储键 xingchi_auth:captured，
 * 本脚本即使不配任何环境变量也能运行；环境变量仅作兜底/多账号用。
 *
 * 多账号：用 XINGCHI_ACCOUNTS 的 JSON 数组代替单个 XINGCHI_EMAIL，例如
 *   XINGCHI_ACCOUNTS: '[{"name":"主号","email":"a@x.com","password":"p","refresh_token":"rt_x"}]'
 */

const VERSION = "v9";
const DEFAULT_BASE = "https://api.xingchiapi.com";
const STORE_PREFIX = "xingchi_auth:";
const CAPTURED_KEY = "xingchi_auth:captured";
const CAPTURE_ENABLE_KEY = "xingchi_capture_enabled";
const REGISTRY_KEY = "xingchi_accounts"; // xingchi_capture.js 落库的固定键
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const QUOTA_PER_DOLLAR = 500000; // 站点额度单位：500000 额度 = 1 美元

const LOGIN_PATH = "/auth/login";
const REFRESH_PATH = "/auth/refresh";
const CHECKIN_PATH = "/user/checkin";
const PROFILE_PATH = "/user/profile";

/** 通知：优先 Egern ctx.notify，其次 Loon/Surge/QX 全局 */
function notifyMsg(ctx, title, body, subtitle, sound) {
  try {
    if (ctx && typeof ctx.notify === "function") {
      ctx.notify({
        title: title,
        subtitle: subtitle || "",
        body: body,
        sound: sound === undefined ? true : sound,
      });
      return;
    }
  } catch (e) {
    /* 继续尝试兼容写法 */
  }
  try {
    if (typeof $notification !== "undefined") $notification.post(title, subtitle || "", body);
    else if (typeof $notify !== "undefined") $notify(title, subtitle || "", body);
    else console.log(title + " | " + body);
  } catch (e) {
    console.log(title + " | " + body);
  }
}

function envOf(ctx, key) {
  const v = ctx && ctx.env ? ctx.env[key] : undefined;
  return v === undefined || v === null ? "" : String(v).trim();
}

/** 解出 {code,data} 信封里的 data；没有信封时原样返回。 */
function unwrap(payload) {
  if (payload && typeof payload === "object" && "code" in payload && payload.data) {
    return payload.data;
  }
  return payload;
}

function normBase(raw) {
  const b = (raw || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(b) ? b : "https://" + b;
}

function fmtQuota(q) {
  if (typeof q !== "number" || !isFinite(q)) return String(q);
  const usd = q / QUOTA_PER_DOLLAR;
  return q + " 额度（约 $" + usd.toFixed(4) + "）";
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function loadAccounts(ctx) {
  const list = [];
  const raw = envOf(ctx, "XINGCHI_ACCOUNTS");
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const a of arr) {
          if (!a) continue;
          list.push({
            name: String(a.name || a.email || "账号"),
            email: String(a.email || a.username || "").trim(),
            password: String(a.password || "").trim(),
            refresh_token: String(a.refresh_token || a.refreshToken || "").trim(),
            seed_access_token: String(a.access_token || "").trim(),
          });
        }
      }
    } catch (e) {
      throw new Error("XINGCHI_ACCOUNTS 不是合法的 JSON 数组：" + e.message);
    }
  }
  if (!list.length) {
    const email = envOf(ctx, "XINGCHI_EMAIL");
    const password = envOf(ctx, "XINGCHI_PASSWORD");
    const refreshToken = envOf(ctx, "XINGCHI_REFRESH_TOKEN");
    if (email || password || refreshToken) {
      list.push({
        name: email || "账号",
        email: email,
        password: password,
        refresh_token: refreshToken,
        seed_access_token: envOf(ctx, "XINGCHI_ACCESS_TOKEN"),
      });
    } else {
      // 完全无 env：检查抓取脚本是否已落库（单账号键或多账号注册表任一有数据）
      const capOnly = readState(ctx, CAPTURED_KEY);
      const hasLegacy = !!(capOnly && (capOnly.refresh_token || capOnly.access_token));
      let hasRegistry = false;
      try {
        for (const email of readRegistry(ctx)) {
          const st = readState(ctx, "xingchi_auth:" + String(email).toLowerCase().trim());
          if (st && (st.refresh_token || st.access_token)) {
            hasRegistry = true;
            break;
          }
        }
      } catch (e) {
        hasRegistry = false;
      }
      if (!hasLegacy && !hasRegistry) {
        // 没有可用登录态：重新武装抓取脚本，用户下次在浏览器登录时自动续上。
        rearmCapture(ctx);
        throw new Error(
          "尚未获取到登录态，已重新开启抓取脚本。请在手机上打开 https://xingchiapi.com " +
            "登录一次，抓取脚本会自动续上；或填写 XINGCHI_REFRESH_TOKEN 环境变量。"
        );
      }
    }
  }

  // 合并抓取脚本登记的所有账号（多账号）
  try {
    const registry = readRegistry(ctx);
    for (const email of registry) {
      const id = String(email || "").toLowerCase().trim();
      if (!id) continue;
      const key = "xingchi_auth:" + id;
      const st = readState(ctx, key);
      if (!st || (!st.refresh_token && !st.access_token)) continue;
      const existing = list.findIndex((a) => a.email && a.email.toLowerCase() === id);
      if (existing >= 0) {
        list[existing]._key = key;
        if (st.refresh_token) list[existing].refresh_token = st.refresh_token;
        if (st.access_token) list[existing].seed_access_token = st.access_token;
      } else {
        list.push({
          name: id,
          email: id,
          password: "",
          refresh_token: st.refresh_token || "",
          seed_access_token: st.access_token || "",
          _key: key,
        });
      }
    }
  } catch (e) { /* 存储不可用则忽略 */ }

  // 兼容旧的单账号键（升级前抓取脚本写的 xingchi_auth:captured）
  try {
    const cap = readState(ctx, CAPTURED_KEY);
    if (cap && (cap.refresh_token || cap.access_token)) {
      const capEmail = String(cap.email || "").toLowerCase();
      const alreadyListed =
        capEmail && list.some((a) => a.email && a.email.toLowerCase() === capEmail);
      if (!alreadyListed) {
        const i = list.findIndex((a) => a.email && a.email.toLowerCase() === capEmail);
        if (i >= 0) {
          list[i]._key = CAPTURED_KEY;
          if (cap.refresh_token) list[i].refresh_token = cap.refresh_token;
          if (cap.access_token) list[i].seed_access_token = cap.access_token;
        } else {
          list.push({
            name: cap.email || "星驰已捕获账号",
            email: cap.email || "",
            password: "",
            refresh_token: cap.refresh_token || "",
            seed_access_token: cap.access_token || "",
            _key: CAPTURED_KEY,
          });
        }
      }
    }
  } catch (e) { /* 存储不可用则忽略 */ }

  return list;
}

function readRegistry(ctx) {
  let v = null;
  try {
    if (ctx && ctx.storage && typeof ctx.storage.get === "function") v = ctx.storage.get(REGISTRY_KEY);
  } catch (e) { v = null; }
  if (!v) {
    try {
      if (typeof $persistentStore !== "undefined") v = $persistentStore.read(REGISTRY_KEY);
      else if (typeof $prefs !== "undefined") v = $prefs.valueForKey(REGISTRY_KEY);
    } catch (e) { v = null; }
  }
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function readState(ctx, key) {
  let v = null;
  try {
    if (ctx && ctx.storage && typeof ctx.storage.get === "function") {
      v = ctx.storage.get(key);
    }
  } catch (e) {
    v = null;
  }
  if (!v) {
    try {
      if (typeof $persistentStore !== "undefined") v = $persistentStore.read(key);
      else if (typeof $prefs !== "undefined") v = $prefs.valueForKey(key);
    } catch (e) {
      v = null;
    }
  }
  if (!v) return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? o : null;
  } catch (e) {
    return null;
  }
}

/** 重新武装抓取脚本：删掉停机标记，让下次浏览器登录能被再次捕获。 */
function rearmCapture(ctx) {
  const key = "xingchi_capture_done";
  // 重新武装时把抓取开关也打开，确保下次登录能被捕获
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === "function") {
      ctx.storage.set(CAPTURE_ENABLE_KEY, "1");
    } else if (typeof $persistentStore !== "undefined") {
      $persistentStore.write("1", CAPTURE_ENABLE_KEY);
    } else if (typeof $prefs !== "undefined") {
      $prefs.setValueForKey("1", CAPTURE_ENABLE_KEY);
    }
  } catch (e) {
    /* 存储不可用则忽略 */
  }
  try {
    if (ctx && ctx.storage && typeof ctx.storage.delete === "function") {
      ctx.storage.delete(key);
      return;
    }
  } catch (e) {
    /* 继续尝试兼容写法 */
  }
  try {
    if (typeof $persistentStore !== "undefined") $persistentStore.write(null, key);
    else if (typeof $prefs !== "undefined") $prefs.removeValueForKey(key);
  } catch (e) {
    /* 存储不可用则忽略 */
  }
}

function writeState(ctx, key, state) {
  const text = JSON.stringify(state);
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === "function") {
      ctx.storage.set(key, text);
      return;
    }
  } catch (e) {
    /* 继续尝试兼容写法 */
  }
  try {
    if (typeof $persistentStore !== "undefined") $persistentStore.write(text, key);
    else if (typeof $prefs !== "undefined") $prefs.setValueForKey(text, key);
  } catch (e) {
    /* 写不进就算了，下次仍可用 env 种子 */
  }
}

async function request(ctx, url, method, body, token) {
  const headers = {
    Accept: "application/json",
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const payload = body === undefined ? undefined : JSON.stringify(body);

  // 路径 1：Egern 原生 ctx.http
  if (ctx && ctx.http && typeof ctx.http[method] === "function") {
    let resp;
    try {
      resp = await ctx.http[method](url, {
        headers,
        body: payload,
        timeout: 20000,
        redirect: "follow",
      });
    } catch (e) {
      return { ok: false, status: 0, data: null, error: "网络错误：" + (e && e.message ? e.message : e) };
    }
    let data = null;
    let text = "";
    try {
      text = await resp.text();
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, data: data, text: text };
  }

  // 路径 2：Loon / Surge / Quantumult X 的 $httpClient
  // Loon/Surge: $httpClient.get({url,headers,timeout}, callback)
  // data 回调参数即响应体字符串。
  if (typeof $httpClient !== "undefined" && typeof $httpClient[method] === "function") {
    return new Promise(function (resolve) {
      const options = { url: url, headers: headers, timeout: 20000 };
      if (payload !== undefined) options.body = payload;
      $httpClient[method](options, function (error, response, data) {
        if (error) {
          resolve({ ok: false, status: 0, data: null, error: "网络错误：" + (error && error.message ? error.message : error) });
          return;
        }
        const status = Number((response && (response.status || response.statusCode)) || 0);
        const text = typeof data === "string" ? data : JSON.stringify(data == null ? null : data);
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (e) {
          parsed = null;
        }
        resolve({ ok: status >= 200 && status < 300, status: status, data: parsed, text: text });
      });
    });
  }

  return { ok: false, status: 0, data: null, error: "当前环境没有可用的 HTTP 客户端" };
}

function errText(r) {
  if (!r) return "未知错误";
  if (r.error) return r.error;
  if (r.data && (r.data.message || r.data.reason)) {
    return r.data.message + (r.data.reason ? " (" + r.data.reason + ")" : "");
  }
  const t = (r.text || "").replace(/\s+/g, " ").slice(0, 120);
  return "HTTP " + r.status + (t ? " " + t : "");
}

/** 用 refresh_token 换 access_token，成功则返回 {access_token, refresh_token, expires_in} */
async function doRefresh(ctx, api, refreshToken) {
  if (!refreshToken) return null;
  const r = await request(ctx, api + REFRESH_PATH, "post", { refresh_token: refreshToken });
  if (!r.ok) return null;
  const d = unwrap(r.data) || {};
  if (!d.access_token) return null;
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token || refreshToken,
    expires_in: Number(d.expires_in) || 86400,
  };
}

/** 邮箱密码登录（站点开启 Turnstile 时会失败，作为兜底） */
async function doLogin(ctx, api, email, password) {
  if (!email || !password) return null;
  const r = await request(ctx, api + LOGIN_PATH, "post", { email: email, password: password });
  if (!r.ok) return { error: errText(r) };
  const d = unwrap(r.data) || {};
  if (!d.access_token) return { error: "登录响应里没有 access_token" };
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token || "",
    expires_in: Number(d.expires_in) || 86400,
  };
}

async function resolveAuth(ctx, api, acc, key, args_invalid) {
  const state = readState(ctx, key) || {};
  const notes = [];

  // 1) 本地还有没过期的 access_token 就直接用
  //    没有 expires_at 时也先用着，失败后会自动续期。
  if (state.access_token && (!state.expires_at || Number(state.expires_at) - 120 > nowSec())) {
    return { token: state.access_token, notes: notes, state: state };
  }
  // 1b) 抓取脚本存下的 access_token 作为种子
  //     注意：若该值刚被服务端判定失效（本函数被重试调用时会传入 invalidTokens），
  //     不要再用，直接走刷新流程。
  const invalid = Array.isArray(args_invalid) ? args_invalid : [];
  if (
    acc.seed_access_token &&
    acc.seed_access_token !== state.access_token &&
    invalid.indexOf(acc.seed_access_token) < 0
  ) {
    notes.push("使用抓取到的 access_token");
    return { token: acc.seed_access_token, notes: notes, state: state };
  }

  // 2) 依次尝试刷新：本地存储的 token 优先，env 种子其次
  const candidates = [];
  if (state.refresh_token) candidates.push(state.refresh_token);
  if (acc.refresh_token && acc.refresh_token !== state.refresh_token) candidates.push(acc.refresh_token);
  for (const rt of candidates) {
    const got = await doRefresh(ctx, api, rt);
    if (got) {
      const prevTokens = Array.isArray(state.prev_refresh_tokens) ? state.prev_refresh_tokens.slice(0, 2) : [];
      if (state.refresh_token && state.refresh_token !== got.refresh_token && prevTokens.indexOf(state.refresh_token) < 0) {
        prevTokens.unshift(state.refresh_token);
      }
      const next = {
        refresh_token: got.refresh_token,
        access_token: got.access_token,
        expires_at: nowSec() + got.expires_in,
        email: acc.email || state.email || "",
        prev_refresh_tokens: prevTokens.slice(0, 3),
        updated_at: nowSec(),
      };
      writeState(ctx, key, next);
      return { token: got.access_token, notes: notes, state: next };
    }
    notes.push(rt === state.refresh_token ? "本地 refresh_token 已失效" : "env refresh_token 已失效");
  }

  // 2b) 历史 token 兜底：服务端轮换竞态时旧令牌可能只是被抢先作废
  const history = Array.isArray(state.prev_refresh_tokens) ? state.prev_refresh_tokens : [];
  for (const oldRt of history) {
    const got = await doRefresh(ctx, api, oldRt);
    if (got) {
      const next = {
        refresh_token: got.refresh_token,
        access_token: got.access_token,
        expires_at: nowSec() + got.expires_in,
        email: acc.email || state.email || "",
        prev_refresh_tokens: [],
        updated_at: nowSec(),
      };
      writeState(ctx, key, next);
      notes.push("已用备用令牌续期");
      return { token: got.access_token, notes: notes, state: next };
    }
  }

  // 3) 兜底：邮箱密码登录
  if (acc.email && acc.password) {
    const got = await doLogin(ctx, api, acc.email, acc.password);
    if (got && got.access_token) {
      const next = {
        refresh_token: got.refresh_token || state.refresh_token || "",
        access_token: got.access_token,
        expires_at: nowSec() + got.expires_in,
        email: acc.email,
        updated_at: nowSec(),
      };
      writeState(ctx, key, next);
      notes.push("已通过邮箱密码重新登录");
      return { token: got.access_token, notes: notes, state: next };
    }
    notes.push("密码登录失败：" + ((got && got.error) || "未知原因"));
  }
  return { token: null, notes: notes, state: state };
}

/**
 * 登录态健康度。
 * 服务端不下发 refresh_token 有效期，因此只能本地观测：
 * 记录首次建立时间、最近一次成功使用时间、连续成功次数。
 */
function readHealth(ctx, key) {
  const st = readState(ctx, key) || {};
  const health = st.health && typeof st.health === "object" ? st.health : {};
  return {
    first_seen: Number(health.first_seen) || 0,
    last_ok: Number(health.last_ok) || 0,
    ok_count: Number(health.ok_count) || 0,
    backup_left: Array.isArray(st.prev_refresh_tokens) ? st.prev_refresh_tokens.length : 0,
  };
}

function updateHealth(ctx, key, ok) {
  const st = readState(ctx, key) || {};
  const health = st.health && typeof st.health === "object" ? st.health : {};
  const now = nowSec();
  if (ok) {
    if (!health.first_seen) health.first_seen = now;
    health.last_ok = now;
    health.ok_count = (Number(health.ok_count) || 0) + 1;
  }
  st.health = health;
  writeState(ctx, key, st);
}

function healthText(ctx, key) {
  const h = readHealth(ctx, key);
  if (!h.last_ok) return "";
  const days = Math.max(0, Math.floor((nowSec() - h.first_seen) / 86400));
  const idleDays = Math.floor((nowSec() - h.last_ok) / 86400);
  const parts = [];
  if (days > 0) parts.push("已连续 " + days + " 天");
  if (h.ok_count > 1) parts.push("第 " + h.ok_count + " 次成功");
  if (h.backup_left > 0) parts.push("备用令牌 " + h.backup_left + " 个");
  if (idleDays >= 3) parts.push("⚠️ 距上次成功已 " + idleDays + " 天");
  return parts.join("｜");
}

/** 查询账户余额，格式化成 "$xx.xx" 或空字符串 */
async function fetchBalance(ctx, api, token) {
  try {
    const r = await request(ctx, api + PROFILE_PATH, "get", undefined, token);
    if (!r.ok) return "";
    const d = unwrap(r.data) || {};
    const balance = Number(d.balance);
    if (!Number.isFinite(balance)) return "";
    return "$" + balance.toFixed(2);
  } catch (e) {
    return "";
  }
}

async function runOne(ctx, api, acc) {
  const key = acc._key || STORE_PREFIX + (acc.email || acc.name || "default").toLowerCase();
  const auth = await resolveAuth(ctx, api, acc, key);
  if (!auth.token) {
    // 自愈：登录态完全断了就重新武装抓取脚本，用户下次在浏览器登录时自动抓新 token
    rearmCapture(ctx);
    return {
      ok: false,
      name: acc.name,
      message:
        "登录态已失效（" + auth.notes.join("；") + "）。已重新开启抓取：请在手机上打开 " +
        api.replace(/\/api\/v1$/, "") +
        " 登录一次，抓取脚本会自动续上，明天起恢复正常。",
    };
  }

  const status = await request(ctx, api + CHECKIN_PATH, "get", undefined, auth.token);
  if (status.status === 401) {
    // token 被服务端作废（例如在别处退出登录），清掉本地 access_token 后重试一次
    const st = readState(ctx, key) || {};
    delete st.access_token;
    delete st.expires_at;
    writeState(ctx, key, st);
    const retry = await resolveAuth(ctx, api, acc, key, [auth.token]);
    if (!retry.token) {
      // 自愈：重新武装抓取脚本，用户下次在浏览器登录时自动抓新 token
      rearmCapture(ctx);
      return {
        ok: false,
        name: acc.name,
        message:
          "登录态已失效（" + retry.notes.join("；") + "）。已重新开启抓取：" +
          "请在手机上打开 " + api.replace(/\/api\/v1$/, "") +
          " 登录一次，抓取脚本会自动续上，明天起恢复正常。",
      };
    }
    auth.token = retry.token;
  }

  const st2 = await request(ctx, api + CHECKIN_PATH, "get", undefined, auth.token);
  if (!st2.ok) {
    return { ok: false, name: acc.name, message: "查询签到状态失败：" + errText(st2) };
  }
  // 后端返回 {code:0,data:{...}} 信封，浏览器端由 axios 拦截器解包；
  // Egern 直接拿到原始体，这里自行解包。
  const info = unwrap(st2.data) || {};
  if (info.enabled === false) {
    return { ok: true, name: acc.name, message: "站点未开启签到，本次跳过", claimed: false };
  }
  if (info.claimed_today) {
    const balanceText = await fetchBalance(ctx, api, auth.token);
    updateHealth(ctx, key, true);
    const health = healthText(ctx, key);
    return {
      ok: true,
      name: acc.name,
      claimed: false,
      health: health,
      message:
        "今日已签到（今日 +" + (info.amount || 0) + "，累计 " + (info.total_count || 0) +
        " 天 / " + (info.total_amount || 0) + "）" +
        (balanceText ? "，余额 " + balanceText : "") +
        (health ? "\n" + health : ""),
    };
  }

  const claim = await request(ctx, api + CHECKIN_PATH, "post", {}, auth.token);
  const balanceText = await fetchBalance(ctx, api, auth.token);
  if (claim.ok) {
    updateHealth(ctx, key, true);
    const d = unwrap(claim.data) || {};
    const amount = typeof d.amount === "number" ? d.amount : info.amount || 0;
    const total = typeof d.total_count === "number" ? d.total_count : info.total_count || 0;
    const totalAmount = typeof d.total_amount === "number" ? d.total_amount : info.total_amount || 0;
    return {
      ok: true,
      name: acc.name,
      claimed: true,
      health: healthText(ctx, key),
      message:
        "签到成功 +" + amount + "（累计 " + total + " 天 / " + totalAmount + "）" +
        (balanceText ? "，余额 " + balanceText : "") +
        (healthText(ctx, key) ? "\n" + healthText(ctx, key) : ""),
    };
  }
  const reason = claim.data && claim.data.reason;
  if (reason === "CHECKIN_ALREADY_CLAIMED" || claim.status === 409) {
    return { ok: true, name: acc.name, claimed: false, message: "今日已签到（并发或重复提交）" };
  }
  return { ok: false, name: acc.name, message: "签到失败：" + errText(claim) };
}

export default async function (ctx) {
  const base = normBase(envOf(ctx, "XINGCHI_BASE_URL"));
  const api = base + "/api/v1";
  const title = "星驰API 签到 " + VERSION;
  let accounts;
  try {
    accounts = loadAccounts(ctx);
  } catch (e) {
    notifyMsg(ctx, title, "配置错误：" + e.message);
    return { error: e.message };
  }

  const results = [];
  for (const acc of accounts) {
    try {
      results.push(await runOne(ctx, api, acc));
    } catch (e) {
      results.push({ ok: false, name: acc.name, message: "脚本异常：" + (e && e.message ? e.message : e) });
    }
  }

  const lines = results.map((r) => (accounts.length > 1 ? r.name + "：" : "") + r.message);
  const failed = results.filter((r) => !r.ok);
  const needsAttention = results.some((r) => r.health && r.health.indexOf("⚠️") >= 0);
  notifyMsg(
    ctx,
    title + (failed.length || needsAttention ? " · 需处理" : ""),
    lines.join("\n"),
    needsAttention ? "建议检查" : results.some((r) => r.claimed) ? "已签到" : "今日已完成",
    failed.length > 0 || needsAttention
  );

  return {
    ok: failed.length === 0,
    claimed: results.some((r) => r.claimed),
    summary: lines.join(" | "),
  };
}
