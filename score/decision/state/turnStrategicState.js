/*
 * ============================================
 * // 作者: 飞升原创
 * 交流群: 123456789
 * v3.1α
 * 版权所有，侵权必究
 * ============================================
 */

/* ================= Turn-level Strategic State · 唯一权威 =================
 * 回合内“战略承诺 / 状态转移一致性”层。
 *
 * 核心原则：
 *   1) 决策层不识别具体牌名，只消费游戏档案声明的通用 operation/state；
 *   2) 只记录轻量 provenance，不复制 Player / game state；
 *   3) CREATE → REMOVE → RECREATE 同目标同状态属于 reversal，使用 soft penalty；
 *   4) REMOVE 具体卡牌时按该状态对我方的真实价值决定“应保护还是应解除”；
 *   5) 换目标、局面变化、跨回合都不 hard-ban，允许高收益动作覆盖机会成本。
 *
 * 具体卡牌到语义的映射只存在 foundation/adapt/gameProfile.js。
 */

import { game, get, _status } from '../../foundation/adapt/host.js';
import '../../foundation/adapt/gameProfile.js';   /* 默认档案注入 strategicEffects */
import { strategicEffectOf } from '../../foundation/adapt/terms.js';
import { dispositionOf } from '../relations/relations.js';
import { delayedControlValue } from '../response/wuxieEvaluator.js';

function _swallow(e) {
	try {
		if (typeof window !== 'undefined' && window.__DJSC && typeof window.__DJSC.swallow === 'function') {
			window.__DJSC.swallow(e);
		}
	} catch (_) { /* swallow 自身失败时不再递归 */ }
}

const STRATEGIC_WEIGHT = 1.2;
const REAPPLY_WEIGHT = 1.2;
const REMOVAL_CHOICE_WEIGHT = 1.6;
const TARGET_ALTERNATIVE_DISCOUNT = 0.2;

/* ================= ① 通用状态语义 ================= */

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

function _effectOf(cardId) {
	try { return cardId ? strategicEffectOf(cardId) : null; } catch (e) { _swallow(e); return null; }
}

function _stateOf(cardId) {
	try {
		const e = _effectOf(cardId);
		if (!e || e.operation !== 'create-state' || !e.state) return null;
		return Object.assign({}, e.state);
	} catch (e) { _swallow(e); return null; }
}

function _stateKey(state) {
	if (!state) return '';
	return String(state.family || '') + '|' + String(state.dimension || '') + '|' + String(state.zone || '');
}

function _isRemovalAction(cardId) {
	try {
		const e = _effectOf(cardId);
		return !!(e && e.operation === 'remove-target-card');
	} catch (e) { return false; }
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

function _cardsOf(player, zone) {
	try {
		if (!player || typeof player.getCards !== 'function') return [];
		const a = player.getCards(zone);
		return Array.isArray(a) ? a : [];
	} catch (e) { _swallow(e); return []; }
}

/** 读取角色判定区所有牌名。 */
export function getJudgeCardNames(player) {
	try {
		return _judgeCardsOf(player).map(function (c) { return _cardName(c, player); }).filter(Boolean);
	} catch (e) { _swallow(e); return []; }
}

/** 读取判定区中由游戏档案声明的战略状态牌。 */
export function strategicStateIdsIn(player) {
	try {
		return getJudgeCardNames(player).filter(function (id) {
			const st = _stateOf(id);
			return !!(st && (!st.zone || st.zone === 'j'));
		});
	} catch (e) { _swallow(e); return []; }
}

/* 兼容旧接口：当前档案中这里就是延时控制状态。 */
export function delayedControlIdsIn(player) { return strategicStateIdsIn(player); }
export function hasDelayedControl(player) { return strategicStateIdsIn(player).length > 0; }

/* ================= ② 关系与价值 ================= */

function _relOf(player, target, context) {
	try {
		if (context && typeof context.relationOf === 'function') return context.relationOf(player, target);
	} catch (e) { _swallow(e); }
	try { return dispositionOf(player, target); } catch (e) { _swallow(e); return 0; }
}

function _stateValueOf(player, target, cardId, context) {
	try {
		const rel = _relOf(player, target, context);
		const v = delayedControlValue(player, cardId, rel, target, context);
		if (typeof v === 'number' && isFinite(v)) {
			return Math.round(v * STRATEGIC_WEIGHT * 1000) / 1000;
		}
	} catch (e) { _swallow(e); }
	return 0;
}

/* ================= ③ 本回合 provenance ================= */

let _records = [];
let _phaseKey = null;

function _currentPhaseKey() {
	try {
		const cp = (typeof _status !== 'undefined' && _status) ? _status.currentPhase : null;
		if (!cp) return '';
		return String(cp.playerid || cp.name || cp.name1 || cp);
	} catch (e) { _swallow(e); return ''; }
}

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
		return String(target.playerid || target.name || target.name1 || '');
	} catch (e) { return ''; }
}

