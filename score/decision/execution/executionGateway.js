/*
 * 无名AI · Execution Gateway
 *
 * 唯一职责：统一“AI 决策如何进入宿主执行层”的公共边界。
 *
 * 策略模块仍负责算：
 *   - use 是否结束 / veto 哪张牌
 *   - respond 是否响应
 *   - discard 如何估值
 *   - compare 如何选点数
 *
 * Gateway 统一负责：
 *   - 是否允许接管（人类/联机/配置/熔断/降级/哨兵）
 *   - Host 调用与异常 fallback
 *   - Decision Transaction Stage / Commit / Cancel
 *   - 执行统计与诊断
 *
 * 任何新执行适配层都应复用本模块，不再自行维护一套 hardOverride/circuit/degrade。
 */

import { game, _status } from '../../foundation/adapt/host.js';
import { cfg } from '../../foundation/config/util.js';
import { trip, isTripped } from '../override/circuit.js';
import {
	stageDecisionTransaction,
	commitDecisionTransaction,
	cancelDecisionTransaction,
	peekDecisionTransaction,
} from '../state/decisionTransaction.js';

export const EXECUTION_KINDS = Object.freeze({
	USE: 'use',
	RESPOND: 'respond',
	DISCARD: 'discard',
	COMPARE: 'compare',
	SKILL: 'skill',
	END: 'end',
	OBSERVE: 'observe',
});

const OVERRIDE_CONFIG = Object.freeze({
	use: 'override_use',
	respond: 'override_respond',
	discard: 'override_discard',
	compare: 'override_compare',
});

const DEGRADE_WINDOW = 5000;
const _degraded = {
	use: new WeakMap(),
	respond: new WeakMap(),
	discard: new WeakMap(),
	compare: new WeakMap(),
};

const _stats = {
	total: 0,
	allowed: 0,
	blocked: 0,
	hostCalls: 0,
	hostErrors: 0,
	fallbacks: 0,
	staged: 0,
	committed: 0,
	cancelled: 0,
	byKind: {},
};

function _bucket(kind) {
	const k = String(kind || 'unknown');
	if (!_stats.byKind[k]) {
		_stats.byKind[k] = {
			allowed: 0, blocked: 0, hostCalls: 0, hostErrors: 0,
			fallbacks: 0, staged: 0, committed: 0, cancelled: 0,
		};
	}
	return _stats.byKind[k];
}

function _inc(kind, key) {
	try {
		if (Object.prototype.hasOwnProperty.call(_stats, key) && typeof _stats[key] === 'number') _stats[key]++;
		const b = _bucket(kind);
		if (Object.prototype.hasOwnProperty.call(b, key)) b[key]++;
	} catch (_) {}
}

function _playerBlocked(player) {
	if (!player) return 'missing-player';
	if (player === game.me) return 'local-human';
	try {
		if (player.isOnline2 && player.isOnline2()) return 'online-player';
	} catch (_) {}
	return null;
}

function _isDegraded(kind, player) {
	try {
		const map = _degraded[kind];
		if (!map || !player) return false;
		const ts = map.get(player);
		if (!ts) return false;
		if (Date.now() - ts > DEGRADE_WINDOW) {
			map.delete(player);
			return false;
		}
		return true;
	} catch (_) { return false; }
}

export function markExecutionFailure(kind, player, reason, severity) {
	kind = String(kind || 'global');
	try {
		const map = _degraded[kind];
		if (map && player) map.set(player, Date.now());
	} catch (_) {}
	try { trip(kind, reason || 'execution failure', severity || 'fatal'); } catch (_) {}
	_inc(kind, 'hostErrors');
}

export function clearExecutionDegrade(kind) {
	try {
		if (kind && _degraded[kind]) {
			_degraded[kind] = new WeakMap();
			return;
		}
		for (const k of Object.keys(_degraded)) _degraded[k] = new WeakMap();
	} catch (_) {}
}

export function executionEligibility(kind, player, event, options) {
	options = options || {};
	kind = String(kind || '');
	_stats.total++;

	const deny = function (reason) {
		_inc(kind, 'blocked');
		return { ok: false, reason };
	};

	const playerReason = _playerBlocked(player);
	if (playerReason) return deny(playerReason);
	if (!event && options.allowMissingEvent !== true) return deny('missing-event');

	/* soft/observer 可以显式跳过 hardOverride gate；核心硬接管默认必须开启。 */
	if (options.requireHardOverride !== false) {
		if (cfg('hardOverride', true) === false) return deny('hard-override-off');
		const configKey = OVERRIDE_CONFIG[kind];
		if (configKey && cfg(configKey, true) === false) return deny(configKey + '-off');
	}

	if (options.checkCircuit !== false && isTripped(kind)) return deny('circuit-tripped');
	if (_isDegraded(kind, player)) return deny('degraded');

	if (options.sentinel && event && event[options.sentinel]) return deny('already-overridden');

	if (options.requireCurrentPhase) {
		try {
			if (_status.currentPhase && _status.currentPhase !== player) return deny('outside-current-phase');
		} catch (_) {}
	}

	if (typeof options.extraGuard === 'function') {
		try {
			const r = options.extraGuard(player, event);
			if (r === false) return deny('extra-guard');
			if (typeof r === 'string' && r) return deny(r);
		} catch (_) {
			return deny('extra-guard-error');
		}
	}

	_inc(kind, 'allowed');
	return { ok: true, reason: 'allowed' };
}

