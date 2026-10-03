/*
 * 统一动作候选契约：
 * - runtime score 始终保持 float utility，不在排序链中做 Int8 非线性量化。
 * - targetObj 与 target 必须描述同一个实际执行目标。
 * - 模型/持久化需要 Int8 时，在各自边界显式转换。
 */

export function runtimeScore(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return 0;
	return Math.round(n * 100) / 100;
}

export function targetKey(target) {
	if (!target) return null;
	return target.name1 || target.name || target.playerid || null;
}

export function makeActionCandidate(spec) {
	const out = Object.assign({}, spec || {});
	out.score = runtimeScore(out.score);
	if (out.targetObj) {
		const key = targetKey(out.targetObj);
		if (key) out.target = key;
	}
	if (out.target == null) out.target = null;
	return out;
}

export function hasConsistentBoundTarget(candidate) {
	if (!candidate || !candidate.targetObj) return candidate ? candidate.target == null : false;
	return targetKey(candidate.targetObj) === candidate.target;
}
