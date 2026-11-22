/**
 * 星驰API 令牌抓取 · Egern / Loon / Surge / QX
 * 【版本 v11 · 实测可用路径 + 账号隔离】
 *
 * ## 为什么改回「抄令牌」而不是 v10 的「自己刷新接管」
 * v10 抓到 refresh_token 后，会在脚本里**自己发一个 /auth/refresh 请求**换取独立令牌。
 * 实测：Egern 的响应脚本里发 HTTP 请求不生效（静默失败），于是什么都没保存，
 * 表现为「v10 完全抓不到，连通知都没有」。
 * v11 回到 v9 那条**已被验证能抓到**的路径：只读、不发请求。
 *
 * ## v11 相比 v9 修掉的两个真 bug
 * 1. **余额串号 / 双账号互相覆盖**
 *    v9 的 emailFromToken 依赖 atob()/Buffer，Egern 的 QuickJS 里两者都没有，
 *    解码必然抛异常 → 回退成「上次存的邮箱」。单账号碰巧对，双账号把 A 的令牌写进 B 的键。
 *    v11 用纯 JS 解码，邮箱永远从令牌本身取；取不到就不写（绝不瞎猜）。
 * 2. **写全局键 xingchi_auth:captured**
 *    v9 每抓一次覆盖它，双账号时它只代表最后一个账号。
 *    v11 只写 xingchi_auth:<email>，并主动清除这个旧键。
 *
 * ## 「浏览器退出就断」怎么解决
 * v11 抓到的令牌只是**种子**，并标记 seed_from_browser=true。
 * 签到脚本第一次跑时会**立刻主动刷新一次**，换来服务端新签发的 RT；
 * 从此签到方持有一条独立链，浏览器那份变成过期值 ——
 * 你之后在浏览器退出，服务端撤销的是它自己那份旧 RT，与签到无关。
 */

var VERSION = "v11";
var AUTH_PREFIX = "xingchi_auth:";
var LEGACY_KEY = "xingchi_auth:captured"; // v9 全局键，仅用于清理
var REGISTRY_KEY = "xingchi_accounts";
var ENABLE_KEY = "xingchi_capture_enabled";

var API_HOSTS = ["https://xingchiapi.com", "https://api.xingchiapi.com"];

function isApiUrl(url) {
  for (var i = 0; i < API_HOSTS.length; i++) {
    if (url.indexOf(API_HOSTS[i]) === 0) return true;
  }
  return false;
}

// 只处理带鉴权的接口，静态资源不进入脚本
function shouldHandle(url) {
  if (!isApiUrl(url)) return false;
  if (url.indexOf("/api/v1/") < 0) return false;
  return url.indexOf("/api/v1/auth/") >= 0 || url.indexOf("/api/v1/user/") >= 0;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/* ---------------- 纯 JS base64（不依赖 atob / Buffer） ---------------- */
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64ToUtf8(input) {
  var str = String(input || "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  var bytes = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < str.length; i++) {
    var v = B64_CHARS.indexOf(str.charAt(i));
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  var out = "";
  for (var j = 0; j < bytes.length; ) {
    var b = bytes[j++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xc0 && b < 0xe0 && j < bytes.length)
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[j++] & 0x3f));
    else if (b >= 0xe0 && b < 0xf0 && j + 1 < bytes.length)
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[j++] & 0x3f) << 6) | (bytes[j++] & 0x3f));
    else if (b >= 0xf0 && j + 2 < bytes.length) {
      var cp = ((b & 0x07) << 18) | ((bytes[j++] & 0x3f) << 12) | ((bytes[j++] & 0x3f) << 6) | (bytes[j++] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

/** 从 JWT 里取邮箱。取不到返回空串 —— 绝不回退到「上次那个账号」。 */
function emailFromToken(token) {
  try {
    var parts = String(token || "").split(".");
    if (parts.length < 2) return "";
    var payload = JSON.parse(b64ToUtf8(parts[1])) || {};
    return String(payload.email || "").toLowerCase().trim();
  } catch (e) {
    return "";
  }
}

/* ---------------- 存储（Egern ctx.storage，兼容其它客户端） ---------------- */
function readRaw(ctx, key) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.get === "function") return ctx.storage.get(key);
  } catch (e) {}
  try {
    if (typeof $persistentStore !== "undefined") return $persistentStore.read(key);
    if (typeof $prefs !== "undefined") return $prefs.valueForKey(key);
  } catch (e) {}
  return null;
}

