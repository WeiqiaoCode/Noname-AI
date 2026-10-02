/*
 * ============================================
 * // الناشر: في شينغ الأصلي
 * 交流群: 123456789
 * v3.1α
 * 版权所有，侵权必究
 * ============================================
 */
import { safeGet as _lsGet, safeSet as _lsSet, safeRemove as _lsRemove } from '../../foundation/storage/storage.js';  /* ★ P2-31：中央存储抽象，业务层禁止直触 localStorage */

/* ================= 决策积分引擎 · 决策维度反馈闭环 =================
 * 在 feedback.js（技能反馈）之外，新增三个维度的学习：
 *   - target:  打某个玩家，赢/输 → 修正"打这个人"的正向性
 *   - tempo:   某个阶段进攻/防守，赢/输 → 修正阶段权重
 *   - keep:    留某类牌，赢/输 → 修正留牌倾向
 * 全部基于 localStorage，叶子模块（不 import 业务代码）。
 */
const KEY = '无名AI_decisionFeedback';
const VERSION = 1;
const DECAY = 0.7;
const MIN_SAMPLES = 5;
const RATIO_MIN = 0.7;
const RATIO_MAX = 1.4;

let FB = { v: VERSION, target: {}, tempo: {}, keep: {} };
let _loaded = false;
let _pending = { target: [], tempo: [], keep: [] };

export function loadDecisionFeedback() {
	try {
		if (_loaded) return;
		const raw = _lsGet(KEY);
		if (raw) {
			const o = JSON.parse(raw);
			if (o && o.v === VERSION) FB = o;
		}
		_loaded = true;
	} catch (e) { _loaded = true; }
}

export function saveDecisionFeedback() {
	try { _lsSet(KEY, JSON.stringify(FB)); } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}

function _record(kind, key, win) {
	try {
		if (!key) return;
		_pending[kind].push({ key: String(key), win: win ? 1 : 0, ts: Date.now() });
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}

export const recordTargetOutcome = function (targetKey, win) { _record('target', targetKey, win); };
export const recordTempoOutcome  = function (stage, win) { _record('tempo', stage, win); };
export const recordKeepOutcome   = function (cardId, win) { _record('keep', cardId, win); };

function _flushKind(kind) {
	try {
		const arr = _pending[kind];
		if (!arr.length) return 0;
		const byKey = {};
		for (const it of arr) {
			if (!byKey[it.key]) byKey[it.key] = { win: 0, total: 0 };
			byKey[it.key].win += it.win;
			byKey[it.key].total++;
		}
		let updated = 0;
		for (const k in byKey) {
			const s = byKey[k];
			const wr = s.win / s.total;
			// winRate 0.5 为中性 → ratio 1.0
			const rawRatio = 1.0 + (wr - 0.5) * 0.8;
			const ratio = Math.max(RATIO_MIN, Math.min(RATIO_MAX, rawRatio));
			if (!FB[kind]) FB[kind] = {};
			const f = FB[kind][k] || { ratio: 1.0, samples: 0, lastUpdate: 0 };
			if (f.samples < 1) f.ratio = ratio;
			else f.ratio = f.ratio * DECAY + ratio * (1 - DECAY);
			f.ratio = Math.max(RATIO_MIN, Math.min(RATIO_MAX, f.ratio));
			f.samples += s.total;
			f.lastUpdate = Date.now();
			FB[kind][k] = f;
			updated++;
		}
		_pending[kind] = [];
		return updated;
	} catch (e) { _pending[kind] = []; return 0; }
}

export function flushDecisionFeedback() {
	try {
		let n = 0;
		n += _flushKind('target');
		n += _flushKind('tempo');
		n += _flushKind('keep');
		if (n > 0) saveDecisionFeedback();
		return n;
	} catch (e) { return 0; }
}

export function getDecisionBonus(kind, key) {
	try {
		loadDecisionFeedback();
		if (!key) return 1.0;
		const f = FB[kind] && FB[kind][String(key)];
		if (!f || f.samples < MIN_SAMPLES) return 1.0;
		return f.ratio;
	} catch (e) { return 1.0; }
}

/* ★ 人工标记（专业建议）：把某个决策点"人为标记"为不合理/合理，直接写入反馈表并立即生效。
 *   good=true  → 比率抬高（鼓励），good=false → 比率压低（判负，抑制下次同类决策出手）
 *   kind 与 engine 取分时一致：'target'|'tempo'|'keep'（engine 用 getDecisionBonus('keep', 动作id) 乘分）
 *   注意：绕过 MIN_SAMPLES 训练门槛，标记即刻生效；ratio 可显式指定，默认取上下限。 */
export function markOutcome(kind, key, good, ratio) {
    try {
        loadDecisionFeedback();
        if (!key) return false;
        const k = String(key);
        if (!FB[kind]) FB[kind] = {};
        const f = FB[kind][k] || { ratio: 1.0, samples: 0, lastUpdate: 0 };
        const target = (typeof ratio === 'number') ? ratio : (good ? RATIO_MAX : RATIO_MIN);
        f.ratio = Math.max(RATIO_MIN, Math.min(RATIO_MAX, target));
        f.samples = Math.max(f.samples + 1, MIN_SAMPLES);  /* 越过生效门槛：标记后立即影响出牌分 */
        f.marked = (f.marked || 0) + 1;
        f.lastUpdate = Date.now();
        FB[kind][k] = f;
        saveDecisionFeedback();
        return true;
    } catch (e) { return false; }
}

export function getDecisionFeedbackStats() {
	try {
		loadDecisionFeedback();
		const out = [];
		['target', 'tempo', 'keep'].forEach(function (kind) {
			for (const k in (FB[kind] || {})) {
				const f = FB[kind][k];
				out.push({ kind: kind, key: k, ratio: Math.round(f.ratio * 100) / 100, samples: f.samples,
					active: f.samples >= MIN_SAMPLES && Math.abs(f.ratio - 1) >= 0.08 });
			}
		});
		out.sort(function (a, b) { return Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1); });
		return out;
	} catch (e) { return []; }
}

export function resetDecisionFeedback() {
	try {
		FB = { v: VERSION, target: {}, tempo: {}, keep: {} };
		_pending = { target: [], tempo: [], keep: [] };
		_lsRemove(KEY);
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}
