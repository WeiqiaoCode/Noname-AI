/*
 * ============================================
 * 版权所有，侵权必究
 * 通用卡牌博弈AI决策引擎 · 内核模块
 * ============================================
 */

/* ================= 配置规格表（Config Spec） =================
 *
 * 【用途】
 * 把内核全部可调项集中成**一张声明式表**：面板可据此自动渲染表单，
 * 校验、默认值、说明、分组全部自动推导，新增参数只需在此加一行。
 *
 * 【两种状态】
 *   active  —— 已接入，改值立即生效
 *   pending —— 专业级预留位，未接入前不生效（填好实现后在 POINTS 注册即可转为 active）
 *
 * 【取值优先级】宿主配置 extension_无名AI_<key> → 扩展内配置 → default
 */

export const STATUS = { ACTIVE: 'active', PENDING: 'pending' };

export const SPEC = [
	/* ---------- 一、总开关与模式 ---------- */
	{ key: 'decisionScore', group: '总开关', label: '决策引擎总开关', type: 'bool', default: true, status: STATUS.ACTIVE, hint: '关闭后引擎不接管任何决策' },
	{ key: 'aiStrength', group: '总开关', label: 'AI 强度档位', type: 'enum', options: ['极弱', '弱', '中', '强', '极强'], default: '中', status: STATUS.ACTIVE, hint: '缩放冠军策略对决策的影响力系数（0/0.3/1.0/1.6/2.0），只改影响力不改正确率' },
	{ key: 'logRetain', group: '日志', label: '对局日志保留局数', type: 'enum', options: ['50', '100', '200', '0'], default: '100', status: STATUS.ACTIVE, hint: '扩展自存对局日志，不受内核录像 20 条限制；0=不限' },
	{ key: 'qqGroup', group: '日志', label: '交流群号', type: 'text', default: '123456789', status: STATUS.ACTIVE, hint: '样本满额导出后一键复制群号，便于把样本发到群里' },
	{ key: 'mode', group: '总开关', label: '决策模式', type: 'enum', options: ['mix', 'attack', 'defense', 'assist'], default: 'mix', status: STATUS.ACTIVE, hint: '宏观策略倾向' },

	/* ---------- 二、冠军层（唯一接管层） ---------- */
	{ key: 'championBoost', group: '冠军接管', label: '冠军提权强度', type: 'enum', options: ['0', '3', '6', '10'], default: '6', status: STATUS.ACTIVE, hint: '0=关闭；命中冠军决策点时加的分数' },

	/* ---------- 三、各轴权重（整体乘数） ---------- */
	{ key: 'wAtkCard', group: '权重', label: '攻击牌权重', type: 'number', min: 0, max: 3, step: 0.1, default: 1, status: STATUS.ACTIVE, advanced: true },
	{ key: 'wDefCard', group: '权重', label: '防御牌权重', type: 'number', min: 0, max: 3, step: 0.1, default: 1, status: STATUS.ACTIVE, advanced: true },
	{ key: 'wRiskCard', group: '权重', label: '高方差牌权重', type: 'number', min: 0, max: 3, step: 0.1, default: 1, status: STATUS.ACTIVE, advanced: true },
	{ key: 'wOpportunityMul', group: '权重', label: '机会成本系数', type: 'number', min: 0, max: 2, step: 0.05, default: 0.5, status: STATUS.ACTIVE, advanced: true },
	{ key: 'wComboBonus', group: '权重', label: '连招加成', type: 'number', min: 0, max: 3, step: 0.1, default: 1, status: STATUS.ACTIVE, advanced: true },
	{ key: 'wFocusMul', group: '权重', label: '集火加成', type: 'number', min: 0, max: 3, step: 0.1, default: 1, status: STATUS.ACTIVE, advanced: true },
	{ key: 'wSeatPressure', group: '权重', label: '座位压力权重', type: 'number', min: 0, max: 3, step: 0.1, default: 1, status: STATUS.ACTIVE, advanced: true },
	{ key: 'wForecastMul', group: '权重', label: '来袭预测权重', type: 'number', min: 0, max: 3, step: 0.1, default: 1, status: STATUS.ACTIVE, advanced: true },

	/* ---------- 四、性格 ---------- */
	{ key: 'riskProfile', group: '性格', label: '性格预设', type: 'enum', options: ['custom', 'aggressive', 'defensive', 'balanced'], default: 'custom', status: STATUS.ACTIVE },
	{ key: 'personalityAggression', group: '性格', label: '攻守倾向', type: 'number', min: 0, max: 100, step: 5, default: 50, status: STATUS.ACTIVE },
	{ key: 'personalityRisk', group: '性格', label: '冒险倾向', type: 'number', min: 0, max: 100, step: 5, default: 50, status: STATUS.ACTIVE },
	{ key: 'personalityTeam', group: '性格', label: '团队倾向', type: 'number', min: 0, max: 100, step: 5, default: 50, status: STATUS.ACTIVE },

	/* ---------- 五、模块开关 ---------- */
	{ key: 'useTrainedModel', group: '模块开关', label: '启用训练模型', type: 'bool', default: true, status: STATUS.ACTIVE },
	{ key: 'enablePlanner', group: '模块开关', label: '多步规划器', type: 'bool', default: true, status: STATUS.ACTIVE },
	{ key: 'comboChain', group: '模块开关', label: '连招链', type: 'bool', default: true, status: STATUS.ACTIVE },
	{ key: 'psychologyLayer', group: '模块开关', label: '心理博弈层', type: 'bool', default: true, status: STATUS.ACTIVE },
	{ key: 'responseAI', group: '模块开关', label: '响应式出牌', type: 'bool', default: true, status: STATUS.ACTIVE },
	{ key: 'playerMemory', group: '模块开关', label: '对手记忆', type: 'bool', default: true, status: STATUS.ACTIVE },
	{ key: 'compareAI', group: '模块开关', label: '对照分析', type: 'bool', default: true, status: STATUS.ACTIVE },
	{ key: 'adaptiveDifficulty', group: '模块开关', label: '自适应难度', type: 'bool', default: false, status: STATUS.ACTIVE },
	{ key: 'hardOverride', group: '模块开关', label: '硬接管（覆盖宿主动作）', type: 'bool', default: true, status: STATUS.ACTIVE, hint: '关闭后只影响评分，不改写宿主选择' },

	/* ---------- 六、模型训练 ---------- */
	{ key: 'modelUpdateMode', group: '模型训练', label: '更新模式', type: 'enum', options: ['auto_slow', 'auto_fast', 'manual'], default: 'auto_slow', status: STATUS.ACTIVE },
	{ key: 'modelCandidateGames', group: '模型训练', label: '候选期评估局数', type: 'number', min: 5, max: 200, step: 5, default: 20, status: STATUS.ACTIVE, advanced: true },
	{ key: 'modelPromoteThreshold', group: '模型训练', label: '提升阈值（百分点）', type: 'number', min: 0, max: 50, step: 1, default: 10, status: STATUS.ACTIVE, advanced: true },
	{ key: 'learningRate', group: '模型训练', label: '学习率', type: 'number', min: 0.0001, max: 0.1, step: 0.0005, default: 0.005, status: STATUS.ACTIVE, advanced: true },
	{ key: 'useResidual', group: '模型训练', label: '残差学习', type: 'bool', default: false, status: STATUS.ACTIVE, advanced: true },

	/* ---------- 七、专业级预留位（未接入前不生效） ---------- */
	{ key: 'gameProfileId', group: '专业级预留', label: '游戏档案 ID', type: 'string', default: 'noname', status: STATUS.PENDING, hint: '接入新游戏时填档案 id，并在 gameProfile.js 注册' },
	{ key: 'modelBackend', group: '专业级预留', label: '模型后端', type: 'enum', options: ['local', 'remote', 'ensemble'], default: 'local', status: STATUS.PENDING, hint: '远程/集成模型，需在 extPoints 注册 modelBackend' },
	{ key: 'modelBackendUrl', group: '专业级预留', label: '模型后端地址', type: 'string', default: '', status: STATUS.PENDING, hint: 'remote/ensemble 模式下的推理端点' },
	{ key: 'evalBenchmark', group: '专业级预留', label: '评估基准集', type: 'string', default: '', status: STATUS.PENDING, hint: '标准对局回放集，用于离线回归评估' },
	{ key: 'telemetryEndpoint', group: '专业级预留', label: '遥测上报端点', type: 'string', default: '', status: STATUS.PENDING, hint: '决策链路耗时/命中率上报，留空则关闭' },
	{ key: 'featureBlockDims', group: '专业级预留', label: '扩展特征块维度', type: 'json', default: {}, status: STATUS.PENDING, hint: '追加特征块的维度登记（须与 130 维契约同步升级）' },
];