function writeRaw(ctx, text, key) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.set === "function") {
      ctx.storage.set(key, String(text));
      return;
    }
  } catch (e) {}
  try {
    if (typeof $persistentStore !== "undefined") $persistentStore.write(String(text), key);
    else if (typeof $prefs !== "undefined") $prefs.setValueForKey(String(text), key);
  } catch (e) {}
}

function deleteRaw(ctx, key) {
  try {
    if (ctx && ctx.storage && typeof ctx.storage.delete === "function") {
      ctx.storage.delete(key);
      return;
    }
  } catch (e) {}
  try {
    if (typeof $persistentStore !== "undefined") $persistentStore.write(null, key);
    else if (typeof $prefs !== "undefined") $prefs.removeValueForKey(key);
  } catch (e) {}
}

function readSwitch(ctx) {
  var envValue = ctx && ctx.env && ctx.env.XINGCHI_CAPTURE !== undefined
    ? String(ctx.env.XINGCHI_CAPTURE).trim().toLowerCase()
    : "";
  if (envValue) return envValue !== "off" && envValue !== "0" && envValue !== "false";
  var v = readRaw(ctx, ENABLE_KEY);
  if (v === null || v === undefined) return true;
  var s = String(v).trim().toLowerCase();
  return s !== "0" && s !== "false";
}

function loadState(ctx, email) {
  var text = readRaw(ctx, AUTH_PREFIX + email);
  if (!text) return null;
  try {
    var o = JSON.parse(text);
    return o && typeof o === "object" ? o : null;
  } catch (e) {
    return null;
  }
}

