/*
 * ============================================
 * // 著者: Feisheng Original
 * 交流群: 123456789
 * v3.1α
 * 版权所有，侵权必究
 * ============================================
 */

/* ================= 决策积分引擎 · 原生 AI 接管层 =================
 * 策略：软接管（不硬接管），只用无名杀官方 AI 接口：
 *   · mod.aiOrder   → 出牌优先级修正
 *   · mod.aiValue   → 卡牌价值修正
 *   · ai.effect      → 目标选择修正
 *   · ai.useful      → 是否值得用修正
 * 把 bestAction 的结论翻译成原生 AI 能理解的分数修正。
 * 不破坏响应/弃牌/拼点 AI，只做加法修正。
 */
import { lib, game, get, _status } from '../../foundation/adapt/host.js';
import { bestAction } from '../engine/engine.js';
import { skillProfileOf } from '../skills/skills.js';
import { cfg } from '../../foundation/config/util.js';
import { isAllyOf, dispositionOf } from '../relations/relations.js';   /* ★ 指令 05 Stage B：敌我唯一权威源 */

const SKILL_ID = '_djsc_engine';

/* ★ 指令 02：显式重铸判定。
 * engine 的 bestAction 标记 recast（即 evaluator 判定「重铸优于任何使用」）时，
 * 不得再把该牌（尤其铁索连环）的 aiOrder / aiValue / useful 推高，
 * 否则原生 AI 只会优先"打出该牌"，直接堵死宿主重铸路径。
 * 纯谓词，不依赖宿主对象，便于门禁直接断言。 */
export function isRecastRecommended(ba) {
	return !!(ba && ba.recast === true);
}

const CACHE = new Map();          // player → { key, value }
let _installed = false;
let _protoHooked = false;
let _skillTargetHooked = false;
/* ★ M09：备份被换装的底层方法原引用，卸载时原样还原，避免热重载残留 */
const _protoBackup = {
	addSkill: null, getSkills: null, gameCheck: null,
	chooseTarget: null, chooseCardTarget: null, chooseButtonTarget: null,
	chooseButton: null, chooseControl: null,
};

/* ================= ★ 软接管打点（决策级去重） ================= */
const _softCounted = new Map();  // player → round标记

function _softStat(player) {
	try {
		if (!player) return;
		const round = (_status && _status.roundNumber) || 0;
		const name = player.name1 || player.name || '?';
		const key = name + '|' + round;
		if (_softCounted.get(player) === key) return;  // 本回合已计
		_softCounted.set(player, key);
		if (!_status.djsc_overrideStats) {
			_status.djsc_overrideStats = { use: {}, respond: {}, discard: {}, compare: {}, soft: {} };
		}
		if (!_status.djsc_overrideStats.soft) _status.djsc_overrideStats.soft = {};
		const b = _status.djsc_overrideStats.soft;
		b.hit = (b.hit || 0) + 1;
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}

/* ---------- 缓存：同一玩家同一回合只算一次 bestAction ---------- */
function _playerKey(player) {
	try {
		const name = player.name1 || player.name || player.name2 || '?';
		const round = (_status && _status.roundNumber) || 0;
		const isPhase = (_status && _status.currentPhase) === player ? 'P' : 'O';
		return name + '|' + round + '|' + isPhase;
	} catch (e) { return null; }
}

function _getBA(player) {
	try {
		if (!player || player === game.me) return null;
		try { if (player.isOnline2 && player.isOnline2()) return null; } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
		if (cfg('decisionScore', true) === false) return null;

		const k = _playerKey(player);
		if (!k) return null;
		const hit = CACHE.get(player);
		if (hit && hit.key === k) return hit.value;

		const ba = bestAction();
		CACHE.set(player, { key: k, value: ba });

		/* ★ 决策日志去重：同一玩家同一回合只记录一次 */
		try {
			const logKey = '__logged_' + k;
			if (!CACHE.has(logKey)) {
				CACHE.set(logKey, true);
				if (typeof window !== 'undefined' && window.__DJSC && typeof window.__DJSC.logBestAction === 'function') {
					window.__DJSC.logBestAction(player, ba);
				}
			}
		} catch (eLog) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(eLog); }

		return ba;
	} catch (e) { return null; }
}