export function isExecutionLayerEnabled(kind) {
	try {
		if (cfg('hardOverride', true) === false) return false;
		const key = OVERRIDE_CONFIG[kind];
		if (key && cfg(key, true) === false) return false;
		if (isTripped(kind)) return false;
		return true;
	} catch (_) { return false; }
}

export function markExecutionSentinel(event, sentinel) {
	try {
		if (event && sentinel) event[sentinel] = true;
		return true;
	} catch (_) { return false; }
}

export function clearExecutionSentinel(event, sentinel) {
	try {
		if (event && sentinel) delete event[sentinel];
		return true;
	} catch (_) { return false; }
}

/**
 * 唯一 Host 调用包装。
 *
 * 默认规则：
 * - primary host call 只执行一次；
 * - 抛异常才允许 fallback 再调用一次原生函数；
 * - cleanupOnSuccess 可由适配层决定（有些宿主 GameEvent 需要保留 ai/filter 到事件执行期）。
 */
export function invokeHost(options) {
	options = options || {};
	const kind = String(options.kind || 'unknown');
	const player = options.player || null;
	const orig = options.orig;
	const thisArg = options.thisArg || player;
	const args = Array.isArray(options.args) ? options.args : [];
	let cleanup = null;

	if (typeof orig !== 'function') {
		return { ok: false, reason: 'missing-host-function', result: null };
	}

	try {
		if (typeof options.prepare === 'function') cleanup = options.prepare() || null;
		_stats.hostCalls++;
		_inc(kind, 'hostCalls');
		const result = orig.apply(thisArg, args);
		if (typeof options.onSuccess === 'function') {
			try { options.onSuccess(result); } catch (_) {}
		}
		if (options.cleanupOnSuccess === true && typeof cleanup === 'function') {
			try { cleanup(); } catch (_) {}
			cleanup = null;
		}
		return { ok: true, result, reason: 'host-ok' };
	} catch (error) {
		if (typeof cleanup === 'function') {
			try { cleanup(); } catch (_) {}
			cleanup = null;
		}
		markExecutionFailure(kind, player,
			(typeof options.failureReason === 'function' ? options.failureReason(error) : options.failureReason) ||
			('host call failed: ' + (error && error.message ? error.message : error)),
			options.severity || 'fatal');

		if (options.fallback === false) return { ok: false, result: null, error, reason: 'host-error' };

		try {
			_stats.fallbacks++;
			_inc(kind, 'fallbacks');
			const fallbackResult = orig.apply(thisArg, args);
			return { ok: false, fallback: true, result: fallbackResult, error, reason: 'fallback-ok' };
		} catch (fallbackError) {
			return { ok: false, fallback: true, result: options.fallbackValue === undefined ? null : options.fallbackValue,
				error: fallbackError, reason: 'fallback-error' };
		}
	}
}

/**
 * decisionHook 等“观测型 wrapper”只允许调用宿主一次。
 * 观测失败不能为了检查结果再重跑原生决策。
 */
export function invokeObservedHost(options) {
	options = options || {};
	const orig = options.orig;
	if (typeof orig !== 'function') return { ok: false, result: null, reason: 'missing-host-function' };
	try {
		_stats.hostCalls++;
		_inc(EXECUTION_KINDS.OBSERVE, 'hostCalls');
		const result = orig.apply(options.thisArg, Array.isArray(options.args) ? options.args : []);
		return { ok: true, result, reason: 'host-ok' };
	} catch (error) {
		_inc(EXECUTION_KINDS.OBSERVE, 'hostErrors');
		return { ok: false, result: null, error, reason: 'host-error' };
	}
}

export function stageExecutionDecision(player, decision, kind) {
	try {
		const tx = decision && decision.__djscTransaction;
		if (!tx) return null;
		const staged = stageDecisionTransaction(player, tx);
		if (staged) _inc(kind || (tx.expected && tx.expected.type) || 'unknown', 'staged');
		return staged;
	} catch (_) { return null; }
}

export function commitExecution(player, actual) {
	try {
		const result = commitDecisionTransaction(player, actual);
		if (result && result.ok) _inc((actual && actual.type) || 'unknown', 'committed');
		return result;
	} catch (error) {
		return { ok: false, reason: 'commit-exception', error };
	}
}

export function cancelExecution(player, reason, kind) {
	try {
		const ok = cancelDecisionTransaction(player, reason);
		if (ok) _inc(kind || 'unknown', 'cancelled');
		return ok;
	} catch (_) { return false; }
}

export function pendingExecution(player) {
	try { return peekDecisionTransaction(player); } catch (_) { return null; }
}

export function executionGatewayStats() {
	try {
		return JSON.parse(JSON.stringify(_stats));
	} catch (_) {
		return { ..._stats, byKind: { ..._stats.byKind } };
	}
}

export function resetExecutionGateway() {
	_stats.total = 0;
	_stats.allowed = 0;
	_stats.blocked = 0;
	_stats.hostCalls = 0;
	_stats.hostErrors = 0;
	_stats.fallbacks = 0;
	_stats.staged = 0;
	_stats.committed = 0;
	_stats.cancelled = 0;
	_stats.byKind = {};
	clearExecutionDegrade();
}
