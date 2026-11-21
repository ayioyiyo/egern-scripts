/**
 * 星驰API 令牌抓取 · 兼容 Egern 原生(ctx) 与 Loon/Surge/QX($request)
 * 【版本 v6】
 * 站点：https://xingchiapi.com
 * API 实际域名：xingchiapi.com（相对路径）或 api.xingchiapi.com，两者都要覆盖
 *
 * 抓取通道（任一命中即保存）：
 *   1. 请求头 Authorization: Bearer <access_token>
 *   2. /auth/ 响应体里的 refresh_token
 * 存到 xingchi_auth:captured，供签到脚本使用。
 *
 * ⚠️ Egern 脚本文件默认缓存 24 小时，改完必须在「工具 → 脚本」手动刷新。
 */

var VERSION = "v9";
var KEY = "xingchi_auth:captured";
var ENABLE_KEY = "xingchi_capture_enabled";
// 多账号：每个账号独立键 xingchi_auth:<email>，注册表记录所有邮箱
var REGISTRY_KEY = "xingchi_accounts";

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
  var idx = url.indexOf("/api/v1/");
  if (idx < 0) return false;
  return url.indexOf("/api/v1/auth/") >= 0 || url.indexOf("/api/v1/user/") >= 0;
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

// 服务端的 refresh_token 是一次性轮换的：用过即作废。
// 这里把最近几个旧值留作备份，万一最新那个被判失效，
// 签到脚本还能拿备份继续续期，避免整个登录态断掉。
function rememberOldToken(state, oldToken) {
  if (!oldToken) return;
  var list = Array.isArray(state.prev_refresh_tokens) ? state.prev_refresh_tokens.slice(0, 2) : [];
  if (list.indexOf(String(oldToken)) < 0) list.unshift(String(oldToken));
  state.prev_refresh_tokens = list.slice(0, 3);
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
 * 核心逻辑。返回 { changed, state, rawBody }
 * rawBody 非空时调用方应原样回传给客户端。
 */
function harvest(ctx, url, headers, respBody) {
  if (!url || !shouldHandle(url)) {
    return { changed: false, state: null, rawBody: null };
  }
  // 开关关闭时直接放行，不做任何抓取
  if (!readSwitch(ctx)) {
    return { changed: false, state: null, rawBody: respBody || null };
  }

  var prevLegacy = loadState(ctx);
  // 先用请求里能解出的邮箱定位账号，解不出就沿用上次的
  var headerMail = emailFromToken(bearer(headers));
  var accountEmail = headerMail || String(prevLegacy.email || "").toLowerCase();
  var stateKey = accountKey(accountEmail);
  var prev = stateKey === KEY ? prevLegacy : loadState(ctx, stateKey);
  var state = {
    access_token: prev.access_token || "",
    refresh_token: prev.refresh_token || "",
    expires_at: Number(prev.expires_at) || 0,
    email: prev.email || "",
    prev_refresh_tokens: Array.isArray(prev.prev_refresh_tokens) ? prev.prev_refresh_tokens : [],
    updated_at: Number(prev.updated_at) || 0,
  };
  var changed = false;

  var at = bearer(headers);
  if (at && at !== state.access_token && at.length >= 10) {
    state.access_token = at;
    state.email = emailFromToken(at) || state.email;
    state.expires_at = nowSec() + 900;
    changed = true;
  }

  if (respBody && url.indexOf("/api/v1/auth/") >= 0) {
    try {
      var payload = unwrap(JSON.parse(respBody)) || {};
      var rt = payload.refresh_token || payload.refreshToken || payload.rt;
      if (rt) {
        rt = String(rt);
        // 接受最新值，旧的留作备份
        if (rt !== state.refresh_token) {
          rememberOldToken(state, state.refresh_token);
          state.refresh_token = rt;
          changed = true;
        }
      }
      if (payload.access_token && !state.access_token) {
        state.access_token = String(payload.access_token);
        state.email = emailFromToken(state.access_token) || state.email;
        changed = true;
      }
    } catch (e) {
      console.log("星驰抓取[" + VERSION + "]：响应体解析失败 " + (e && e.message));
    }
  }

  if (!changed) {
    console.log("星驰抓取[" + VERSION + "]：本次无变化 " + url);
    return { changed: false, state: state, rawBody: respBody || null };
  }

  state.updated_at = nowSec();
  if (!state.email && accountEmail) state.email = accountEmail;
  var finalKey = accountKey(state.email);
  writeRaw(ctx, JSON.stringify(state), finalKey);
  // 兼容旧的单账号键，让签到脚本仍能读到最近一次
  writeRaw(ctx, JSON.stringify(state), KEY);
  registerAccount(ctx, state.email);
  shout(
    ctx,
    "星驰Token已抓取 " + VERSION,
    (state.email || "账号") +
      " 登录态已保存（access_token " +
      (state.access_token ? "有" : "无") +
      " / refresh_token " +
      (state.refresh_token ? "有" : "无") +
      "）"
  );
  return { changed: true, state: state, rawBody: respBody || null };
}

/* ---------- Egern 原生 ctx 入口 ---------- */
export default async function (ctx) {
  var url = (ctx && ctx.request && ctx.request.url) || "";
  var headers = (ctx && ctx.request && ctx.request.headers) || {};
  var respBody = "";

  if (ctx && ctx.response && typeof ctx.response.text === "function") {
    try {
      respBody = await ctx.response.text();
    } catch (e) {
      respBody = "";
    }
  }

  var result = harvest(ctx, url, headers, respBody);
  if (result.rawBody) return { body: result.rawBody };
}

/* ---------- Loon / Surge / Quantumult X 全局入口 ---------- */
var GLOBAL_URL =
  typeof $request !== "undefined" && $request ? $request.url || "" : "";
if (GLOBAL_URL) {
  var GLOBAL_BODY =
    typeof $response !== "undefined" && $response ? $response.body || "" : "";
  var GLOBAL_RESULT = harvest(null, GLOBAL_URL, $request.headers || {}, GLOBAL_BODY);
  if (typeof $done === "function") {
    $done(GLOBAL_RESULT.rawBody ? { body: GLOBAL_RESULT.rawBody } : {});
  }
}
