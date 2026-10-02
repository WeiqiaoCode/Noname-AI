/*
 * ============================================
 * // 作者: 飞升原创
 * 交流群: 123456789
 * v3.1α
 * 版权所有，侵权必究
 * ============================================
 */

/* ================= Turn-level Strategic State · 唯一权威 =================
 * 指令 04：回合内动作一致性与自我抵消修复。
 *
 * 问题：同一回合内先给敌人挂【乐】/【兵粮】，随后又用【过河】/【顺手】
 *       把刚建立、仍在判定区生效的控制状态破坏掉（自我抵消）。
 *
 * 目标结构（方案 §目标结构）：
 *   建立轻量 Turn-level Strategic State，只记录 provenance：
 *   actor / target / state type / card id / zone / created action·turn / strategic value。
 *   第一版只跟踪 lebu / bingliang，绝不复制整个 Player / game state。
 *
 * 评分契约：
 *   FinalScore = DirectValue − SelfCreatedStateDestructionPenalty
 *   penalty 永远是 soft opportunity cost，绝不是 hard ban（绝不返回 ±Infinity）。
 *
 * 语义唯一性（方案 §Judge-zone 语义 / §生命周期）：
 *   - 判定区延时控制的敌我方向语义复用 wuxieEvaluator.delayedControlValue，
 *     不另写第二套：enemy 身上 lebu/bingliang/闪电 对我方 → 正收益（拆掉=损失）；
 *     ally 身上 → 负收益（拆掉=帮队友解除，应鼓励）。
 *   - penalty 一律以真实 game state 复核（牌是否仍在判定区、目标是否存活），
 *     跨回合 provenance 不污染、不叠加。
 *
 * 明令禁止（指令 §禁止）：
 *   - has self-created lebu → guohe = -Infinity；
 *   - 同目标再次操作一律降权；
 *   - turnState 复制整个 Player / game state。
 */

import { game, get, _status } from '../../foundation/adapt/host.js';
import { dispositionOf } from '../relations/relations.js';
import { delayedControlValue } from '../response/wuxieEvaluator.js';

function _swallow(e) {
	try {
		if (typeof window !== 'undefined' && window.__DJSC && typeof window.__DJSC.swallow === 'function') {
			window.__DJSC.swallow(e);
		}
	} catch (_) { /* swallow 自身失败时不再递归 */ }
}

/* ---------- 常量 ---------- */
/* 判定区延时族：读取与惩罚同族（兵/乐/闪电）。 */
const DELAYED_CONTROL_IDS = ['lebu', 'bingliang', 'shandian'];
/* 第一版只跟踪乐/兵 provenance（指令：第一版只跟踪 lebu/bingliang）。 */
const PROVENANCE_IDS = ['lebu', 'bingliang'];
/* 战略权重：维持一个控制状态的收益略高于锦囊「即时生效」收益
 * （持续压制节奏、限制对方行动），但保持同向、soft，不做 hard ban。 */
const STRATEGIC_WEIGHT = 1.2;

/* ================= ① 判定区事实读取（唯一入口） ================= */

function _cardName(card, player) {
	try {
		if (!card) return null;
		try {
			if (get && typeof get.name === 'function') {
				const n = get.name(card, player);
				if (typeof n === 'string' && n) return n;
			}
		} catch (e) { _swallow(e); }
		if (typeof card === 'string') return card;
		if (typeof card.name === 'string' && card.name) return card.name;
		if (card.viewAs) {
			if (typeof card.viewAs === 'string') return card.viewAs;
			if (card.viewAs && typeof card.viewAs.name === 'string') return card.viewAs.name;
		}
	} catch (e) { _swallow(e); }
	return null;
}

function _judgeCardsOf(player) {
	try {
		if (!player) return [];
		if (typeof player.getCards === 'function') {
			const j = player.getCards('j');
			if (Array.isArray(j)) return j;
		}
		if (Array.isArray(player.judges)) return player.judges;
	} catch (e) { _swallow(e); }
	return [];
}

/** 读取角色判定区所有牌名（唯一入口）。 */
export function getJudgeCardNames(player) {
	try {
		return _judgeCardsOf(player).map(function (c) { return _cardName(c, player); }).filter(Boolean);
	} catch (e) { _swallow(e); return []; }
}

/** 读取角色判定区中「延时控制」牌 id 列表（兵/乐/闪电）。 */
export function delayedControlIdsIn(player) {
	try {
		return getJudgeCardNames(player).filter(function (n) { return DELAYED_CONTROL_IDS.indexOf(n) >= 0; });
	} catch (e) { _swallow(e); return []; }
}

/** 角色判定区是否存在延时控制（兵/乐/闪电）。 */
export function hasDelayedControl(player) {
	return delayedControlIdsIn(player).length > 0;
}

/* ================= ② 关系解析（复用统一敌我系统） ================= */

function _relOf(player, target, context) {
	try {
		if (context && typeof context.relationOf === 'function') return context.relationOf(player, target);
	} catch (e) { _swallow(e); }
	try { return dispositionOf(player, target); } catch (e) { _swallow(e); return 0; }
}

/* ================= ③ provenance 生命周期 =================
 * 只保留「本回合」记录；相位切换即整体失效。
 * 记录本身不含任何 game state 副本，只存引用与元信息。
 */

let _records = [];
let _phaseKey = null;

function _currentPhaseKey() {
	try {
		const cp = (typeof _status !== 'undefined' && _status) ? _status.currentPhase : null;
		if (!cp) return '';
		return String(cp.name || cp.name1 || cp);
	} catch (e) { _swallow(e); return ''; }
}

/* 相位切换 → provenance 失效（跨回合不污染）。返回是否发生了切换。 */
function _syncPhase() {
	const k = _currentPhaseKey();
	if (k !== _phaseKey) {
		_phaseKey = k;
		_records = [];
		return true;
	}
	return false;
}

