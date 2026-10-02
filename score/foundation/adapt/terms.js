/*
 * ============================================
 * 版权所有，侵权必究
 * 通用卡牌博弈AI决策引擎 · 内核模块
 * ============================================
 */

/* ================= 通用术语层（Game-Agnostic Terms） =================
 *
 * 【架构定位】
 * 本层定义**与任何具体游戏无关**的语义分类：
 *   · 动作语义：攻击 / 防御 / 治疗 / 控制 / 延时 / 无效化 / 增益 / 补牌
 *   · 阵营语义：自身 / 同阵营 / 敌对阵营 / 第三方 / 未知
 *   · 关系语义：同阵营 / 敌对 / 中立 / 未知
 *
 * 内核逻辑只允许引用「语义」，不得硬编码任何卡牌名或身份名。
 * 具体游戏的名词由 core/gameProfile.js 的「游戏档案」映射进来。
 *
 * 【引用稳定性契约】
 * _sem / _bucket 中的所有集合对象一经创建即**原地更新**，永不整体替换。
 * 因此其它模块可以在 import 期安全地持有其引用（例如特征契约槽位）。
 */

/* ---------- 动作语义（8 类，游戏无关） ---------- */
export const SEMANTIC = {
	ATTACK: 'attack',
	DEFENSE: 'defense',
	HEAL: 'heal',
	CONTROL: 'control',
	DELAY: 'delay',
	NEGATE: 'negate',
	BUFF: 'buff',
	DRAW: 'draw',
};

export const SEMANTIC_LABEL = {
	attack: '攻击', defense: '防御', heal: '治疗', control: '控制',
	delay: '延时', negate: '无效化', buff: '增益', draw: '补牌',
};

/* ---------- 特征契约槽位（决定 130 维中「攻/防/控/延时」四槽取值） ---------- */
export const BUCKET = { ATK: 'atk', DEF: 'def', CTRL: 'ctrl', DELAY: 'delay' };

/* ---------- 阵营语义（5 类） ---------- */
export const CAMP = { SELF: 'self', ALLY: 'ally', ENEMY: 'enemy', THIRD: 'third', UNKNOWN: 'unknown' };
export const CAMP_LABEL = { self: '自身', ally: '同阵营', enemy: '敌对阵营', third: '第三方', unknown: '未知' };

/* ---------- 关系语义（4 类） ---------- */
export const RELATION = { SAME: 'same', HOSTILE: 'hostile', NEUTRAL: 'neutral', UNKNOWN: 'unknown' };
export const RELATION_LABEL = { same: '同阵营', hostile: '敌对', neutral: '中立', unknown: '未知' };

/* ---------- 内部集合（原地更新，引用稳定） ---------- */
const _sem = {};
Object.keys(SEMANTIC_LABEL).forEach(function (k) { _sem[k] = {}; });

const _bucket = {};
[BUCKET.ATK, BUCKET.DEF, BUCKET.CTRL, BUCKET.DELAY].forEach(function (k) { _bucket[k] = {}; });

let _reverse = {};

function _clear(o) { Object.keys(o).forEach(function (k) { delete o[k]; }); }

/**
 * 注入「游戏档案」的语义映射（原地更新，不替换对象引用）
 * @param {{semanticIds?:object, featureBuckets?:object}} map
 */
export function setMapping(map) {
	map = map || {};
	const sem = map.semanticIds || {};
	const buckets = map.featureBuckets || {};

	Object.keys(_sem).forEach(function (s) {
		const dst = _sem[s];
		_clear(dst);
		const src = sem[s];
		if (src) Object.keys(src).forEach(function (id) { if (src[id]) dst[id] = 1; });
	});

	Object.keys(_bucket).forEach(function (b) {
		const dst = _bucket[b];
		_clear(dst);
		let list = buckets[b];
		if (!list && b === BUCKET.DELAY) list = [SEMANTIC.DELAY];
		if (!list) return;
		list.forEach(function (s) {
			const src = _sem[s];
			if (src) Object.keys(src).forEach(function (id) { dst[id] = 1; });
		});
	});

	/* 反向索引：卡牌 id → 语义类（同一 id 归多类时取声明顺序第一个） */
	const rev = {};
	Object.keys(_sem).forEach(function (s) {
		Object.keys(_sem[s]).forEach(function (id) { if (!(id in rev)) rev[id] = s; });
	});
	_reverse = rev;
}

/* ---------- 查询接口 ---------- */

/** 取某语义类的卡牌 id 集合（引用稳定） */
export function idsOf(semantic) { return _sem[semantic] || {}; }

/** 取某特征槽位的卡牌 id 集合（引用稳定） */
export function bucketIds(bucket) { return _bucket[bucket] || {}; }

/** 卡牌 id → 语义类；未登记返回空串 */
export function semanticOf(id) { return _reverse[id] || ''; }

/** 判断卡牌是否属于某语义类 */
export function isSemantic(id, semantic) { return !!(_sem[semantic] && _sem[semantic][id]); }

/** 语义覆盖度自检：哪些语义类已填、哪些待填 */
export function coverage() {
	const filled = [];
	const missing = [];
	Object.keys(SEMANTIC_LABEL).forEach(function (s) {
		(Object.keys(_sem[s]).length ? filled : missing).push(s);
	});
	return {
		total: Object.keys(SEMANTIC_LABEL).length,
		filledCount: filled.length,
		filled: filled,
		missing: missing,
		missingLabels: missing.map(function (s) { return SEMANTIC_LABEL[s]; }),
	};
}