function _clearCache() {
	try {
		CACHE.clear();
		_softCounted.clear();
		/* 清空 __logged_ 标记 */
		if (typeof CACHE.forEach === 'function') {
			const toDelete = [];
			CACHE.forEach(function (v, k) {
				if (typeof k === 'string' && k.indexOf('__logged_') === 0) toDelete.push(k);
			});
			toDelete.forEach(function (k) { CACHE.delete(k); });
		}
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}

/* ---------- 牌名匹配：兼容 viewAs（武圣/龙胆/奇才） ---------- */
function _cardMatches(card, player, rule) {
	try {
		if (!card || !rule) return false;
		if (get.name(card, player) === rule) return true;
		try {
			const info = get.info(card);
			if (info && info.viewAs) {
				const va = info.viewAs;
				const nm = (typeof va === 'string') ? va : (va && va.name);
				if (nm === rule) return true;
			}
		} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
		return false;
	} catch (e) { return false; }
}

/* ================= ★ Skill Decision Kernel V2 · 宿主目标桥 =================
 * 内部 engine 已经决定“哪个技能 + 哪个目标”后，把该高置信方向作为有限偏置
 * 注入真实 chooseTarget / chooseCardTarget 事件。
 * 不修改 filterTarget，不制造非法目标；无法解析技能/目标时完全 fail-open。
 */

function _samePlayer(a, b) {
	if (!a || !b) return false;
	if (a === b) return true;
	try {
		const ak = a.playerid || a.name1 || a.name || '';
		const bk = b.playerid || b.name1 || b.name || '';
		return !!ak && ak === bk;
	} catch (e) { return false; }
}

function _parentEventOf(ev) {
	try {
		if (!ev) return null;
		if (typeof ev.getParent === 'function') {
			const p = ev.getParent();
			if (p && p !== ev) return p;
		}
		return ev.parent || null;
	} catch (e) { return null; }
}

export function resolveActiveSkillContext(player, startEvent) {
	try {
		let ev = startEvent || (_status && _status.event) || null;
		for (let depth = 0; ev && depth < 7; depth++) {
			const cand = [ev.skill, ev.sourceSkill, ev.skillName, ev.name];
			for (const id of cand) {
				if (typeof id !== 'string' || !id || id === SKILL_ID) continue;
				/* 真正 lib.skill 条目是技能对象；普通事件名 chooseTarget/phaseUse 等
				 * 即使某些测试/扩展 Proxy 对未知 key 返回函数，也不能误认成技能。 */
				const info = lib.skill && lib.skill[id];
				if (info && typeof info === 'object') return { id: id, event: ev };
			}
			ev = _parentEventOf(ev);
		}
		return null;
	} catch (e) { return null; }
}

export function resolveActiveSkillId(player, startEvent) {
	const ctx = resolveActiveSkillContext(player, startEvent);
	return ctx ? ctx.id : null;
}

function _findActionTarget(ba) {
	try {
		if (!ba) return null;
		if (ba.targetObj && typeof ba.targetObj === 'object') return ba.targetObj;
		const name = Array.isArray(ba.target) ? ba.target[0] : ba.target;
		if (!name) return null;
		for (const p of (game.players || [])) {
			if (!p) continue;
			if ((p.playerid || '') === name || (p.name1 || p.name || '') === name) return p;
		}
		return null;
	} catch (e) { return null; }
}

function _findActionTargets(ba) {
	try {
		const out = [];
		if (ba && Array.isArray(ba.targetList)) {
			for (const p of ba.targetList) {
				if (p && typeof p === 'object' && out.indexOf(p) < 0) out.push(p);
			}
		}
		const primary = _findActionTarget(ba);
		if (primary && out.indexOf(primary) < 0) out.unshift(primary);
		return out;
	} catch (e) { return []; }
}

export function getSkillTargetBridgeDecision(player, sid, baOverride) {
	try {
		if (!player || !sid) return null;
		const ba = baOverride || _getBA(player);
		if (!ba || ba.type !== 'skill' || ba.id !== sid) return null;
		/* 必须经过 kernel 合法目标池解析；Stage 2 允许“同一次 chooseTarget 事件内”的
		 * 同方向多目标组合，但 mixed / 无 provenance / 低置信仍 fail-open。 */
		const confidence = Number(ba.targetConfidence || 0);
		if (ba.skillTargetResolved !== true || confidence < 0.55) return null;
		if (ba.skillTargetSingle !== true && (!Array.isArray(ba.targetList) || !ba.targetList.length)) return null;
		const targets = _findActionTargets(ba);
		if (!targets.length) return null;
		const target = targets[0];
		const purpose = ba.purpose || ((ba.rule === 'attack' || ba.rule === 'control') ? 'attack'
			: ((ba.rule === 'defense' || ba.rule === 'aux') ? 'support' : null));
		if (purpose !== 'attack' && purpose !== 'support') return null;
		if (ba.targetIntent === 'support' && purpose !== 'support') return null;
		if (ba.targetIntent === 'offense' && purpose !== 'attack') return null;
		if (ba.targetIntent !== 'support' && ba.targetIntent !== 'offense') return null;
		return {
			skillId: sid,
			target: target,
			targets: targets,
			targetName: target.playerid || target.name1 || target.name || '',
			targetRangeResolved: ba.targetRangeResolved !== false,
			purpose: purpose,
			intent: ba.targetIntent,
			confidence: confidence,
			score: Number(ba.score || 0),
		};
	} catch (e) { return null; }
}

export function wrapSkillTargetAI(original, player, decision) {
	if (!decision || !player) return original;
	if (original && original.__djscSkillTargetBridge === decision.skillId + '|' + decision.targetName) return original;
	const wrapped = function (target) {
		let nativeScore = 0;
		try {
			if (typeof original === 'function') {
				const n = Number(original.apply(this, arguments));
				if (Number.isFinite(n)) nativeScore = n;
			}
		} catch (e) {}
		try {
			if (!target) return nativeScore;
			const plannedTargets = Array.isArray(decision.targets) && decision.targets.length ? decision.targets : [decision.target];
			if (plannedTargets.some(function (p) { return _samePlayer(target, p); })) return Math.max(nativeScore, 12);
			const rel = dispositionOf(player, target);
			if (decision.purpose === 'support') {
				if (rel < 0) return Math.min(nativeScore, -12);
				if (rel > 0) return nativeScore + 1.5;
				return nativeScore - 1;
			}
			if (decision.purpose === 'attack') {
				if (rel > 0) return Math.min(nativeScore, -12);
				if (rel < 0) return nativeScore + 1.5;
				return nativeScore - 1;
			}
		} catch (e) {}
		return nativeScore;
	};
	try {
		Object.defineProperty(wrapped, '__djscSkillTargetBridge', {
			value: decision.skillId + '|' + decision.targetName,
			configurable: true,
		});
	} catch (e) {}
	return wrapped;
}

function _eventFilterDependsOnCard(filterTarget) {
	try {
		if (typeof filterTarget !== 'function') return false;
		const src = filterTarget.toString();
		const body = src.indexOf('=>') >= 0 ? src.slice(src.indexOf('=>') + 2) : src.slice(src.indexOf('{') + 1);
		return /\bcard\b/.test(body);
	} catch (e) { return true; }
}

export function eventAcceptsSkillTarget(next, player, target) {
	try {
		if (!next || !target) return false;
		const ft = next.filterTarget;
		if (typeof ft !== 'function') return true;
		/* chooseCardTarget 的合法性如果依赖尚未选定的 card，就不猜。 */
		if (_eventFilterDependsOnCard(ft)) return false;
		try { return ft(null, player, target) !== false; } catch (e) { return false; }
	} catch (e) { return false; }
}

function _eventFilterDependsOnSelection(filterTarget) {
	try {
		if (typeof filterTarget !== 'function') return false;
		const src = filterTarget.toString();
		const body = src.indexOf('=>') >= 0 ? src.slice(src.indexOf('=>') + 2) : src.slice(src.indexOf('{') + 1);
		/* 多目标组合合法性若依赖已选目标/实时事件，不能通过逐目标静态调用证明。 */
		return /ui\s*\.\s*selected|_status\s*\.\s*event|get\s*\.\s*event\s*\(/.test(body);
	} catch (e) { return true; }
}

function _eventFixedTargetCount(next) {
	try {
		if (!next) return null;
		const st = next.selectTarget;
		if (typeof st === 'number') return st >= 0 ? st : null;
		if (Array.isArray(st) && st.length >= 2) {
			const a = Number(st[0]), b = Number(st[1]);
			if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && a === b) return a;
			return null;
		}
		if (st == null && typeof next.filterTarget === 'function') return 1;
		return null;
	} catch (e) { return null; }
}

export function eventAcceptsSkillTargetPlan(next, player, decision) {
	try {
		if (!decision || !decision.target) return false;
		const planned = Array.isArray(decision.targets) && decision.targets.length ? decision.targets : [decision.target];
		/* 组合合法性依赖实时已选目标时，连第一目标也不预执行 filterTarget，
		 * 直接 fail-open，避免拿“空选择态”误证明整组合法。 */
		if (planned.length > 1 && _eventFilterDependsOnSelection(next && next.filterTarget)) return false;
		if (!eventAcceptsSkillTarget(next, player, planned[0])) return false;
		if (planned.length <= 1) return true;
		if (decision.targetRangeResolved !== true) return false;
		const fixed = _eventFixedTargetCount(next);
		if (fixed !== planned.length) return false;
		for (const t of planned) {
			if (!eventAcceptsSkillTarget(next, player, t)) return false;
		}
		return true;
	} catch (e) { return false; }
}

export function bridgeSkillTargetChoiceOnce(next, player, skillContext, field, baOverride) {
	try {
		if (!skillContext || !skillContext.id) return next;
		const ownerEvent = skillContext.event || null;
		if (ownerEvent && ownerEvent.__djscSkillTargetBridgeConsumed) return next;
		const out = bridgeSkillTargetEvent(next, player, skillContext.id, field, baOverride);
		if (out && out.__djscSkillTargetDecision && ownerEvent) {
			try {
				ownerEvent.__djscSkillTargetBridgeConsumed = {
					skillId: skillContext.id,
					target: out.__djscSkillTargetDecision.targetName,
				};
			} catch (e) {}
		}
		return out;
	} catch (e) { return next; }
}

export function bridgeSkillTargetEvent(next, player, sid, field, baOverride) {
	try {
		if (!next || !player || !sid || !field) return next;
		const decision = getSkillTargetBridgeDecision(player, sid, baOverride);
		if (!decision) return next;
		if (!eventAcceptsSkillTargetPlan(next, player, decision)) return next;
		if (typeof next[field] === 'function') next[field] = wrapSkillTargetAI(next[field], player, decision);

		/* 很多本体技能是 chooseTarget(...).set('ai', fn)：
		 * 拦截这个“后写 ai”，否则刚桥接完又会被技能自己的 set 覆盖。 */
		if (typeof next.set === 'function' && !next.__djscSkillTargetSetBridge) {
			const origSet = next.set;
			next.set = function (key, value) {
				if (key === field && typeof value === 'function') {
					value = wrapSkillTargetAI(value, player, decision);
				}
				return origSet.call(this, key, value);
			};
			try { next.__djscSkillTargetSetBridge = true; } catch (e) {}
		}
		try {
			next.__djscSkillTargetDecision = decision;
			_softStat(player);
		} catch (e) {}
		return next;
	} catch (e) { return next; }
}

export function wrapSkillCostCardAI(original, player, decision) {
	if (!decision || !player) return original;
	const tag = decision.skillId + '|' + decision.targetName;
	if (original && original.__djscSkillCostBridge === tag) return original;
	const wrapped = function (card) {
		let nativeScore = 0;
		try {
			if (typeof original === 'function') {
				const n = Number(original.apply(this, arguments));
				if (Number.isFinite(n)) nativeScore = n;
			}
		} catch (e) {}
		try {
			let owner = null;
			try { owner = get.owner ? get.owner(card) : null; } catch (e) {}
			if (owner && owner !== player) return nativeScore;
			const v = Number(get.value(card, player));
			if (!Number.isFinite(v)) return nativeScore;
			const tie = Math.max(-0.2, Math.min(0.2, -v * 0.02));
			return nativeScore + tie;
		} catch (e) { return nativeScore; }
	};
	try { Object.defineProperty(wrapped, '__djscSkillCostBridge', { value: tag, configurable: true }); } catch (e) {}
	return wrapped;
}

export function bridgeSkillCardCostEvent(next, player, sid, field, baOverride) {
	try {
		if (!next || !player || !sid || !field || next.processAI) return next;
		const decision = getSkillTargetBridgeDecision(player, sid, baOverride);
		if (!decision) return next;
		/* 联合选牌只跟随“同一个 chooseCardTarget 事件里已经成功桥接的目标计划”。
		 * 若目标桥因 consumed / stage mismatch / card-dependent filter 而 fail-open，
		 * 牌半边也必须一起 fail-open。 */
		const attached = next.__djscSkillTargetDecision;
		if (!attached || attached.skillId !== sid) return next;
		if (!eventAcceptsSkillTargetPlan(next, player, decision)) return next;
		if (typeof next[field] === 'function') next[field] = wrapSkillCostCardAI(next[field], player, decision);
		if (typeof next.set === 'function' && !next.__djscSkillCostSetBridge) {
			const origSet = next.set;
			next.set = function (key, value) {
				if (key === field && typeof value === 'function') value = wrapSkillCostCardAI(value, player, decision);
				return origSet.call(this, key, value);
			};
			try { next.__djscSkillCostSetBridge = true; } catch (e) {}
		}
		return next;
	} catch (e) { return next; }
}

function _skillExplicitButtonDecision(player, sid, baOverride) {
	try {
		const ba = baOverride || _getBA(player);
		if (!ba || ba.type !== 'skill' || ba.id !== sid) return null;
		if (ba.rule === 'veto' || ba.rule === 'veto-target') return null;
		if (ba.buttonChoice === undefined || ba.buttonChoice === null) return null;
		return ba.buttonChoice;
	} catch (e) { return null; }
}

export function wrapExplicitSkillButtonAI(original, planned) {
	if (planned === null || planned === undefined) return original;
	const wrapped = function (button) {
		let nativeScore = 0;
		try {
			if (typeof original === 'function') {
				const n = Number(original.apply(this, arguments));
				if (Number.isFinite(n)) nativeScore = n;
			}
		} catch (e) {}
		try {
			if (!button) return nativeScore;
			if (button.link === planned || button === planned) return Math.max(nativeScore, 12);
		} catch (e) {}
		return nativeScore;
	};
	return wrapped;
}

export function bridgeSkillButtonEvent(next, player, sid, field, baOverride) {
	try {
		if (!next || !player || !sid || !field || next.processAI) return next;
		/* button.link 即使恰好是玩家，也可能表示技能内部另一种角色/分支语义。
		 * 只有 planner 明确产出 buttonChoice 才允许接管；否则完全原生。 */
		const planned = _skillExplicitButtonDecision(player, sid, baOverride);
		if (planned === null) return next;
		if (typeof next[field] === 'function') next[field] = wrapExplicitSkillButtonAI(next[field], planned);
		if (typeof next.set === 'function' && !next.__djscSkillButtonSetBridge) {
			const origSet = next.set;
			next.set = function (key, value) {
				if (key === field && typeof value === 'function') value = wrapExplicitSkillButtonAI(value, planned);
				return origSet.call(this, key, value);
			};
			try { next.__djscSkillButtonSetBridge = true; } catch (e) {}
		}
		return next;
	} catch (e) { return next; }
}

function _skillExplicitControlDecision(player, sid, baOverride) {
	try {
		const ba = baOverride || _getBA(player);
		if (!ba || ba.type !== 'skill' || ba.id !== sid) return null;
		if (ba.rule === 'veto' || ba.rule === 'veto-target') return null;
		/* chooseControl 的语义高度技能特化。只有 planner 明确产出 controlChoice
		 * 才允许桥接；“唯一非取消项”本身不代表继续子效果一定更优。 */
		if (ba.controlChoice === undefined || ba.controlChoice === null) return null;
		return ba.controlChoice;
	} catch (e) { return null; }
}

export function bridgeSkillControlEvent(next, player, sid, baOverride) {
	try {
		if (!next || !player || !sid || next.processAI) return next;
		const planned = _skillExplicitControlDecision(player, sid, baOverride);
		if (planned === null) return next;
		const wrap = function (original) {
			return function () {
				try {
					const controls = Array.isArray(next.controls) ? next.controls : [];
					if (typeof planned === 'number' && planned >= 0 && planned < controls.length) return planned;
					const idx = controls.indexOf(planned);
					if (idx >= 0) return idx;
				} catch (e) {}
				try { return typeof original === 'function' ? original.apply(this, arguments) : 0; } catch (e) { return 0; }
			};
		};
		next.ai = wrap(typeof next.ai === 'function' ? next.ai : null);
		if (typeof next.set === 'function' && !next.__djscSkillControlSetBridge) {
			const origSet = next.set;
			next.set = function (key, value) {
				if (key === 'ai' && typeof value === 'function') value = wrap(value);
				return origSet.call(this, key, value);
			};
			try { next.__djscSkillControlSetBridge = true; } catch (e) {}
		}
		return next;
	} catch (e) { return next; }
}

function _hookSkillTargetChoice() {
	if (_skillTargetHooked) return;
	try {
		const proto = lib.element && lib.element.Player && lib.element.Player.prototype;
		if (!proto) return;

		const origChooseTarget = proto.chooseTarget;
		if (typeof origChooseTarget === 'function') {
			_protoBackup.chooseTarget = origChooseTarget;
			proto.chooseTarget = function () {
				const skillCtx = resolveActiveSkillContext(this, _status && _status.event);
				const next = origChooseTarget.apply(this, arguments);
				return skillCtx ? bridgeSkillTargetChoiceOnce(next, this, skillCtx, 'ai') : next;
			};
		}

		const origChooseCardTarget = proto.chooseCardTarget;
		if (typeof origChooseCardTarget === 'function') {
			_protoBackup.chooseCardTarget = origChooseCardTarget;
			proto.chooseCardTarget = function () {
				const skillCtx = resolveActiveSkillContext(this, _status && _status.event);
				const next = origChooseCardTarget.apply(this, arguments);
				if (!skillCtx) return next;
				bridgeSkillTargetChoiceOnce(next, this, skillCtx, 'ai2');
				bridgeSkillCardCostEvent(next, this, skillCtx.id, 'ai1');
				return next;
			};
		}

		const origChooseButtonTarget = proto.chooseButtonTarget;
		if (typeof origChooseButtonTarget === 'function') {
			_protoBackup.chooseButtonTarget = origChooseButtonTarget;
			proto.chooseButtonTarget = function () {
				const skillCtx = resolveActiveSkillContext(this, _status && _status.event);
				const next = origChooseButtonTarget.apply(this, arguments);
				if (!skillCtx) return next;
				bridgeSkillTargetChoiceOnce(next, this, skillCtx, 'ai2');
				bridgeSkillButtonEvent(next, this, skillCtx.id, 'ai1');
				return next;
			};
		}

		const origChooseButton = proto.chooseButton;
		if (typeof origChooseButton === 'function') {
			_protoBackup.chooseButton = origChooseButton;
			proto.chooseButton = function () {
				const skillCtx = resolveActiveSkillContext(this, _status && _status.event);
				const next = origChooseButton.apply(this, arguments);
				return skillCtx ? bridgeSkillButtonEvent(next, this, skillCtx.id, 'ai') : next;
			};
		}

		const origChooseControl = proto.chooseControl;
		if (typeof origChooseControl === 'function') {
			_protoBackup.chooseControl = origChooseControl;
			proto.chooseControl = function () {
				const skillCtx = resolveActiveSkillContext(this, _status && _status.event);
				const next = origChooseControl.apply(this, arguments);
				return skillCtx ? bridgeSkillControlEvent(next, this, skillCtx.id) : next;
			};
		}

		_skillTargetHooked = !!(_protoBackup.chooseTarget || _protoBackup.chooseCardTarget
			|| _protoBackup.chooseButtonTarget || _protoBackup.chooseButton || _protoBackup.chooseControl);
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}

/* ================= ★ 原生 skill effect 方向守卫 =================
 * 与 bestAction 无关：当无名杀原生 AI 自己评估某个主动技能目标时，也统一消费
 * Skill Decision Kernel 的 target intent，防止“内部认为不该资敌，但原生技能 AI 绕过”。
 */

export function skillTargetDirectionAdjustment(intent, confidence, relation) {
	const c = Number(confidence || 0);
	if (c < 0.55) return 0;
	if (intent === 'support') {
		if (relation < 0) return -12;
		if (relation > 0) return 1.5;
		return -1;
	}
	if (intent === 'offense') {
		if (relation > 0) return -12;
		if (relation < 0) return 1.5;
		return -1;
	}
	return 0;
}

function _skillIdFromEffectSubject(subject) {
	try {
		if (typeof subject !== 'string' || !subject) return null;
		const sk = lib.skill && lib.skill[subject];
		return sk && typeof sk === 'object' ? subject : null;
	} catch (e) { return null; }
}

export function skillDirectionEffectModifier(subject, player, target) {
	try {
		const sid = _skillIdFromEffectSubject(subject);
		if (!sid || !player || !target) return null;
		const prof = skillProfileOf(sid);
		if (!prof || !prof.targets) return null;
		const intent = prof.targets.intent;
		const confidence = Number(prof.targets.confidence || 0);
		if (intent !== 'support' && intent !== 'offense') return null;
		const rel = dispositionOf(player, target);
		const delta = skillTargetDirectionAdjustment(intent, confidence, rel);
		if (!delta) return null;
		return [1, delta];
	} catch (e) { return null; }
}

/* ---------- 安装 ---------- */
export function installAIOverride() {
	if (_installed || lib.skill[SKILL_ID]) return;
	try {
		lib.skill[SKILL_ID] = {
			silent: true,
			charlotte: true,
			superCharlotte: true,
			unique: true,
			temp: true,           // ★ 玩家死亡时自动清理
			invisible: true,      // ★ 不在技能列表显示
			mod: {
				/* ★ ① 出牌优先级修正 */
				aiOrder(player, card, num) {
					try {
						const ba = _getBA(player);
						if (!ba || !ba.rule) return num;
						if (ba.action === 'C' && ba.rule === 'end') {
							return Math.min(num, 0.01);
						}
						/* ★ 指令 02：显式重铸 → 主动让出顺序。宿主 _recasting 技能 order=6，
						 * 仅「不推高」不足以让位；必须把铁索自身使用顺序压到 6 以下，
						 * 重铸才会真正发生。 */
						if (isRecastRecommended(ba)) {
							return Math.min(num, 5);
						}
						if (_cardMatches(card, player, ba.rule)) {
							_softStat(player);  // ★ 软接管命中打点
							return 100 + num;
						}
						return num;
					} catch (e) { return num; }
				},

				/* ★ ② 卡牌价值修正（软接管：只加不减） */
				aiValue(player, card, num) {
					try {
						const ba = _getBA(player);
						if (!ba) return num;

						/* ★ 指令 02：显式重铸 → 不额外加价值 */
						if (isRecastRecommended(ba)) {
							return num;
						}

						/* 如果是我们推荐的牌 → 加价值 */
						if (ba.rule && _cardMatches(card, player, ba.rule)) {
							return num + 2.0;
						}

						/* 如果是打队友的牌 → 减价值 */
						const cardId = get.name(card, player);
						const isAttack = ['sha', 'juedou', 'huogong', 'nanman', 'wanjian'].indexOf(cardId) >= 0;
						if (isAttack && ba.avoidAlly) {
							return num - 1.5;
						}

						return num;
					} catch (e) { return num; }
				},
			},
			ai: {
				/* ★ ③ 目标选择修正 */
				effect: {
					player(card, player, target) {
						try {
							if (get.itemtype(target) !== 'player') return;

							/* ★ 技能方向先于 bestAction：原生技能 AI 评估也必须遵守统一敌友语义。
							 * 这样即使该技能被 engine 降权、没有成为 bestAction，也不能绕过去资敌。 */
							const skillDir = skillDirectionEffectModifier(card, player, target);
							if (skillDir) return skillDir;

							const ba = _getBA(player);
							if (!ba) return;

							const tname = target.name || target.name1;
							const isAtk = get.tag(card, 'damage');
							const isDelay = (function () {
								const id = get.name(card, player);
								return id === 'lebu' || id === 'bingliang';
							})();

							/* ★ 修正：ba.target 可能是数组（铁锁连环等多目标牌），需包含匹配 */
							const tgtMatch = Array.isArray(ba.target)
								? ba.target.indexOf(tname) >= 0
								: (tname === ba.target);

							if (ba.target && tgtMatch) {
								if (isAtk) return [1, 2.5];
								if (isDelay) return [1, 2.0];
								return [1, 1.0];
							}

							if (isAllyOf(player, target) && isAtk) {
								/* 濒死队友：灭队级抑制 */
								if ((target.hp || 0) <= 1) return [1, -5.0];
								return [1, -3.0];
							}
						} catch (e) { return; }
					},
				},

				/* ★ ④ 是否值得用修正 */
				useful(player, event) {
					try {
						const ba = _getBA(player);
						if (!ba) return;

						/* ★ 指令 02：显式重铸 → 不标为「值得用」 */
						if (isRecastRecommended(ba)) {
							return;
						}

						/* 如果是我们推荐的动作 → 提高有用性 */
						if (ba.rule && event && event.card && _cardMatches(event.card, player, ba.rule)) {
							return 1.5;
						}

						return;
					} catch (e) { return; }
				},
			},
		};

		(game.players || []).forEach(function (p) {
			try {
				if (p && p !== game.me && !p.hasSkill(SKILL_ID)) p.addSkill(SKILL_ID);
			} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
		});

		_hookAddSkill();
		_hookRoundChange();
		_hookSkillTargetChoice();

		_installed = true;
		try { if (game.log) game.log('决策积分引擎：原生 AI 软接管层已安装（aiOrder + aiValue + effect + useful）'); } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
	} catch (e) {
		try { console.error('[决策积分引擎] installAIOverride 失败：', e); } catch (e2) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e2); }
	}
}