function readRegistry(ctx) {
  var v = readRaw(ctx, REGISTRY_KEY);
  if (!v) return [];
  try {
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
  var changed = false;
  if (list.indexOf(id) < 0) {
    list.push(id);
    changed = true;
  }
  // 清掉历史遗留的全局键（v9 串号元凶）
  if (readRaw(ctx, LEGACY_KEY) !== null && readRaw(ctx, LEGACY_KEY) !== undefined) {
    deleteRaw(ctx, LEGACY_KEY);
    changed = true;
  }
  if (changed) writeRaw(ctx, JSON.stringify(list), REGISTRY_KEY);
}

/* ---------------- 通知 ---------------- */
function notifyUser(ctx, title, body, silent) {
  console.log("星驰抓取[" + VERSION + "]：" + title + " — " + String(body).replace(/\n/g, " "));
  try {
    if (ctx && typeof ctx.notify === "function") {
      ctx.notify({ title: title, body: body, sound: silent ? false : true });
      return;
    }
  } catch (e) {}
  try {
    if (typeof $notification !== "undefined") $notification.post(title, "", body);
    else if (typeof $notify !== "undefined") $notify(title, "", body);
  } catch (e) {}
}

/* ---------------- 请求头读取 ---------------- */
function readHeader(headers, name) {
  if (!headers) return "";
  try {
    if (typeof headers.get === "function") {
      var hv = headers.get(name);
      if (hv) return String(hv);
    }
  } catch (e) {}
  var lower = String(name).toLowerCase();
  for (var k in headers) {
    if (String(k).toLowerCase() === lower) {
      var val = headers[k];
      return val === null || val === undefined ? "" : String(val);
    }
  }
  return "";
}

function bearer(headers) {
  var raw = readHeader(headers, "authorization");
  if (!raw) return "";
  var m = String(raw).match(/Bearer\s+(.+)$/i);
  return m ? m[1].trim() : String(raw).trim();
}

/* ---------------- 核心：从一次请求/响应里提取令牌 ---------------- */
function unwrap(payload) {
  if (payload && typeof payload === "object" && "code" in payload && payload.data) return payload.data;
  return payload;
}

/**
 * 返回 { changed, email }
 * 只读，不发任何网络请求（v10 的接管请求在 Egern 响应脚本里不生效）。
 */
function harvest(ctx, url, headers, respBody, phase) {
  if (!url || !shouldHandle(url)) return { changed: false, email: "" };
  if (!readSwitch(ctx)) return { changed: false, email: "" };

  var at = "";
  var rt = "";

  // ① 请求头里的 Authorization（浏览器每次调 /user/* 都会带，最稳的来源）
  var hdrToken = bearer(headers);
  if (hdrToken && hdrToken.split(".").length >= 2) at = hdrToken;

  // ② 响应体里的 access_token / refresh_token（登录、续期时出现）
  if (respBody && url.indexOf("/api/v1/auth/") >= 0) {
    try {
      var payload = unwrap(JSON.parse(respBody)) || {};
      if (payload.access_token) at = String(payload.access_token);
      var r = payload.refresh_token || payload.refreshToken || payload.rt;
      if (r) rt = String(r);
    } catch (e) {
      // 非 JSON（错误页等），忽略
    }
  }

  if (!at && !rt) return { changed: false, email: "" };

  // 邮箱只从 access_token 里取（RT 是不透明字符串，解不出邮箱）
  var email = emailFromToken(at);

  // 请求头来源时若不像是 JWT，放弃（避免把别的东西当令牌）
  if (phase === "request" && !email) return { changed: false, email: "" };

  if (!email) {
    // 响应体里只有 RT 且没有可解邮箱的 AT：这次先不写，等下一次带 AT 的请求
    notifyUser(
      ctx,
      "星驰抓取 · 暂未保存",
      "抓到了令牌但解不出账号邮箱，为避免写错账号，本次跳过。" +
        "（下次正常访问站点带登录态时会再抓一次）"
    , true);
    return { changed: false, email: "" };
  }

  var prev = loadState(ctx, email) || {};
  var next = {
    access_token: at || String(prev.access_token || ""),
    refresh_token: rt || String(prev.refresh_token || ""),
    expires_at: prev.expires_at || 0,
    email: email,
    updated_at: nowSec(),
  };
  // AT 从 JWT 的 exp 里取真实过期时间；取不到就按 24h 估
  try {
    var pl = JSON.parse(b64ToUtf8(String(next.access_token).split(".")[1])) || {};
    if (pl.exp) next.expires_at = Number(pl.exp);
  } catch (e) {}
  if (!next.expires_at) next.expires_at = nowSec() + 86400;

  var changed = false;
  if (next.access_token !== String(prev.access_token || "")) changed = true;
  if (rt && next.refresh_token !== String(prev.refresh_token || "")) {
    changed = true;
    // 抓到的 RT 来自浏览器：标记为种子，让签到脚本第一次跑就主动轮换、脱离浏览器
    next.seed_from_browser = true;
  }
  if (prev.seed_from_browser) next.seed_from_browser = true;

  if (!changed) return { changed: false, email: email };

  writeRaw(ctx, JSON.stringify(next), AUTH_PREFIX + email);
  registerAccount(ctx, email);

  var bits = [];
  if (next.access_token) bits.push("access_token 有");
  if (next.refresh_token) bits.push("refresh_token 有");
  notifyUser(
    ctx,
    "星驰Token已抓取 " + VERSION,
    email + " 登录态已保存（" + bits.join(" / ") + "）\n" +
      "签到脚本首次运行时会主动轮换令牌，此后浏览器退出也不影响签到。"
  );
  return { changed: true, email: email };
}

/* ---------------- Egern 入口 ---------------- */
export default async function (ctx) {
  if (!ctx) return;

  var url = (ctx.request && ctx.request.url) || readHeader({}, "") || "";
  var headers = (ctx.request && ctx.request.headers) || {};

  // 响应脚本：读 body（需要 body_required: true）
  if (ctx.response && typeof ctx.response.text === "function") {
    var body = "";
    try {
      body = await ctx.response.text();
    } catch (e) {
      body = "";
    }
    harvest(ctx, url, headers, body, "response");
    return { body: body }; // 原样回传，不改包
  }

  // 请求脚本：只读 header，不碰 body
  harvest(ctx, url, headers, "", "request");
  return;
}

/* ---------------- Loon / Surge / QX 兼容 ---------------- */
try {
  if (typeof $request !== "undefined" && $request && $request.url) {
    var gBody = typeof $response !== "undefined" && $response ? $response.body || "" : "";
    var gPhase = gBody ? "response" : "request";
    harvest(null, $request.url, $request.headers || {}, gBody, gPhase);
    if (typeof $done === "function") $done(gBody ? { body: gBody } : {});
  }
} catch (e) {}