function _resolveTarget(t) {
	try {
		if (!t) return null;
		if (typeof t === 'object') return t;
		const players = (typeof game !== 'undefined' && game && game.players) ? game.players : [];
		for (const p of players) {
			if (p && (p.playerid === t || p.name === t || p.name1 === t)) return p;
		}
	} catch (e) { _swallow(e); }
	return null;
}

function _recordMatchesTarget(rec, target) {
	if (!rec || !target) return false;
	if (rec.targetRef) return rec.targetRef === target;
	return rec.targetName === _refKey(target);
}

function _activeStateKeys(target) {
	const out = {};
	try {
		const ids = strategicStateIdsIn(target);
		for (const id of ids) {
			const st = _stateOf(id);
			const key = _stateKey(st);
			if (key) out[key] = 1;
		}
	} catch (e) { _swallow(e); }
	return out;
}

function _recordStillActive(rec, target) {
	try {
		if (!rec || !_recordMatchesTarget(rec, target)) return false;
		const active = _activeStateKeys(target);
		return !!active[rec.stateKey];
	} catch (e) { _swallow(e); return false; }
}

/** 通用：记录一次 create-state 战略承诺。 */
export function recordStateCreation(actor, target, cardId, opts) {
	_syncPhase();
	opts = opts || {};
	try {
		if (!target || target.alive === false) return null;
		const state = _stateOf(cardId);
		if (!state) return null;
		const key = _stateKey(state);
		if (!key) return null;
		const rec = {
			operation: 'create-state',
			actor: actor || null,
			actorName: _refKey(actor),
			target: target,
			targetRef: target,
			targetName: _refKey(target),
			cardId: cardId,
			state: state,
			stateKey: key,
			stateType: state.family || 'state',
			zone: state.zone || null,
			createdAction: opts.action || opts.strat || null,
			createdTurn: (opts.turn != null) ? opts.turn : _currentPhaseKey(),
			strategicValue: (typeof opts.strategicValue === 'number')
				? opts.strategicValue
				: _stateValueOf(actor, target, cardId, opts),
			removed: false,
		};
		_records.push(rec);
		return rec;
	} catch (e) { _swallow(e); return null; }
}

/* 旧接口兼容：内部已完全委托通用状态记录。 */
export function recordControlState(actor, target, cardId, opts) {
	return recordStateCreation(actor, target, cardId, opts);
}

/** 从实际动作记录战略状态；非 create-state 动作自然返回 null。 */
export function recordStrategicStateFromAction(player, action, target) {
	_syncPhase();
	try {
		action = action || {};
		const rule = action.rule || action.id || action.cardId || null;
		if (!_stateOf(rule)) return null;
		let tgt = target || null;
		if (!tgt && action.target) tgt = _resolveTarget(action.target);
		tgt = _resolveTarget(tgt);
		if (!tgt) return null;
		return recordStateCreation(player, tgt, rule, { action: action.strat || action.rule || null });
	} catch (e) { _swallow(e); return null; }
}