function _refKey(target) {
	try {
		if (!target) return '';
		return String(target.name || target.name1 || target.playerid || '');
	} catch (e) { return ''; }
}

function _resolveTarget(t) {
	try {
		if (!t) return null;
		if (typeof t === 'object') return t;
		const players = (typeof game !== 'undefined' && game && game.players) ? game.players : [];
		for (const p of players) {
			if (p && (p.name === t || p.name1 === t)) return p;
		}
	} catch (e) { _swallow(e); }
	return null;
}

function _controlValueOf(player, target, cardId, context) {
	try {
		const rel = _relOf(player, target, context);
		const v = delayedControlValue(player, cardId, rel, target, context);
		if (typeof v === 'number' && isFinite(v)) return Math.round(v * STRATEGIC_WEIGHT * 1000) / 1000;
	} catch (e) { _swallow(e); }
	return 0;
}

/* 记录「我方在本回合建立了一个延时控制」。返回记录或 null。 */
export function recordControlState(actor, target, cardId, opts) {
	_syncPhase();
	opts = opts || {};
	try {
		if (!target || target.alive === false) return null;
		if (PROVENANCE_IDS.indexOf(cardId) < 0) return null;   /* 第一版只跟踪乐/兵 */
		const rec = {
			actor: actor || null,
			actorName: _refKey(actor),
			target: target,
			targetRef: target,
			targetName: _refKey(target),
			stateType: 'delayed-control',
			cardId: cardId,
			zone: 'j',
			createdAction: opts.action || opts.strat || null,
			createdTurn: (opts.turn != null) ? opts.turn : _currentPhaseKey(),
			strategicValue: (typeof opts.strategicValue === 'number')
				? opts.strategicValue
				: _controlValueOf(actor, target, cardId, opts),
		};
		_records.push(rec);
		return rec;
	} catch (e) { _swallow(e); return null; }
}

/* 从一次「实际出牌动作」记录 provenance：仅当 rule 为 乐/兵 且目标有效。
 * action: { rule, strat, target }（engine.useCard 包装层传入）。 */
export function recordSelfCreatedControl(player, action, target) {
	_syncPhase();
	try {
		action = action || {};
		const rule = action.rule || action.id || action.cardId || null;
		if (PROVENANCE_IDS.indexOf(rule) < 0) return null;
		let tgt = target || null;
		if (!tgt && action.target) tgt = _resolveTarget(action.target);
		tgt = _resolveTarget(tgt);
		if (!tgt) return null;
		return recordControlState(player, tgt, rule, { action: action.strat || action.rule || null });
	} catch (e) { _swallow(e); return null; }
}

/** 读取本回合 provenance 快照（浅拷贝，调用方不得改写内部数组）。 */
export function getControlRecords() {
	_syncPhase();
	try { return _records.slice(); } catch (e) { _swallow(e); return []; }
}

/* 判断 (player,target) 是否存在「本回合自建且仍在判定区生效」的记录。 */
function _hasValidRecord(player, target) {
	try {
		if (!_records.length) return false;
		const ids = delayedControlIdsIn(target);   /* 真实状态复核：牌必须仍在判定区 */
		if (!ids.length) return false;
		for (const r of _records) {
			if (!r) continue;
			if (r.targetRef && r.targetRef !== target) continue;
			if (ids.indexOf(r.cardId) >= 0) return true;
		}
	} catch (e) { _swallow(e); }
	return false;
}

/** 清空本回合 provenance（回合结束 / 显式重置）。 */
export function clearTurnState() {
	_records = [];
	_phaseKey = _currentPhaseKey();
}

/* ================= ④ 自我抵消惩罚（soft，唯一权威） =================
 * 返回评估对象：
 *   penalty     直接可用于 FinalScore 的扣减量（可为负：拆队友负面判定 = 鼓励）
 *   selfCreated 是否存在本回合自建、且仍在判定区生效的记录
 *   controlValue 该目标判定区延时控制的净战略价值（敌我方向感知）
 *   ids / relation 便于诊断
 * 语义：拆掉「对我方有利」的控制 → penalty 为正（降权）；
 *       拆掉「对我方有害」的控制（队友身上的兵/乐）→ penalty 为负（加权鼓励）。
 */
export function evaluateDestroyPenalty(player, target, context) {
	const out = { penalty: 0, selfCreated: false, controlValue: 0, ids: [], relation: 0, reason: '' };
	try {
		_syncPhase();
		if (!player || !target || target.alive === false) return out;
		const ids = delayedControlIdsIn(target);
		if (!ids.length) return out;
		const rel = _relOf(player, target, context);
		let value = 0;
		for (const id of ids) {
			const v = delayedControlValue(player, id, rel, target, context);
			if (typeof v === 'number' && isFinite(v)) value += v;
		}
		out.ids = ids;
		out.relation = rel;
		out.controlValue = Math.round(value * 1000) / 1000;
		out.penalty = Math.round(value * STRATEGIC_WEIGHT * 1000) / 1000;
		out.selfCreated = _hasValidRecord(player, target);
		out.reason = out.selfCreated ? 'self-created-control' : 'observed-control';
		return out;
	} catch (e) { _swallow(e); return out; }
}

/** 便捷：仅取 penalty 数值。 */
export function selfCreatedDestructionPenalty(player, target, context) {
	return evaluateDestroyPenalty(player, target, context).penalty;
}

export default {
	getJudgeCardNames, delayedControlIdsIn, hasDelayedControl,
	evaluateDestroyPenalty, selfCreatedDestructionPenalty,
	recordControlState, recordSelfCreatedControl, getControlRecords, clearTurnState,
};