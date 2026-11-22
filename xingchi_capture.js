/**
 * 星驰API 令牌抓取 · 兼容 Egern 原生(ctx) 与 Loon/Surge/QX($request)
 * 【版本 v10 · 账号独立链】
 * 站点：https://xingchiapi.com
 * API 实际域名：xingchiapi.com（相对路径）或 api.xingchiapi.com，两者都要覆盖
 *
 * ⭐ v10 关键改变：**不再镜像浏览器令牌**
 *   v9 会从 Authorization 头抄 access_token、并持续把浏览器的 refresh_token 抄进存储，
 *   导致「签到手里的令牌 == 浏览器手里的令牌」，浏览器一点退出就把唯一那份 RT 撤销掉，
 *   双账号还会因邮箱解不出而互相覆盖（A 的令牌写进 B 的键）。
 *
 *   v10 每个账号只抓 **一次**：截获 /auth/login 或 /auth/refresh 响应里的 refresh_token，
 *   当场自己刷新一次完成「接管」（服务端一次性轮换，浏览器那份随之作废），
 *   验证通过后写 xingchi_auth:<email> 并置该账号的 done 标记，此后**再也不看浏览器令牌**。
 *   由于签到方持有的是自己轮换出来的 RT，与浏览器会话完全解耦 ——
 *   浏览器退出、换号、清缓存都不会影响签到。
 *
 * 只监听 /api/v1/auth/ 的响应；不再监听请求头，避免污染。
 *
 * ⚠️ Egern 脚本文件默认缓存 24 小时，改完必须在「工具 → 脚本」手动刷新。
 */

var VERSION = "v10";
var KEY = "xingchi_auth:captured";
var ENABLE_KEY = "xingchi_capture_enabled";
// 多账号：每个账号独立键 xingchi_auth:<email>，注册表记录所有邮箱
var REGISTRY_KEY = "xingchi_accounts";
var UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// 每个账号独立的接管标记：xingchi_capture_done:<email> = "1"
var DONE_PREFIX = "xingchi_capture_done:";

// 站点前端页面在 xingchiapi.com，API 可能落在任一域名，两个都要匹配
var API_HOSTS = ["https://xingchiapi.com", "https://api.xingchiapi.com"];

function isApiUrl(url) {
  for (var i = 0; i < API_HOSTS.length; i++) {
    if (url.indexOf(API_HOSTS[i]) === 0) return true;
  }
  return false;
}

// 只关心带鉴权的接口：登录/续期、以及任何 /api/v1/ 下的已登录调用。
// 静态资源、页面、favicon 等一律不进入脚本，避免频繁触发造成延迟。
function shouldHandle(url) {
  if (!isApiUrl(url)) return false;
  // v10：只看鉴权响应（login/refresh），不看 /user/* 请求头 —— 那是 v9 污染账号的根源
  return url.indexOf("/api/v1/auth/") >= 0;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function unwrap(payload) {
  if (payload && typeof payload === "object" && "code" in payload && payload.data) {
    return payload.data;
  }
  return payload;
}

function emailFromToken(token) {
  try {
    var parts = String(token || "").split(".");
    if (parts.length < 2) return "";
    var seg = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (seg.length % 4) seg += "=";
    var raw =
      typeof atob === "function"
        ? atob(seg)
        : Buffer.from(seg, "base64").toString("utf8");
    return String((JSON.parse(raw) || {}).email || "").toLowerCase();
  } catch (e) {
    return "";
  }
}

function bearer(headers) {
  if (!headers) return "";
  var raw = "";
  try {
    if (typeof headers.get === "function") raw = headers.get("authorization") || "";
  } catch (e) {
    raw = "";
  }
  if (!raw) raw = headers["authorization"] || headers["Authorization"] || "";
  if (!raw) {
    for (var k in headers) {
      if (String(k).toLowerCase() === "authorization") {
        raw = headers[k];
        break;
      }
    }
  }
  if (!raw) return "";
  var m = String(raw).match(/Bearer\s+(.+)$/i);
  return m ? m[1].trim() : String(raw).trim();
}

function readSwitch(ctx) {
  // 优先使用模块设置里的原生开关（env 优先级最高）
  var envValue =
    ctx && ctx.env && ctx.env.XINGCHI_CAPTURE !== undefined
      ? String(ctx.env.XINGCHI_CAPTURE).trim().toLowerCase()
      : "";
  if (envValue) return envValue !== "off" && envValue !== "0" && envValue !== "false";

  var v = readRaw(ctx, ENABLE_KEY);
  if (v === null || v === undefined) return true;
  return String(v).trim() !== "0" && String(v).trim().toLowerCase() !== "false";
}

function readRaw(ctx, keyOverride) {
  var key = keyOverride || KEY;
  try {
    if (ctx && ctx.storage && typeof ctx.storage.get === "function") {
      return ctx.storage.get(key);
    }
  } catch (e) {}
  try {
    if (typeof $persistentStore !== "undefined") return $persistentStore.read(key);
    if (typeof $prefs !== "undefined") return $prefs.valueForKey(key);
  } catch (e) {}
  return null;
}

function writeRaw(ctx, text, keyOverride) {
  var key = keyOverride || KEY;
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === "function") {
      ctx.storage.set(key, text);
      return;
    }
  } catch (e) {}
  try {
    if (typeof $persistentStore !== "undefined") $persistentStore.write(text, key);
    else if (typeof $prefs !== "undefined") $prefs.setValueForKey(text, key);
  } catch (e) {}
}