export function recordSelfCreatedControl(player, action, target) {
	return recordStrategicStateFromAction(player, action, target);
}

export function getStrategicRecords() {
	_syncPhase();
	try { return _records.slice(); } catch (e) { _swallow(e); return []; }
}
export function getControlRecords() { return getStrategicRecords(); }

function _hasValidRecord(player, target, stateKey) {
	try {
		for (const r of _records) {
			if (!r || !_recordMatchesTarget(r, target)) continue;
			if (stateKey && r.stateKey !== stateKey) continue;
			if (_recordStillActive(r, target)) return true;
		}
	} catch (e) { _swallow(e); }
	return false;
}

export function clearTurnState() {
	_records = [];
	_phaseKey = _currentPhaseKey();
}

/* ================= ④ 状态移除 / 重建的一致性评分 ================= */

function _countAlternativeRemovals(target) {
	try {
		let n = _cardsOf(target, 'h').length + _cardsOf(target, 'e').length;
		const j = _judgeCardsOf(target);
		for (const c of j) {
			const id = _cardName(c, target);
			if (!_stateOf(id)) n++;
		}
		return n;
	} catch (e) { _swallow(e); return 0; }
}

/**
 * 目标级 remove-target-card 机会成本。
 * 若目标还有手牌/装备/其它非战略判定牌可拆，则只保留小额目标级 penalty；
 * 真正“拆哪张牌”交给 evaluateRemovalChoice 精确决定。
 */
export function evaluateDestroyPenalty(player, target, context) {
	const out = {
		penalty: 0,
		effectivePenalty: 0,
		selfCreated: false,
		controlValue: 0,
		ids: [],
		relation: 0,
		alternativeCount: 0,
		reason: '',
	};
	try {
		_syncPhase();
		if (!player || !target || target.alive === false) return out;
		const ids = strategicStateIdsIn(target);
		if (!ids.length) return out;
		const rel = _relOf(player, target, context);
		let value = 0;
		let selfCreated = false;
		for (const id of ids) {
			const st = _stateOf(id);
			const key = _stateKey(st);
			const v = delayedControlValue(player, id, rel, target, context);
			if (typeof v === 'number' && isFinite(v)) value += v;
			if (_hasValidRecord(player, target, key)) selfCreated = true;
		}
		out.ids = ids;
		out.relation = rel;
		out.controlValue = Math.round(value * 1000) / 1000;
		out.penalty = Math.round(value * STRATEGIC_WEIGHT * 1000) / 1000;
		out.alternativeCount = _countAlternativeRemovals(target);
		out.effectivePenalty = out.penalty;
		/* 敌方身上的有利控制若还有其它牌可拆，不应把整个目标否掉；
		 * 具体选牌层会强保护该状态。队友负面状态则保持完整鼓励。 */
		if (out.penalty > 0 && out.alternativeCount > 0) {
			out.effectivePenalty = Math.round(out.penalty * TARGET_ALTERNATIVE_DISCOUNT * 1000) / 1000;
		}
		out.selfCreated = selfCreated;
		out.reason = selfCreated ? 'self-created-state' : 'observed-state';
		return out;
	} catch (e) { _swallow(e); return out; }
}

/**
 * 具体卡牌级 removal utility。
 * adjustment > 0：鼓励移除；adjustment < 0：保护该状态。
 * 不返回 Infinity，不 hard-ban。
 */
