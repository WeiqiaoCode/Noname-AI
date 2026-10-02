/*
 * ============================================
 * // Wydawca: Feisheng Original
 * 交流群: 123456789
 * v3.1α
 * 版权所有，侵权必究
 * ============================================
 */

/* ============================================
 * ★ 全局缓存层（减少重复计算，解决卡顿发烫）
 * ============================================ */
/* ★ 指令 04：显式导入宿主，消除「隐式全局在非浏览器环境静默失效」。 */
import { game, get, _status } from '../adapt/host.js';

const _cache = new Map();
const _cacheTime = new Map();
const DEFAULT_TTL = 100; // 100ms缓存

/**
 * 获取缓存
 */
export function cacheGet(key, ttl = DEFAULT_TTL) {
    if (!_cache.has(key)) return null;
    const age = Date.now() - _cacheTime.get(key);
    if (age > ttl) {
        _cache.delete(key);
        _cacheTime.delete(key);
        return null;
    }
    return _cache.get(key);
}

/**
 * 设置缓存
 */
export function cacheSet(key, value) {
    _cache.set(key, value);
    _cacheTime.set(key, Date.now());
}

/**
 * 清空所有缓存
 */
export function cacheClear() {
    _cache.clear();
    _cacheTime.clear();
}

/**
 * 缓存统计
 */
export function cacheStats() {
    return {
/* Author: Feisheng Original, All rights reserved */
        size: _cache.size,
        keys: Array.from(_cache.keys()).slice(0, 10)
    };
}

/* ============================================
 * ★ 事件驱动：游戏状态变化时才清缓存
 * ============================================ */

let _lastStateKey = '';

/* 读取卡牌名的容错工具（宿主 get.name 优先，普通对象回退 .name） */
function _cacheCardName(card, player) {
    try {
        if (!card) return '';
        try {
            if (get && typeof get.name === 'function') {
                const n = get.name(card, player);
                if (typeof n === 'string' && n) return n;
            }
        } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
        if (typeof card.name === 'string') return card.name;
    } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
    return '';
}

/**
 * 生成当前游戏状态指纹
 * 优化：纳入更多关键状态维度，避免缓存返回过时决策。
 */
function makeStateKey() {
    try {
        const me = (typeof game !== 'undefined' && game.me) ? game.me : null;
        if (!me) return 'no_player';

        const parts = [
            me.hp || 0,                    // 我的血量
            me.countCards('h') || 0,      // 我的手牌数
            (game.alivePlayers || []).length,  // 存活玩家数
            me.maxHp || 0,                // 我的最大血量
        ];
        /* ★ 指令 04（State Freshness）：纳入各存活角色的判定区 / 装备区指纹。
         * 判定区落乐/兵/闪电、装备被拆/被顺后，「Action 1 resolved → next bestAction」
         * 必须看到最新状态，否则会自我抵消（先挂乐 → 又用顺/拆把乐拆掉）。 */
        try {
            const players = (game && Array.isArray(game.players)) ? game.players : [];
            for (const p of players) {
                if (!p || p.alive === false) continue;
                let jn = '';
                let en = '';
                try {
                    if (typeof p.getCards === 'function') {
                        const jc = p.getCards('j') || [];
                        const ec = p.getCards('e') || [];
                        jn = jc.map(function (c) { return _cacheCardName(c, p); }).join(',');
                        en = ec.map(function (c) { return _cacheCardName(c, p); }).join(',');
                    }
                } catch (eInner) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(eInner); }
                parts.push('J' + jn);
                parts.push('E' + en);

                /* 公开关系信息也属于 world-state：
                 * 身份明置/阵营公开若不进指纹，100ms bestAction 缓存可能继续沿用旧目标。
                 * 未明身份只写 '?'，禁止把隐藏 identity 泄露进缓存键。 */
                try {
                    const shown = !!p.identityShown || p === game.zhu || p.identity === 'zhu' || p.identity === 'mingzhong';
                    const pubId = shown ? String(p.identity || (p === game.zhu ? 'zhu' : '')) : '?';
                    const pubGroup = (shown && p.group) ? String(p.group) : '';
                    const pk = String(p.playerid || p.name1 || p.name || p.name2 || '?');
                    parts.push('R' + pk + ':' + (shown ? '1' : '0') + ':' + pubId + ':' + pubGroup);
                } catch (eRel) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(eRel); }
            }
        } catch (eJudgeEquip) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(eJudgeEquip); }
        /* ★ 优化点 1：加入"牌堆剩余数（分桶）"。出牌/摸牌会消耗牌堆，
         * 用数量级分桶而非精确数——避免每一次摸牌都清缓存导致卡顿再生，
         * 同时让"牌堆明显变化"（摸牌预测/剩余量判断）的决策正确失效。 */
        try {
            if (typeof game !== 'undefined') {
                const p = game.cardPile;
                if (p && Array.isArray(p)) {
                    const len = p.length;
                    /* 分桶：0 / 1/数 / 16 / 32 / 64 / 128 / 更大，取对数量级 */
                    const bucket = len <= 0 ? 0 : Math.max(1, Math.round(Math.log2(len || 2)));
                    parts.push('P' + bucket);
                }
            }
        } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
        /* ★ 优化点 2：加入"当前阶段/行动者"。轮到谁行动、处于什么阶段
         * 决定能否出牌，上场决策依赖的窗口可能已失效。 */
        try {
            if (typeof _status !== 'undefined' && _status && typeof _status !== 'undefined') {
                const cs = _status.currentPhase;
                if (cs && cs.name) parts.push('C' + cs.name);
            }
        } catch (e) { if (typeof window !== 'undefined' && window.__DJSC && window.__DJSC.swallow) window.__DJSC.swallow(e); }
        return parts.join('_');
    } catch (e) {
        return 'error_' + Date.now();
    }
}

/**
 * 检查状态是否变化，变化了才清缓存
 */
export function checkStateChanged() {
    const key = makeStateKey();
    if (key !== _lastStateKey) {
        _lastStateKey = key;
        cacheClear();  // 状态变了才清缓存
        return true;   // 标记为已变化
    }
    return false;  // 状态没变，保留缓存
}

/**
 * 初始化状态监听
 */
export function initStateWatcher() {
    _lastStateKey = makeStateKey();
    console.log('[cache] ✅ 事件驱动缓存已启动：状态变化时才重算');
}
