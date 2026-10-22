import { createRequire } from "node:module";
import { createComponent, createElement, createTextNode, effect, insert, insertNode, setProp, use } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
// \0rolldown/runtime.js
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
// src/types.ts
/** Authentication failed — the panel renders a dedicated hint for this. */
var AuthError = class extends Error {
	name = "AuthError";
};
// src/providers/deepseek.ts
/**
* DeepSeek balance adapter (pay-as-you-go — DeepSeek has no coding plan).
*
*   GET {base}/user/balance
*   Authorization: Bearer <api key>
*
*   {
*     "is_available": true,
*     "balance_infos": [
*       { "currency": "CNY", "total_balance": "4.29",
*         "granted_balance": "0.00", "topped_up_balance": "4.29" }
*     ]
*   }
*
* Verified live on 2026-10-22.
*/
const REQUEST_TIMEOUT_MS$2 = 15e3;
function isRecord$2(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
const SYMBOLS = {
	CNY: "¥",
	USD: "$"
};
/** Parse a balance payload into display rows. Exported for tests. */
function parseDeepseekBalance(payload) {
	const rows = [];
	const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
	for (const info of infos) {
		if (!isRecord$2(info)) continue;
		const currency = typeof info.currency === "string" ? info.currency : "";
		const total = typeof info.total_balance === "string" ? Number.parseFloat(info.total_balance) : NaN;
		if (!Number.isFinite(total)) continue;
		const symbol = SYMBOLS[currency] ?? `${currency} `;
		rows.push({
			label: "Balance",
			percent: null,
			used: null,
			limit: null,
			text: `${symbol}${total.toFixed(2)}`,
			resetsAt: null,
			warn: payload.is_available === false
		});
	}
	return { rows };
}
/**
* Query the DeepSeek account balance.
*
* @throws {AuthError} invalid API key (HTTP 401).
* @throws {Error} network failure or unexpected status.
*/
async function queryDeepseekBalance(apiKey, baseURL, title) {
	const url = `${baseURL.replace(/\/+$/, "")}/user/balance`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS$2);
	let resp;
	try {
		resp = await globalThis.fetch(url, {
			method: "GET",
			signal: controller.signal,
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Accept": "application/json"
			}
		});
	} catch (e) {
		throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		clearTimeout(timer);
	}
	if (resp.status === 401) throw new AuthError("DeepSeek: invalid API key");
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`DeepSeek: HTTP ${resp.status} ${text.slice(0, 120)}`);
	}
	let payload;
	try {
		payload = await resp.json();
	} catch {
		throw new Error("DeepSeek: malformed JSON response");
	}
	if (!isRecord$2(payload)) throw new Error("DeepSeek: unexpected response shape");
	return {
		kind: "deepseek",
		title,
		plan: null,
		rows: parseDeepseekBalance(payload).rows
	};
}
// src/providers/glm.ts
/**
* GLM coding-plan usage adapter — 智谱国内 (open.bigmodel.cn) and global (api.z.ai).
*
* Both presets share one quota backend and response shape. Verified against
* live responses on 2026-10-22:
*
*   GET {base}/api/monitor/usage/quota/limit
*   Authorization: <apiKey>          (raw key — NO "Bearer " prefix)
*
*   {
*     "code": 200, "msg": "Operation successful", "success": true,
*     "data": {
*       "limits": [
*         { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,
*           "currentValue": 204, "remaining": 1795, "percentage": 10,
*           "nextResetTime": 1792651499353 },
*         { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000, ... }
*       ],
*       "level": "lite"
*     }
*   }
*
* `unit: 3` is the 5-hour rolling window, `unit: 6` the weekly window. Older
* plans used `type: "TOKENS_LIMIT"` with only `percentage`; both variants are
* accepted. Business errors (bad key) can come back with HTTP 200, so the
* `code`/`success` body fields must be checked.
*/
const REQUEST_TIMEOUT_MS$1 = 15e3;
function isRecord$1(v) {
	return typeof v === "object" && v !== null;
}
function asString(v) {
	return typeof v === "string" ? v : void 0;
}
function asFiniteNumber(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
/** Route the quota host from the user's model baseURL. No cross-host fallback. */
function glmQuotaBase(baseURL) {
	return baseURL.toLowerCase().includes("bigmodel.cn") ? "https://open.bigmodel.cn" : "https://api.z.ai";
}
function classifyWindow(item) {
	const unit = asFiniteNumber(item.unit);
	if (unit === 3) return "fiveHour";
	if (unit === 6) return "week";
}
const LABELS = {
	fiveHour: "5h",
	week: "Week"
};
function toRow(key, item) {
	const percentage = asFiniteNumber(item.percentage) ?? null;
	const limit = asFiniteNumber(item.usage) ?? null;
	const used = asFiniteNumber(item.currentValue) ?? null;
	const resetMs = asFiniteNumber(item.nextResetTime);
	return {
		label: LABELS[key],
		percent: percentage,
		used,
		limit,
		text: null,
		resetsAt: resetMs != null ? new Date(resetMs).toISOString() : null
	};
}
/**
* Parse `data.limits[]` into the two windows GLM exposes.
*
* Classification anchors on `unit` only (both `unit:6, number:7` and
* `unit:6, number:1` have been observed for the weekly window). When `unit`
* is missing, entries without a reset time fill the 5-hour slot first (it
* legitimately has no reset at 0% utilisation), the rest sort by reset time.
*/
function parseGlmLimits(data) {
	let fiveHour;
	let week;
	const unclassified = [];
	const limits = data.limits;
	if (Array.isArray(limits)) for (const raw of limits) {
		if (!isRecord$1(raw)) continue;
		const type = (asString(raw.type) ?? "").toLowerCase();
		if (type !== "credit_limit" && type !== "tokens_limit") continue;
		const slot = classifyWindow(raw);
		if (slot === "fiveHour" && fiveHour == null) fiveHour = toRow(slot, raw);
		else if (slot === "week" && week == null) week = toRow(slot, raw);
		else unclassified.push({
			resetMs: asFiniteNumber(raw.nextResetTime),
			item: raw
		});
	}
	if (fiveHour == null || week == null) {
		unclassified.sort((a, b) => {
			const aHas = a.resetMs != null ? 1 : 0;
			const bHas = b.resetMs != null ? 1 : 0;
			if (aHas !== bHas) return aHas - bHas;
			return (a.resetMs ?? Number.NEGATIVE_INFINITY) - (b.resetMs ?? Number.NEGATIVE_INFINITY);
		});
		for (const { item } of unclassified) if (fiveHour == null) fiveHour = toRow("fiveHour", item);
		else if (week == null) week = toRow("week", item);
	}
	const rows = [];
	if (fiveHour != null) rows.push(fiveHour);
	if (week != null) rows.push(week);
	return rows;
}
/**
* Query the current GLM coding-plan usage.
*
* @throws {AuthError} invalid or expired API key.
* @throws {Error} network failure or malformed body.
*/
async function queryGlmUsage(apiKey, baseURL, title) {
	const url = `${glmQuotaBase(baseURL)}/api/monitor/usage/quota/limit`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS$1);
	let resp;
	try {
		resp = await globalThis.fetch(url, {
			method: "GET",
			signal: controller.signal,
			headers: {
				"Authorization": apiKey,
				"Content-Type": "application/json",
				"Accept-Language": "en-US,en"
			}
		});
	} catch (e) {
		throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		clearTimeout(timer);
	}
	const bodyText = await resp.text().catch(() => "");
	let body;
	try {
		body = bodyText ? JSON.parse(bodyText) : void 0;
	} catch {
		throw new Error(`HTTP ${resp.status}: malformed JSON response`);
	}
	if (isRecord$1(body)) {
		const code = asFiniteNumber(body.code);
		if (body.success === false || code != null && code !== 200) {
			if (code === 401 || code === 403) throw new AuthError(`GLM: invalid or expired API key (code ${code})`);
			throw new Error(`GLM API error (code ${code ?? "unknown"}): ${asString(body.msg) ?? "unknown error"}`);
		}
	}
	if (!resp.ok) throw new Error(`GLM: HTTP ${resp.status}`);
	const data = isRecord$1(body) ? body.data : void 0;
	if (!isRecord$1(data)) throw new Error("GLM: missing 'data' field in response");
	const level = asString(data.level);
	return {
		kind: "glm",
		title,
		plan: level != null && level.length > 0 ? level.charAt(0).toUpperCase() + level.slice(1) : null,
		rows: parseGlmLimits(data)
	};
}
// src/providers/kimi.ts
/**
* Kimi Coding Plan usage adapter.
*
*   GET {base}/usages                       e.g. base = https://api.kimi.com/coding/v1
*   Authorization: Bearer <sk-kimi-...>
*   User-Agent: KimiCLI/<ver>               (a CLI-looking UA; harmless if ignored)
*
* Live payload shapes seen (2026-10-19/22):
*
*   {                                        // primary shape
*     "usage":  { "limit": "100", "remaining": "84", "resetTime": "..." },
*     "limits": [ { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
*                  "detail": { "limit": "100", "remaining": "100", "resetTime": "..." } } ],
*     "usages": { "limit_5h": { "used_ratio": 0,    "reset_time": "..." },
*                 "limit_7d": { "used_ratio": 0.16, "reset_time": "..." } },
*     "booster_wallet": { "status": "STATUS_DISABLED",
*                         "monthlyUsed": { "currency": "CNY", "priceInCents": "1234" },
*                         "monthlyChargeLimit": { "currency": "CNY", "priceInCents": "10000" } }
*   }
*
*   { "data": [ { "model_name": "all", "limit": ..., "used": ..., "resetTime": ... } ] }
*   {}                                       // e.g. fresh key with no traffic yet
*
* Notes verified against the kimi-code-usage project:
*   - `usage` is the weekly window; `limits[].window` duration 300 (minutes) is
*     the 5-hour window.
*   - `used_ratio` is a 0–1 fraction (not percent).
*   - `usages.*` only supplements windows the primary shape did not cover, so
*     no duplicate rows are emitted.
*   - `priceInCents` may arrive as a string.
*/
const REQUEST_TIMEOUT_MS = 15e3;
const USER_AGENT = "KimiCLI/1.6";
function isRecord(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function toFiniteNumber(v) {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
}
function parseResetTime(v) {
	if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
	if (typeof v === "string" && v.length > 0) {
		const ms = Date.parse(v.endsWith("Z") || v.includes("+") ? v : `${v}Z`);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return null;
}
/** derive used/percent from a `limit` + (`used` | `remaining`) detail object */
function detailRow(label, detail) {
	const limit = toFiniteNumber(detail.limit ?? detail.limit_amount);
	const used = toFiniteNumber(detail.used ?? detail.used_amount);
	const remaining = toFiniteNumber(detail.remaining);
	let resolvedUsed = used;
	if (resolvedUsed == null && remaining != null && limit != null) resolvedUsed = limit - remaining;
	if (resolvedUsed == null || limit == null || limit <= 0) return null;
	return {
		label,
		percent: Math.max(0, Math.min(100, resolvedUsed / limit * 100)),
		used: resolvedUsed,
		limit,
		text: null,
		resetsAt: parseResetTime(detail.resetTime ?? detail.reset_time ?? detail.reset_at)
	};
}
/** `usages.limit_*` entries: only a 0–1 ratio, no absolute numbers */
function ratioRow(label, entry) {
	const ratio = toFiniteNumber(entry.used_ratio);
	if (ratio == null) return null;
	return {
		label,
		percent: Math.max(0, Math.min(100, ratio * 100)),
		used: null,
		limit: null,
		text: null,
		resetsAt: parseResetTime(entry.reset_time ?? entry.resetTime)
	};
}
/** minutes covered by a `limits[].window` — used to spot the 300-minute (5h) slot */
function windowMinutes(window) {
	if (!isRecord(window)) return null;
	const duration = toFiniteNumber(window.duration);
	if (duration == null) return null;
	const unit = String(window.timeUnit ?? window.time_unit ?? "").toUpperCase();
	if (unit.includes("MINUTE")) return duration;
	if (unit.includes("HOUR")) return duration * 60;
	if (unit.includes("DAY")) return duration * 1440;
	if (unit.includes("MONTH")) return duration * 43200;
	return null;
}
function priceInCents(v) {
	if (!isRecord(v)) return void 0;
	return toFiniteNumber(v.priceInCents);
}
/** `booster_wallet` (snake, live) / `boosterWallet` (camel, older) — 加油包 */
function boosterRow(payload) {
	const wallet = isRecord(payload.booster_wallet) && Object.keys(payload.booster_wallet).length > 0 ? payload.booster_wallet : isRecord(payload.boosterWallet) ? payload.boosterWallet : void 0;
	if (wallet == null) return null;
	if (!(wallet.status === "STATUS_ENABLED" || wallet.monthlyChargeLimitEnabled === true || wallet.monthly_charge_limit_enabled === true)) return {
		label: "Booster",
		percent: null,
		used: null,
		limit: null,
		text: "off",
		resetsAt: null
	};
	const usedCents = priceInCents(wallet.monthlyUsed ?? wallet.monthly_used);
	const limitCents = priceInCents(wallet.monthlyChargeLimit ?? wallet.monthly_charge_limit);
	if (usedCents == null) return null;
	if (limitCents != null && limitCents > 0) {
		const used = usedCents / 100;
		const limit = limitCents / 100;
		return {
			label: "Booster",
			percent: Math.max(0, Math.min(100, used / limit * 100)),
			used,
			limit,
			text: null,
			resetsAt: null
		};
	}
	return {
		label: "Booster",
		percent: null,
		used: null,
		limit: null,
		text: `¥${(usedCents / 100).toFixed(2)}`,
		resetsAt: null
	};
}
/** Parse a `/usages` payload into display rows. Exported for tests. */
function parseKimiPayload(payload) {
	const rows = [];
	const coveredFiveHour = /* @__PURE__ */ new Set();
	if (Array.isArray(payload.data)) for (const item of payload.data) {
		if (!isRecord(item)) continue;
		if (item.model_name === "all" || item.modelName === "all") {
			const row = detailRow("Week", item);
			if (row != null) rows.unshift(row);
		}
	}
	if (rows.length === 0 && isRecord(payload.usage)) {
		const row = detailRow("Week", payload.usage);
		if (row != null) rows.push(row);
	}
	if (Array.isArray(payload.limits)) for (const item of payload.limits) {
		if (!isRecord(item)) continue;
		const detail = isRecord(item.detail) ? item.detail : item;
		const minutes = windowMinutes(item.window ?? item);
		const label = minutes === 300 || minutes === 5 ? "5h" : "Limit";
		const row = detailRow(label, detail);
		if (row != null) {
			if (label === "5h") coveredFiveHour.add("5h");
			rows.push(row);
		}
	}
	const usages = isRecord(payload.usages) ? payload.usages : void 0;
	if (usages != null) {
		if (!rows.some((r) => r.label === "Week") && isRecord(usages.limit_7d)) {
			const row = ratioRow("Week", usages.limit_7d);
			if (row != null) rows.unshift(row);
		}
		if (!coveredFiveHour.has("5h") && isRecord(usages.limit_5h)) {
			const row = ratioRow("5h", usages.limit_5h);
			if (row != null) rows.push(row);
		}
	}
	const booster = boosterRow(payload);
	if (booster != null) rows.push(booster);
	return { rows };
}
/**
* Query the current Kimi Coding Plan usage.
*
* @throws {AuthError} wrong key type (e.g. open-platform key) or invalid key.
* @throws {Error} network failure or unexpected status.
*/
async function queryKimiUsage(apiKey, baseURL, title) {
	const url = `${baseURL.replace(/\/+$/, "")}/usages`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let resp;
	try {
		resp = await globalThis.fetch(url, {
			method: "GET",
			signal: controller.signal,
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"User-Agent": USER_AGENT
			}
		});
	} catch (e) {
		throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		clearTimeout(timer);
	}
	if (resp.status === 401 || resp.status === 403) throw new AuthError("Kimi: auth failed. Requires a Kimi Coding Plan key (sk-kimi-...), not an open-platform key");
	if (resp.status === 404) throw new Error("Kimi: usage endpoint not found — is the baseURL https://api.kimi.com/coding/v1?");
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`Kimi: HTTP ${resp.status} ${text.slice(0, 120)}`);
	}
	const bodyText = await resp.text().catch(() => "");
	let payload;
	try {
		payload = bodyText ? JSON.parse(bodyText) : {};
	} catch {
		throw new Error("Kimi: malformed JSON response");
	}
	return {
		kind: "kimi",
		title,
		plan: null,
		rows: parseKimiPayload(isRecord(payload) ? payload : {}).rows
	};
}
// src/providers/resolve.ts
function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}
function classifyByURL(url) {
	if (!url) return void 0;
	const host = hostOf(url);
	if (host === "open.bigmodel.cn" || host.endsWith(".bigmodel.cn") || host === "bigmodel.cn") return {
		kind: "glm",
		baseURL: url
	};
	if (host === "z.ai" || host.endsWith(".z.ai")) return {
		kind: "glm",
		baseURL: url
	};
	if (host === "api.kimi.com" || host.endsWith(".kimi.com") || host.endsWith(".moonshot.ai") || host.endsWith(".moonshot.cn")) return {
		kind: "kimi",
		baseURL: url
	};
	if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) return {
		kind: "deepseek",
		baseURL: url
	};
}
function classifyById(id) {
	const lower = id.toLowerCase();
	if (lower.startsWith("zhipuai") || lower.includes("glm")) return {
		kind: "glm",
		baseURL: "https://open.bigmodel.cn/api/coding/paas/v4"
	};
	if (lower.startsWith("zai")) return {
		kind: "glm",
		baseURL: "https://api.z.ai/api/coding/paas/v4"
	};
	if (lower.includes("kimi") || lower.includes("moonshot")) return {
		kind: "kimi",
		baseURL: "https://api.kimi.com/coding/v1"
	};
	if (lower.includes("deepseek")) return {
		kind: "deepseek",
		baseURL: "https://api.deepseek.com"
	};
}
/** Classify a registered provider: settings.baseURL first, id heuristics fallback. */
function classifyProvider(p) {
	return classifyByURL(p.settings && typeof p.settings.baseURL === "string" ? p.settings.baseURL : void 0) ?? classifyById(p.id);
}
const ENV_KEYS = {
	glm: [
		"ZAI_API_KEY",
		"ZHIPU_API_KEY",
		"ZHIPUAI_API_KEY"
	],
	kimi: [
		"KIMI_API_KEY",
		"KIMI_CODING_API_KEY",
		"MOONSHOT_API_KEY"
	],
	deepseek: ["DEEPSEEK_API_KEY"]
};
/** auth.json auth-id candidates for catalog providers that authenticate via `opencode auth login`. */
const AUTH_IDS = {
	glm: [
		"zhipuai-coding-plan",
		"zhipuai",
		"zai",
		"zai-coding-plan"
	],
	kimi: [
		"kimi",
		"kimi-coding",
		"moonshot"
	],
	deepseek: ["deepseek"]
};
let authCache;
function readAuthFile() {
	if (authCache && Date.now() - authCache.at < 6e4) return authCache.value;
	let value = {};
	try {
		const { readFileSync } = __require("node:fs");
		const { join } = __require("node:path");
		const { homedir } = __require("node:os");
		const candidates = [join(homedir(), ".local", "share", "opencode", "auth.json"), join(homedir(), "AppData", "Local", "opencode", "auth.json")];
		for (const path of candidates) try {
			const raw = JSON.parse(readFileSync(path, "utf-8"));
			if (raw && typeof raw === "object") {
				value = raw;
				break;
			}
		} catch {}
	} catch {}
	authCache = {
		at: Date.now(),
		value
	};
	return value;
}
/** API key: settings.apiKey → provider auth.json entry → env vars. */
function resolveApiKey(p, kind) {
	const fromSettings = p.settings && typeof p.settings.apiKey === "string" ? p.settings.apiKey : void 0;
	if (fromSettings) return fromSettings;
	const auth = readAuthFile();
	for (const id of AUTH_IDS[kind]) {
		const entry = auth[id];
		if (entry?.type === "api" && typeof entry.key === "string" && entry.key.length > 0) return entry.key;
	}
	for (const name of ENV_KEYS[kind] ?? []) {
		const value = process.env[name];
		if (typeof value === "string" && value.length > 0) return value;
	}
}
/**
* The provider of the model currently selected in the TUI prompt.
* Reactive when called inside a Solid computation — `ui.model.current()` is
* backed by a live store.
*/
function activeModelProvider(context) {
	const model = context.ui.model.current();
	if (!model) return void 0;
	return context.data.location.provider.list()?.find((p) => p.id === model.providerID);
}
/**
* Resolve current usage by routing to the active provider's adapter.
*
* @throws {AuthError} key invalid or missing for the provider.
* @throws {Error} no active provider / unsupported provider / adapter failure.
*/
async function resolveUsage(context) {
	const p = activeModelProvider(context);
	if (!p) throw new Error("no active provider");
	const cls = classifyProvider(p);
	if (!cls) throw new Error(`provider "${p.id}" is not GLM / Kimi / DeepSeek`);
	const key = resolveApiKey(p, cls.kind);
	if (!key) throw new AuthError(`no API key for "${p.id}" (settings.apiKey / auth.json / ${(ENV_KEYS[cls.kind] ?? []).join(" / ")})`);
	const title = p.name || p.id;
	switch (cls.kind) {
		case "glm": return queryGlmUsage(key, cls.baseURL, title);
		case "kimi": return queryKimiUsage(key, cls.baseURL, title);
		case "deepseek": return queryDeepseekBalance(key, cls.baseURL, title);
	}
}
// src/tui.tsx
/** @jsxImportSource @opentui/solid */
const [refreshTick, setRefreshTick] = createSignal(0);
function charColumns(c) {
	const code = c.codePointAt(0) ?? 0;
	if (code < 32) return 0;
	if (code < 127) return 1;
	if (code < 160) return 0;
	if (code >= 4352 && code <= 4447 || code >= 11904 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65040 && code <= 65135 || code >= 65281 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 127744 && code <= 128591 || code >= 131072 && code <= 262141) return 2;
	return 1;
}
function visualWidth(s) {
	let w = 0;
	for (const c of s) w += charColumns(c);
	return w;
}
function padEndVisual(s, width) {
	const pad = width - visualWidth(s);
	return pad > 0 ? s + " ".repeat(pad) : s;
}
function compact(n) {
	if (n < 1e3) return String(Math.round(n));
	if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
	return `${(n / 1e6).toFixed(1)}M`;
}
/** "1h23m" / "2d4h" / "45m" countdown until `iso` from now. */
function countdown(iso) {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	const minutes = Math.max(0, Math.floor((ms - Date.now()) / 6e4));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
function rgb(raw) {
	if (typeof raw === "string" && raw.startsWith("#")) {
		const h = raw.slice(1);
		return {
			r: Number.parseInt(h.slice(0, 2), 16),
			g: Number.parseInt(h.slice(2, 4), 16),
			b: Number.parseInt(h.slice(4, 6), 16)
		};
	}
	if (raw && typeof raw === "object") {
		const o = raw;
		if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
			const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255;
			return {
				r: Math.round(o.r * scale),
				g: Math.round(o.g * scale),
				b: Math.round(o.b * scale)
			};
		}
	}
	return null;
}
function toHex(r, g, b) {
	return `#${[
		r,
		g,
		b
	].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}
function themeHex(raw, fallback) {
	const c = rgb(raw);
	return c ? toHex(c.r, c.g, c.b) : fallback;
}
/** Walk a theme by dot-path, tolerating structural drift across versions. */
function themeAt(theme, path) {
	let cur = theme;
	for (const part of path.split(".")) {
		if (!cur || typeof cur !== "object") return void 0;
		cur = cur[part];
	}
	return cur;
}
function brighten(hex, amount) {
	const c = rgb(hex);
	if (!c) return hex;
	return toHex(Math.round(c.r + (255 - c.r) * amount), Math.round(c.g + (255 - c.g) * amount), Math.round(c.b + (255 - c.b) * amount));
}
const FALLBACK = {
	primary: "#8B9DAF",
	text: "#C5C5BB",
	muted: "#7A7A72",
	border: "#6B6B63"
};
const VIVID_FALLBACK = {
	relaxed: "#22D06E",
	warning: "#F5A623",
	danger: "#FF4D4F"
};
function paletteOf(theme) {
	return {
		primary: themeHex(themeAt(theme, "text.action.primary.base") ?? themeAt(theme, "text.base"), FALLBACK.primary),
		text: themeHex(themeAt(theme, "text.base"), FALLBACK.text),
		muted: themeHex(themeAt(theme, "text.muted"), FALLBACK.muted),
		border: themeHex(themeAt(theme, "border.subtle") ?? themeAt(theme, "border.base"), FALLBACK.border),
		danger: themeHex(themeAt(theme, "text.feedback.error.base") ?? themeAt(theme, "background.feedback.error.base"), VIVID_FALLBACK.danger)
	};
}
/** Severity tier: relaxed <60, warning 60-85, danger >=85. */
function tierColor(pct, theme) {
	if (pct >= 85) return themeHex(themeAt(theme, "text.feedback.error.base") ?? themeAt(theme, "background.feedback.error.base"), VIVID_FALLBACK.danger);
	if (pct >= 60) return themeHex(themeAt(theme, "text.feedback.warning.base") ?? themeAt(theme, "background.feedback.warning.base"), VIVID_FALLBACK.warning);
	return themeHex(themeAt(theme, "text.feedback.success.base") ?? themeAt(theme, "background.feedback.success.base"), VIVID_FALLBACK.relaxed);
}
const FILL_CHAR = "━";
const TRACK_CHAR = "─";
function meterBar(percent, width) {
	const filledCount = Math.round(Math.max(0, Math.min(100, percent)) / 100 * width);
	return {
		filled: FILL_CHAR.repeat(filledCount),
		empty: TRACK_CHAR.repeat(width - filledCount)
	};
}
const MIN_PANEL_WIDTH = 24;
const DEFAULT_PANEL_WIDTH = 30;
const LABEL_W = 7;
const PCT_WIDTH = 6;
const GUTTER = 6;
const REFRESH_MS = 3e5;
const IDLE_REFRESH_DEBOUNCE_MS = 3e3;
function UsagePanel(props) {
	const { context } = props;
	const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH);
	const [open, setOpen] = createSignal(true);
	let boxEl;
	const [usage, setUsage] = createSignal(null);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal(null);
	const provider = createMemo(() => activeModelProvider(context));
	const providerName = createMemo(() => provider()?.name || provider()?.id || "Usage");
	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await resolveUsage(context);
			setUsage(data);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};
	onMount(() => {
		load();
		const timer = setInterval(() => void load(), REFRESH_MS);
		onCleanup(() => clearInterval(timer));
	});
	createEffect(() => {
		providerName();
		refreshTick();
		load();
	});
	const pal = createMemo(() => paletteOf(context.theme));
	const sep = createMemo(() => "─".repeat(Math.max(1, panelWidth() - GUTTER)));
	const barW = createMemo(() => {
		return Math.max(3, panelWidth() - 23);
	});
	const titlePad = createMemo(() => {
		const plan = usage()?.plan;
		const content = `${open() ? "▼" : "▶"} ${providerName()}${plan ? ` · ${plan}` : ""}`;
		return Math.max(0, panelWidth() - GUTTER - 1 - visualWidth(content));
	});
	function rowDetail(row) {
		const parts = [];
		if (row.used != null && row.limit != null && row.limit > 0) parts.push(`${compact(row.used)}/${compact(row.limit)}`);
		const cd = row.resetsAt != null ? countdown(row.resetsAt) : "";
		if (cd !== "") parts.push(`reset ${cd}`);
		return parts.length > 0 ? parts.join(" · ") : null;
	}
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("text"), _el$4 = createElement("span"), _el$5 = createElement("span"), _el$6 = createElement("b"), _el$8 = createElement("span"), _el$9 = createElement("text");
		insertNode(_el$, _el$2);
		var _ref$ = boxEl;
		typeof _ref$ === "function" ? use(_ref$, _el$) : boxEl = _el$;
		setProp(_el$, "border", true);
		setProp(_el$, "borderStyle", "rounded");
		setProp(_el$, "paddingTop", 0);
		setProp(_el$, "paddingBottom", 0);
		setProp(_el$, "paddingLeft", 2);
		setProp(_el$, "paddingRight", 2);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "gap", 0);
		setProp(_el$, "onSizeChange", () => {
			const w = boxEl && typeof boxEl.width === "number" && boxEl.width > 0 ? Math.max(MIN_PANEL_WIDTH, boxEl.width) : DEFAULT_PANEL_WIDTH;
			setPanelWidth((prev) => prev === w ? prev : w);
		});
		insertNode(_el$2, _el$3);
		insertNode(_el$2, _el$9);
		setProp(_el$2, "flexDirection", "row");
		insertNode(_el$3, _el$4);
		insertNode(_el$3, _el$5);
		insertNode(_el$3, _el$8);
		setProp(_el$3, "onMouseUp", () => setOpen((o) => !o));
		insert(_el$4, () => open() ? "▼ " : "▶ ");
		insertNode(_el$5, _el$6);
		insert(_el$6, providerName);
		insert(_el$3, createComponent(Show, {
			get when() {
				return usage()?.plan != null;
			},
			get children() {
				var _el$7 = createElement("span");
				insert(_el$7, () => ` · ${usage()?.plan}`);
				effect((_$p) => setProp(_el$7, "style", { fg: pal().muted }, _$p));
				return _el$7;
			}
		}), _el$8);
		insert(_el$8, () => " ".repeat(titlePad()));
		insertNode(_el$9, createTextNode(`↻`));
		setProp(_el$9, "onMouseUp", () => void load());
		insert(_el$, createComponent(Show, {
			get when() {
				return open();
			},
			get children() {
				return [(() => {
					var _el$1 = createElement("text");
					insert(_el$1, sep);
					effect((_$p) => setProp(_el$1, "fg", pal().border, _$p));
					return _el$1;
				})(), createComponent(Show, {
					get when() {
						return !loading() || usage() == null;
					},
					get fallback() {
						return (() => {
							var _el$10 = createElement("text"), _el$11 = createElement("span");
							insertNode(_el$10, _el$11);
							insertNode(_el$11, createTextNode(`> loading…`));
							effect((_$p) => setProp(_el$11, "style", { fg: pal().muted }, _$p));
							return _el$10;
						})();
					},
					get children() {
						return createComponent(Show, {
							get when() {
								return error() == null;
							},
							get fallback() {
								return (() => {
									var _el$13 = createElement("text"), _el$14 = createElement("span"), _el$16 = createElement("span");
									insertNode(_el$13, _el$14);
									insertNode(_el$13, _el$16);
									insertNode(_el$14, createTextNode(`> `));
									insert(_el$16, error);
									effect((_p$) => {
										var _v$5 = { fg: pal().muted }, _v$6 = { fg: pal().danger };
										_v$5 !== _p$.e && (_p$.e = setProp(_el$14, "style", _v$5, _p$.e));
										_v$6 !== _p$.t && (_p$.t = setProp(_el$16, "style", _v$6, _p$.t));
										return _p$;
									}, {
										e: void 0,
										t: void 0
									});
									return _el$13;
								})();
							},
							get children() {
								return createComponent(Show, {
									get when() {
										return (usage()?.rows.length ?? 0) > 0;
									},
									get fallback() {
										return (() => {
											var _el$17 = createElement("text"), _el$18 = createElement("span");
											insertNode(_el$17, _el$18);
											insertNode(_el$18, createTextNode(`> no usage data yet`));
											effect((_$p) => setProp(_el$18, "style", { fg: pal().muted }, _$p));
											return _el$17;
										})();
									},
									get children() {
										return createComponent(For, {
											get each() {
												return usage()?.rows ?? [];
											},
											children: (row) => {
												const color = createMemo(() => tierColor(row.percent ?? 100, context.theme));
												const edgeColor = createMemo(() => brighten(color(), .45));
												const bar = createMemo(() => meterBar(row.percent ?? 0, barW()));
												const label = padEndVisual(row.label, LABEL_W);
												const detail = rowDetail(row);
												const pctLabel = () => row.percent == null ? "" : `${row.percent.toFixed(0)}%`.padStart(PCT_WIDTH);
												return (() => {
													var _el$20 = createElement("box"), _el$21 = createElement("text"), _el$22 = createElement("span"), _el$23 = createElement("b");
													insertNode(_el$20, _el$21);
													setProp(_el$20, "flexDirection", "column");
													setProp(_el$20, "gap", 0);
													insertNode(_el$21, _el$22);
													insertNode(_el$22, _el$23);
													insert(_el$23, label);
													insert(_el$21, createComponent(Show, {
														get when() {
															return row.percent != null;
														},
														get children() {
															return [
																(() => {
																	var _el$24 = createElement("span");
																	insertNode(_el$24, createTextNode(` ❰`));
																	effect((_$p) => setProp(_el$24, "style", { fg: pal().border }, _$p));
																	return _el$24;
																})(),
																(() => {
																	var _el$26 = createElement("span"), _el$27 = createElement("b");
																	insertNode(_el$26, _el$27);
																	insert(_el$27, () => bar().filled.slice(0, -1));
																	effect((_$p) => setProp(_el$26, "style", { fg: color() }, _$p));
																	return _el$26;
																})(),
																createComponent(Show, {
																	get when() {
																		return bar().filled.length > 0;
																	},
																	get children() {
																		var _el$28 = createElement("span"), _el$29 = createElement("b");
																		insertNode(_el$28, _el$29);
																		insert(_el$29, () => bar().filled.slice(-1));
																		effect((_$p) => setProp(_el$28, "style", { fg: edgeColor() }, _$p));
																		return _el$28;
																	}
																}),
																(() => {
																	var _el$30 = createElement("span");
																	insert(_el$30, () => bar().empty);
																	effect((_$p) => setProp(_el$30, "style", { fg: pal().border }, _$p));
																	return _el$30;
																})(),
																(() => {
																	var _el$31 = createElement("span");
																	insertNode(_el$31, createTextNode(`❱`));
																	effect((_$p) => setProp(_el$31, "style", { fg: pal().border }, _$p));
																	return _el$31;
																})(),
																(() => {
																	var _el$33 = createElement("span"), _el$34 = createElement("b");
																	insertNode(_el$33, _el$34);
																	insert(_el$34, pctLabel);
																	effect((_$p) => setProp(_el$33, "style", { fg: color() }, _$p));
																	return _el$33;
																})()
															];
														}
													}), null);
													insert(_el$21, createComponent(Show, {
														get when() {
															return row.text != null;
														},
														get children() {
															var _el$35 = createElement("span"), _el$36 = createElement("b");
															insertNode(_el$35, _el$36);
															insert(_el$36, () => ` ${row.text}`);
															effect((_$p) => setProp(_el$35, "style", { fg: row.warn ? pal().danger : pal().text }, _$p));
															return _el$35;
														}
													}), null);
													insert(_el$20, createComponent(Show, {
														get when() {
															return detail != null && row.percent != null;
														},
														get children() {
															var _el$37 = createElement("text"), _el$38 = createElement("span");
															insertNode(_el$37, _el$38);
															insert(_el$38, () => `${" ".repeat(8)}${detail}`);
															effect((_$p) => setProp(_el$38, "style", { fg: pal().muted }, _$p));
															return _el$37;
														}
													}), null);
													effect((_$p) => setProp(_el$22, "style", { fg: pal().text }, _$p));
													return _el$20;
												})();
											}
										});
									}
								});
							}
						});
					}
				})];
			}
		}), null);
		effect((_p$) => {
			var _v$ = pal().border, _v$2 = { fg: pal().muted }, _v$3 = { fg: pal().primary }, _v$4 = loading() ? pal().primary : pal().muted;
			_v$ !== _p$.e && (_p$.e = setProp(_el$, "borderColor", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$4, "style", _v$2, _p$.t));
			_v$3 !== _p$.a && (_p$.a = setProp(_el$5, "style", _v$3, _p$.a));
			_v$4 !== _p$.o && (_p$.o = setProp(_el$9, "fg", _v$4, _p$.o));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0
		});
		return _el$;
	})();
}
var tui_default = Plugin.define({
	id: "usage.quota",
	setup(context) {
		if (!context.ui) return;
		context.data.location.provider.sync().catch(() => {});
		let idleDebounce;
		const removeIdle = context.data.on("session.idle", () => {
			clearTimeout(idleDebounce);
			idleDebounce = setTimeout(() => setRefreshTick((t) => t + 1), IDLE_REFRESH_DEBOUNCE_MS);
		});
		const disposeSlot = context.ui.slot({
			append: "sidebar.content",
			render: () => createComponent(UsagePanel, { context })
		});
		return () => {
			removeIdle();
			disposeSlot();
			clearTimeout(idleDebounce);
		};
	}
});
export { tui_default as default };