export function evaluateRemovalChoice(player, target, card, context) {
	const out = {
		adjustment: 0,
		stateValue: 0,
		selfCreated: false,
		cardId: null,
		stateKey: '',
		reason: 'not-strategic-state',
	};
	try {
		_syncPhase();
		if (!player || !target || !card) return out;
		const id = _cardName(card, target);
		const st = _stateOf(id);
		if (!st) return out;
		const key = _stateKey(st);
		const value = _stateValueOf(player, target, id, context);
		const selfCreated = _hasValidRecord(player, target, key);
		let adjustment = -value * REMOVAL_CHOICE_WEIGHT;
		/* 自己刚建立且仍有利的状态，再加一层“战略承诺”机会成本。 */
		if (selfCreated && value > 0) adjustment -= value * 0.8;
		out.cardId = id;
		out.stateKey = key;
		out.stateValue = value;
		out.selfCreated = selfCreated;
		out.adjustment = Math.round(adjustment * 1000) / 1000;
		out.reason = adjustment < 0 ? 'protect-beneficial-state' : (adjustment > 0 ? 'remove-harmful-state' : 'neutral-state');
		return out;
	} catch (e) { _swallow(e); return out; }
}

/**
 * 同回合“刚建立 → 已消失 → 又在同一目标重建同一战略状态”的 reversal penalty。
 * 换目标不罚；仍在生效不罚；负价值旧状态不产生正向承诺。
 */
export function evaluateCreateConsistency(player, target, cardId, context) {
	const out = { penalty: 0, stateKey: '', prior: null, reason: '' };
	try {
		_syncPhase();
		if (!player || !target || target.alive === false) return out;
		const st = _stateOf(cardId);
		if (!st) return out;
		const key = _stateKey(st);
		out.stateKey = key;

		for (let i = _records.length - 1; i >= 0; i--) {
			const rec = _records[i];
			if (!rec || rec.stateKey !== key || !_recordMatchesTarget(rec, target)) continue;
			out.prior = rec;
			if (_recordStillActive(rec, target)) {
				out.reason = 'state-still-active';
				return out;
			}
			rec.removed = true;   /* 真实状态已不存在，标记为本回合已失效；不猜是谁移除。 */
			const committed = Math.max(0, Number(rec.strategicValue) || 0);
			out.penalty = Math.round(committed * REAPPLY_WEIGHT * 1000) / 1000;
			out.reason = out.penalty > 0 ? 'reapply-removed-state' : 'prior-state-not-beneficial';
			return out;
		}
		return out;
	} catch (e) { _swallow(e); return out; }
}

/**
 * Engine 唯一入口：给任意动作 id 计算本回合战略转移 penalty。
 * 具体牌 → operation/state 的解释由 gameProfile 完成。
 */
export function evaluateActionTransitionPenalty(player, target, actionId, context) {
	const out = { penalty: 0, operation: '', detail: null, reason: '' };
	try {
		const e = _effectOf(actionId);
		if (!e || !e.operation) return out;
		out.operation = e.operation;
		if (e.operation === 'create-state') {
			const d = evaluateCreateConsistency(player, target, actionId, context);
			out.penalty = d.penalty || 0;
			out.detail = d;
			out.reason = d.reason || '';
			return out;
		}
		if (e.operation === 'remove-target-card') {
			const d = evaluateDestroyPenalty(player, target, context);
			out.penalty = d.effectivePenalty || 0;
			out.detail = d;
			out.reason = d.reason || '';
			return out;
		}
		return out;
	} catch (e) { _swallow(e); return out; }
}

/* 旧便捷接口保留：返回未折扣的状态价值，避免改变旧调用语义。 */
export function selfCreatedDestructionPenalty(player, target, context) {
	return evaluateDestroyPenalty(player, target, context).penalty;
}

export default {
	getJudgeCardNames, strategicStateIdsIn, delayedControlIdsIn, hasDelayedControl,
	evaluateDestroyPenalty, evaluateRemovalChoice, evaluateCreateConsistency,
	evaluateActionTransitionPenalty, selfCreatedDestructionPenalty,
	recordStateCreation, recordStrategicStateFromAction,
	recordControlState, recordSelfCreatedControl,
	getStrategicRecords, getControlRecords, clearTurnState,
};