function _hookAddSkill() {
	if (_protoHooked) return;
	try {
		const proto = lib.element.Player.prototype;
		const orig = proto.addSkill;
		if (typeof orig !== 'function') return;
		_protoBackup.addSkill = orig;   /* ★ M09：存下原生 addSkill，卸载时还原 */
		proto.addSkill = function () {
			const r = orig.apply(this, arguments);
			try {
				if (this !== game.me && !this.hasSkill(SKILL_ID) && lib.skill[SKILL_ID]) {
					orig.call(this, SKILL_ID);
				}
			} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
			return r;
		};
		_protoHooked = true;

		/* ★ 修复左慈死亡 temp 报错：过滤掉 lib.skill[sid] 为 undefined 的残留技能 */
		const origGetSkills = proto.getSkills;
		if (typeof origGetSkills === 'function') {
			_protoBackup.getSkills = origGetSkills;   /* ★ M09：存下原生 getSkills，卸载时还原 */
			proto.getSkills = function () {
				const skills = origGetSkills.apply(this, arguments);
				try {
					if (Array.isArray(skills) && skills.length > 0) {
						return skills.filter(function (sid) {
							return lib.skill[sid] !== undefined;
						});
					}
				} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
				return skills;
			};
		}
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}

function _hookRoundChange() {
	try {
		if (game.__djsc_check_hooked) return;
		game.__djsc_check_hooked = true;
		const orig = game.check;
		if (typeof orig !== 'function') return;
		_protoBackup.gameCheck = orig;   /* ★ M09：存下原生 game.check，卸载时还原 */
		game.check = function () {
			try { _clearCache(); } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
			return orig.apply(this, arguments);
		};
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
}

/* ---------- 卸载 ---------- */
export function uninstallAIOverride() {
	try { _clearCache(); } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
	/* ★ M09：还原被换装的底层方法（仅当仍是我们的包装时才还原，避免热重载残留） */
	try {
		var proto = (lib && lib.element && lib.element.Player) ? lib.element.Player.prototype : null;
		if (proto) {
			if (_protoBackup.addSkill && proto.addSkill !== _protoBackup.addSkill) proto.addSkill = _protoBackup.addSkill;
			if (_protoBackup.getSkills && proto.getSkills !== _protoBackup.getSkills) proto.getSkills = _protoBackup.getSkills;
			if (_protoBackup.chooseTarget && proto.chooseTarget !== _protoBackup.chooseTarget) proto.chooseTarget = _protoBackup.chooseTarget;
			if (_protoBackup.chooseCardTarget && proto.chooseCardTarget !== _protoBackup.chooseCardTarget) proto.chooseCardTarget = _protoBackup.chooseCardTarget;
			if (_protoBackup.chooseButtonTarget && proto.chooseButtonTarget !== _protoBackup.chooseButtonTarget) proto.chooseButtonTarget = _protoBackup.chooseButtonTarget;
			if (_protoBackup.chooseButton && proto.chooseButton !== _protoBackup.chooseButton) proto.chooseButton = _protoBackup.chooseButton;
			if (_protoBackup.chooseControl && proto.chooseControl !== _protoBackup.chooseControl) proto.chooseControl = _protoBackup.chooseControl;
		}
		var g = (typeof game !== 'undefined') ? game : null;
		if (g && _protoBackup.gameCheck && g.check !== _protoBackup.gameCheck) g.check = _protoBackup.gameCheck;
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
	/* ★ M09：复位标志，允许下次 install 重新正确地换装 */
	try {
		if (typeof game !== 'undefined') game.__djsc_check_hooked = false;
	} catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
	_protoHooked = false;
	_skillTargetHooked = false;
	try { delete lib.skill[SKILL_ID]; } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
	(game.players || []).forEach(function (p) {
		try { p.removeSkill(SKILL_ID); } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
	});
	_installed = false;
}

/* ---------- 挂载到全局 ---------- */
if (typeof window !== 'undefined') {
	window.__DJSC = window.__DJSC || {};
	window.__DJSC.aiOverride = {
		install: installAIOverride,
		uninstall: uninstallAIOverride,
		installed: function () { return _installed; },
	};
}
