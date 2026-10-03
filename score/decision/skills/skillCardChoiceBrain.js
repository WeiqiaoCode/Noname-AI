/*
 * ============================================================
 * 无名AI · 技能选牌通用策略（skillCardChoiceBrain）
 * ------------------------------------------------------------
 * 目标：处理主动技能中的“选自己的牌”阶段，不写技能 ID / 牌名特判。
 *
 * 语义：
 *   cost    —— 自有牌作为成本/转化材料；
 *   give    —— 明确把牌交给他人；
 *   unknown —— 无法可靠判断，保持原生 AI 主导。
 *
 * cost 排序只使用通用资源事实：
 *   宿主牌价值、当前手牌稀缺度、同名重复度、当前血线压力。
 * ============================================================
 */

function n(v) {
	const x = Number(v);
	return Number.isFinite(x) ? x : 0;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function classifySkillCardSelection(profile, ctx) {
	try {
		ctx = ctx || {};
		const tags = (profile && profile.tags) || {};
		const info = ctx.skillInfo || null;
		const give = Math.max(0, n(tags.giveCard));
		const cost =
			Math.max(0, n(tags.loseCard))
			+ Math.abs(Math.min(0, n(tags.selfDiscard)))
			+ Math.abs(Math.min(0, n(tags.selfLose)));

		if (give > 0.15) return 'give';

		/* 宿主 filterCard 是强结构事实，但 discard:false / lose:false 表示
		 * “选牌”未必是消耗；没有额外证据时必须保持 unknown。 */
		if (info && info.filterCard) {
			if (info.discard !== false && info.lose !== false) return 'cost';
			if (info.discard === false || info.lose === false) {
				return cost > 0.15 ? 'cost' : 'unknown';
			}
		}
		if (cost > 0.15) return 'cost';
		return 'unknown';
	} catch (e) { return 'unknown'; }
}

export function skillCardSelectionAdjustment(cardId, profile, ctx) {
	ctx = ctx || {};
	const me = ctx.me || {};
	const value = Number(ctx.cardValue);
	const hasValue = Number.isFinite(value);
	const semantic = classifySkillCardSelection(profile, ctx);

	if (semantic !== 'cost') {
		const tiny = hasValue ? clamp(-value * 0.02, -0.2, 0.2) : 0;
		return {
			semantic,
			adjustment: tiny,
			opportunityCost: 0,
			duplicateRelief: 0,
			veto: false,
			reason: semantic === 'give'
				? '给牌语义：用途未知，保持原生AI，仅保留极小机会成本'
				: '选牌语义未知：保持原生AI，仅保留极小机会成本',
		};
	}

	const handSize = Math.max(0, n(me.handSize));
	const duplicates = Math.max(1, n(ctx.duplicates) || 1);
	const hp = Number(me.hp);
	const maxHp = Math.max(1, n(me.maxHp) || 1);

	let scarcity = 1;
	if (handSize <= 1) scarcity = 1.6;
	else if (handSize <= 2) scarcity = 1.4;
	else if (handSize <= 4) scarcity = 1.15;
	else if (handSize >= 7) scarcity = 0.85;

	let survival = 1;
	if (Number.isFinite(hp)) {
		const ratio = hp / maxHp;
		if (ratio <= 0.35) survival = 1.2;
		else if (ratio <= 0.6) survival = 1.1;
	}

	const opportunityCost = hasValue ? Math.max(0, value) * 0.07 * scarcity * survival : 0;
	const duplicateRelief = Math.min(0.32, Math.max(0, duplicates - 1) * 0.10);
	const negativeRelief = hasValue && value < 0 ? Math.min(0.25, Math.abs(value) * 0.05) : 0;
	const adjustment = clamp(-opportunityCost + duplicateRelief + negativeRelief, -1.0, 0.35);

	return {
		semantic,
		adjustment: Math.round(adjustment * 1000) / 1000,
		opportunityCost: Math.round(opportunityCost * 1000) / 1000,
		duplicateRelief: Math.round(duplicateRelief * 1000) / 1000,
		veto: false,
		reason: '成本选牌：价值成本' + Math.round(opportunityCost * 100) / 100
			+ '，重复缓冲' + Math.round(duplicateRelief * 100) / 100
			+ '，手牌' + handSize,
	};
}
