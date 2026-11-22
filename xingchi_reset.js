/**
 * 星驰API 存储清理器 · Egern generic（通用）脚本
 *
 * 用途：清掉 v9 留下的脏数据，让 v10 从干净状态重新接管。
 *
 * 清理内容：
 *   1. xingchi_auth:captured          v9 的全局账号键（双账号串号的元凶）
 *   2. xingchi_capture_done           v9 的全局停机标记
 *   3. xingchi_auth:<邮箱> 中「令牌邮箱与键名不符」的条目（v9 污染残留）
 *   4. xingchi_capture_enabled        抓取开关（重置为开启）
 *
 * 不会动的东西：令牌归属正确的账号条目（那些是好的，保留）。
 *
 * 彻底重来（连好的账号一起清）：env 里加 XINGCHI_RESET=all
 *
 * 用法：
 *   Egern → 工具 → 脚本 → + → 通用脚本(generic)
 *     名称：星驰存储清理
 *     脚本URL：https://raw.githubusercontent.com/ayioyiyo/egern-scripts/main/xingchi_reset.js
 *   保存后长按 → 运行，看通知结果。
 */

const KEY_CAPTURED = "xingchi_auth:captured";
const KEY_DONE = "xingchi_capture_done";
const KEY_ENABLE = "xingchi_capture_enabled";
const KEY_REGISTRY = "xingchi_accounts";
const DONE_PREFIX = "xingchi_capture_done:";
const AUTH_PREFIX = "xingchi_auth:";

function envOf(ctx, k) {
  try {
    const v = ctx && ctx.env ? ctx.env[k] : "";
    return String(v === undefined || v === null ? "" : v).trim();
  } catch (e) {
    return "";
  }
}

function storage(ctx) {
  if (ctx && ctx.storage && typeof ctx.storage.get === "function") return ctx.storage;
  // 兼容 Loon / Surge / QX
  if (typeof $persistentStore !== "undefined") {
    return {
      get: (k) => $persistentStore.read(k),
      set: (k, v) => $persistentStore.write(String(v), k),
      delete: (k) => $persistentStore.write(null, k),
    };
  }
  if (typeof $prefs !== "undefined") {
    return {
      get: (k) => $prefs.valueForKey(k),
      set: (k, v) => $prefs.setValueForKey(String(v), k),
      delete: (k) => $prefs.removeValueForKey(k),
    };
  }
  return null;
}

var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 纯 JS base64 解码（Egern 的 QuickJS 里没有 atob/Buffer）。 */
function b64ToUtf8(input) {
  const str = String(input || "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes = [];
  let buffer = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    const v = B64_CHARS.indexOf(str.charAt(i));
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  let out = "";
  for (let j = 0; j < bytes.length; ) {
    const b = bytes[j++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xc0 && b < 0xe0 && j < bytes.length)
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[j++] & 0x3f));
    else if (b >= 0xe0 && b < 0xf0 && j + 1 < bytes.length)
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[j++] & 0x3f) << 6) | (bytes[j++] & 0x3f));
    else if (b >= 0xf0 && j + 2 < bytes.length) {
      let cp = ((b & 0x07) << 18) | ((bytes[j++] & 0x3f) << 12) | ((bytes[j++] & 0x3f) << 6) | (bytes[j++] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function emailFromToken(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return "";
    return String((JSON.parse(b64ToUtf8(parts[1])) || {}).email || "").toLowerCase().trim();
  } catch (e) {
    return "";
  }
}

function parse(text) {
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" ? o : null;
  } catch (e) {
    return null;
  }
}

export default async function (ctx) {
  const st = storage(ctx);
  const lines = [];
  const resetAll = envOf(ctx, "XINGCHI_RESET").toLowerCase() === "all";

  if (!st) {
    ctx.notify({ title: "星驰清理失败", body: "当前环境不支持持久化存储" });
    return { ok: false, error: "no storage" };
  }

  // 收集所有已知账号键：注册表 + 旧全局键里记录的邮箱
  const emails = new Set();
  try {
    const reg = parse(st.get(KEY_REGISTRY) || "[]");
    if (Array.isArray(reg)) reg.forEach((e) => e && emails.add(String(e).toLowerCase().trim()));
  } catch (e) {}
  try {
    const cap = parse(st.get(KEY_CAPTURED) || "");
    if (cap && cap.email) emails.add(String(cap.email).toLowerCase().trim());
  } catch (e) {}

  // 如果环境支持枚举（部分实现有 keys()），也一并纳入
  try {
    if (typeof st.keys === "function") {
      for (const k of st.keys() || []) {
        if (typeof k === "string" && k.indexOf(AUTH_PREFIX) === 0 && k !== KEY_CAPTURED) {
          emails.add(k.slice(AUTH_PREFIX.length));
        }
      }
    }
  } catch (e) {}

  let removed = 0;
  let kept = 0;

  // 1) v9 全局键：一定删（v10 已不再使用，留着会造成串号）
  if (st.get(KEY_CAPTURED) !== null && st.get(KEY_CAPTURED) !== undefined) {
    st.delete(KEY_CAPTURED);
    removed++;
    lines.push("已删除全局键 xingchi_auth:captured（v9 串号元凶）");
  }
  if (st.get(KEY_DONE) !== null && st.get(KEY_DONE) !== undefined) {
    st.delete(KEY_DONE);
    removed++;
    lines.push("已删除全局标记 xingchi_capture_done");
  }

  // 2) 逐个账号：校验归属
  for (const email of emails) {
    if (!email) continue;
    const key = AUTH_PREFIX + email;
    const text = st.get(key);
    if (text === null || text === undefined) continue;

    if (resetAll) {
      st.delete(key);
      const dk = DONE_PREFIX + email;
      if (st.get(dk) !== null && st.get(dk) !== undefined) st.delete(dk);
      removed++;
      lines.push("已清空 " + email);
      continue;
    }

    const o = parse(text);
    const tokenOwner =
      emailFromToken(o && o.access_token ? o.access_token : "") ||
      emailFromToken(o && o.refresh_token ? o.refresh_token : "");
    if (!tokenOwner) {
      kept++;
      lines.push("保留 " + email + "（解不出令牌邮箱，暂不动）");
      continue;
    }
    if (tokenOwner !== email) {
      st.delete(key);
      const dk = DONE_PREFIX + email;
      if (st.get(dk) !== null && st.get(dk) !== undefined) st.delete(dk);
      removed++;
      lines.push("已删除 " + email + " 的脏条目（里面的令牌其实属于 " + tokenOwner + "）");
    } else {
      kept++;
    }
  }

  // 3) 重置抓取开关为开启
  st.set(KEY_ENABLE, "1");

  const summary = removed
    ? "清理完成：删除 " + removed + " 项，保留 " + kept + " 个正常账号。"
    : "没有发现脏数据（保留 " + kept + " 个正常账号）。";
  const body = summary + (lines.length ? "\n" + lines.join("\n") : "") +
    (resetAll ? "\n已按 XINGCHI_RESET=all 全部清空，请重新登录每个账号。" : "\n下一步：逐个登录每个账号一次即可。");

  ctx.notify({ title: "星驰存储清理", subtitle: removed ? "已清理" : "已检查", body: body, sound: false });
  return { ok: true, removed: removed, kept: kept, resetAll: resetAll, lines: lines };
}