/* ---------- 查询接口 ---------- */
export function byKey(key) {
	for (let i = 0; i < SPEC.length; i++) if (SPEC[i].key === key) return SPEC[i];
	return null;
}

export function active() { return SPEC.filter(function (s) { return s.status === STATUS.ACTIVE; }); }
export function pending() { return SPEC.filter(function (s) { return s.status === STATUS.PENDING; }); }

export function groups() {
	const g = [];
	SPEC.forEach(function (s) { if (g.indexOf(s.group) < 0) g.push(s.group); });
	return g;
}

/** 供面板渲染：按分组切分，附默认值 */
export function schema() {
	const out = [];
	groups().forEach(function (name) {
		out.push({
			group: name,
			items: SPEC.filter(function (s) { return s.group === name; }),
		});
	});
	return out;
}

/** 校验一份配置对象，返回 { ok, errors[] } */
export function validate(obj) {
	const errors = [];
	obj = obj || {};
	SPEC.forEach(function (s) {
		const v = obj[s.key];
		if (v === undefined || v === null) return;
		if (s.type === 'enum' && s.options && s.options.indexOf(String(v)) < 0) {
			errors.push(s.key + ' 取值非法：' + v + '（允许 ' + s.options.join('/') + '）');
		}
		if (s.type === 'number') {
			const n = Number(v);
			if (!isFinite(n)) errors.push(s.key + ' 不是有效数字：' + v);
			else {
				if (s.min !== undefined && n < s.min) errors.push(s.key + ' 低于下限 ' + s.min);
				if (s.max !== undefined && n > s.max) errors.push(s.key + ' 高于上限 ' + s.max);
			}
		}
	});
	return { ok: errors.length === 0, errors: errors };
}

/** 配置就绪度：已接入项 / 预留项统计 */
export function readiness() {
	const a = active().length;
	const p = pending().length;
	return {
		active: a,
		pending: p,
		total: SPEC.length,
		percent: SPEC.length ? Math.round((a / SPEC.length) * 100) : 0,
		pendingKeys: pending().map(function (s) { return s.key; }),
	};
}