function accountKey(email) {
  var id = String(email || "").toLowerCase().trim();
  if (!id) return KEY; // 解不出邮箱时退回单账号键
  return "xingchi_auth:" + id;
}

function readRegistry(ctx) {
  try {
    var v = readRaw(ctx, REGISTRY_KEY);
    if (!v) return [];
    var arr = JSON.parse(v);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function registerAccount(ctx, email) {
  var id = String(email || "").toLowerCase().trim();
  if (!id) return;
  var list = readRegistry(ctx);
  if (list.indexOf(id) < 0) {
    list.push(id);
    writeRaw(ctx, JSON.stringify(list), REGISTRY_KEY);
  }
}

function isDone(ctx, email) {
  var id = String(email || "").toLowerCase().trim();
  if (!id) return false;
  return String(readRaw(ctx, DONE_PREFIX + id) || "") === "1";
}

function markDone(ctx, email) {
  var id = String(email || "").toLowerCase().trim();
  if (!id) return;
  writeRaw(ctx, "1", DONE_PREFIX + id);
}

function loadState(ctx, keyOverride) {
  var text = readRaw(ctx, keyOverride);
  if (!text) return {};
  try {
    var o = JSON.parse(text);
    return o && typeof o === "object" ? o : {};
  } catch (e) {
    return {};
  }
}

function shout(ctx, title, body) {
  try {
    if (ctx && typeof ctx.notify === "function") {
      ctx.notify({ title: title, subtitle: "抓取成功", body: body, sound: true });
      return;
    }
  } catch (e) {}
  try {
    if (typeof $notification !== "undefined") $notification.post(title, "", body);
    else if (typeof $notify !== "undefined") $notify(title, "", body);
  } catch (e) {
    console.log(title + " | " + body);
  }
}

/**
 * 核心逻辑（v10）。
 * 只在 /api/v1/auth/ 的响应里看到 refresh_token 时才动作，且每个账号只接管一次。
 * 返回 { changed, rawBody }
 */
async function harvest(ctx, url, headers, respBody) {
  var pass = { changed: false, state: null, rawBody: respBody || null };
  if (!url || !shouldHandle(url)) return pass;
  if (!readSwitch(ctx)) return pass; // 开关关闭：完全不拦截
  if (!respBody) return pass;

  var payload;
  try {
    payload = unwrap(JSON.parse(respBody)) || {};
  } catch (e) {
    return pass; // 非 JSON（如错误页），放行
  }

  var rt = payload.refresh_token || payload.refreshToken || payload.rt;
  if (!rt) return pass;
  rt = String(rt);
  if (rt.indexOf("rt_") !== 0) return pass;

  // 用响应里的 access_token 解出邮箱（最可靠），其次尝试从 RT 解
  var email = emailFromToken(payload.access_token || "") || emailFromToken(rt) || "";

  // 该账号已接管 → 之后浏览器怎么刷都与我无关，直接放行（零请求）
  if (email && isDone(ctx, email)) {
    console.log("星驰抓取[" + VERSION + "]：" + email + " 已接管，放行");
    return pass;
  }

  // 接管：自己刷新一次。服务端一次性轮换，浏览器那份 RT 随之作废，
  // 从此签到方持有独立链条，浏览器退出/换号都不影响。
  var verified = await takeOver(ctx, url, rt);
  if (!verified) {
    console.log("星驰抓取[" + VERSION + "]：接管验证失败，保留原响应等待下一个");
    return pass;
  }

  var vEmail = emailFromToken(verified.access_token || "") || email;
  if (!vEmail) {
    // 解不出邮箱就无法按账号隔离，宁可放弃也不写（v9 就栽在这里，互相覆盖）
    console.log("星驰抓取[" + VERSION + "]：无法确定账号邮箱，放弃本次接管");
    return pass;
  }
  if (isDone(ctx, vEmail)) {
    console.log("星驰抓取[" + VERSION + "]：" + vEmail + " 刚被另一请求接管，放行");
    return pass;
  }

  var state = {
    access_token: String(verified.access_token || ""),
    refresh_token: String(verified.refresh_token || rt),
    expires_at: nowSec() + (Number(verified.expires_in) || 86400),
    email: vEmail,
    prev_refresh_tokens: [],
    updated_at: nowSec(),
    source: "capture-v10",
  };

  writeRaw(ctx, JSON.stringify(state), accountKey(vEmail));
  // v10：**不再**写全局键 KEY（v9 每抓一次就覆盖它，双账号时只代表最后一个账号，
  // 直接拿来用就会出现「两个号余额一样 / 一退出另一个也断」）。
  // 这里反而把旧全局键清掉，避免签到脚本误用残留的串号数据。
  try {
    if (ctx && ctx.storage && typeof ctx.storage.delete === "function") ctx.storage.delete(KEY);
    else if (typeof $persistentStore !== "undefined") $persistentStore.write(null, KEY);
    else if (typeof $prefs !== "undefined") $prefs.removeValueForKey(KEY);
  } catch (e) { /* 忽略 */ }
  registerAccount(ctx, vEmail);
  // 最后打接管标记：先有可用种子，再停机
  markDone(ctx, vEmail);

  shout(
    ctx,
    "星驰Token已接管 " + VERSION,
    vEmail + " 的登录态已独立保存（此后浏览器退出也不影响签到）"
  );
  return pass; // 响应原样回传，绝不改包
}

/** 用浏览器的 RT 自己刷新一次，拿到属于签到方的独立 RT。 */
async function takeOver(ctx, url, rt) {
  var origin = "https://api.xingchiapi.com";
  try {
    var m = String(url).match(/^(https:\/\/[^\/]+)/);
    if (m) origin = m[1];
  } catch (e) {}
  try {
    var resp = await ctx.http.post(origin + "/api/v1/auth/refresh", {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify({ refresh_token: rt }),
      timeout: 20000,
    });
    var j = await resp.json();
    var d = unwrap(j) || {};
    if (resp.status >= 200 && resp.status < 300 && d && d.access_token) return d;
    console.log(
      "星驰抓取[" + VERSION + "]：接管返回 " + resp.status + " " +
        JSON.stringify(j || {}).slice(0, 120)
    );
  } catch (e) {
    console.log("星驰抓取[" + VERSION + "]：接管请求异常 " + (e && e.message));
  }
  return null;
}

/* ---------- Egern 原生 ctx 入口 ---------- */
export default async function (ctx) {
  // v10 只做「响应」拦截；请求脚本（http_request）注册了也无副作用
  if (!ctx || !ctx.response || typeof ctx.response.text !== "function") return;

  var url = (ctx && ctx.request && ctx.request.url) || "";
  var headers = (ctx && ctx.request && ctx.request.headers) || {};
  var respBody = "";
  try {
    respBody = await ctx.response.text();
  } catch (e) {
    respBody = "";
  }

  var result = await harvest(ctx, url, headers, respBody);
  if (result.rawBody) return { body: result.rawBody };
}

/* ---------- Loon / Surge / Quantumult X 全局入口（仅响应） ---------- */
var GLOBAL_URL =
  typeof $request !== "undefined" && $request ? $request.url || "" : "";
if (GLOBAL_URL && typeof $response !== "undefined" && $response) {
  harvest(null, GLOBAL_URL, $request.headers || {}, $response.body || "").then(function (r) {
    if (typeof $done === "function") $done(r && r.rawBody ? { body: r.rawBody } : {});
  });
}
