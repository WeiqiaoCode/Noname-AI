import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	EXECUTION_KINDS,
	executionEligibility,
	invokeHost,
	invokeObservedHost,
	stageExecutionDecision,
	commitExecution,
	cancelExecution,
	executionGatewayStats,
	resetExecutionGateway,
} from '../score/decision/execution/executionGateway.js';
import {
	createDecisionTransaction,
	resetDecisionTransactionStats,
	peekDecisionTransaction,
} from '../score/decision/state/decisionTransaction.js';

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
	if (cond) { pass++; process.stdout.write('.'); }
	else { fails.push(name + (extra ? ' >> ' + extra : '')); process.stdout.write('F'); }
}
function eq(a, b, name) { ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

resetExecutionGateway();
resetDecisionTransactionStats();

const player = {};
const event = {};
let gate = executionEligibility('use', player, event, {
	requireHardOverride: false,
	checkCircuit: false,
});
ok(gate.ok, '10.61 Gateway允许普通AI执行请求');

gate = executionEligibility('respond', player, { __sentinel: true }, {
	requireHardOverride: false,
	checkCircuit: false,
	sentinel: '__sentinel',
});
eq(gate.ok, false, '10.61 Gateway统一拒绝已接管哨兵事件');
eq(gate.reason, 'already-overridden', '10.61 哨兵拒绝原因稳定');

gate = executionEligibility('discard', player, event, {
	requireHardOverride: false,
	checkCircuit: false,
	extraGuard: () => 'test-guard',
});
eq(gate.reason, 'test-guard', '10.61 Gateway支持场景专属额外守卫');

/* 监督调用：无论结果如何，宿主只调用一次。 */
let observedCalls = 0;
const observed = invokeObservedHost({
	orig: function () { observedCalls++; return { event: 'native' }; },
	thisArg: player,
	args: [],
	decisionPoint: 'chooseTarget',
});
ok(observed.ok, '10.61 observer宿主调用成功');
eq(observedCalls, 1, '10.61 observer绝不重复执行宿主');
eq(observed.result.event, 'native', '10.61 observer保持宿主原结果');

/* 主执行成功：prepare 生效，cleanupOnSuccess=true 时恢复。 */
let hostCalls = 0;
let prepared = false;
let cleaned = false;
const success = invokeHost({
	kind: EXECUTION_KINDS.USE,
	player,
	orig: function () { hostCalls++; return 'ok'; },
	thisArg: player,
	args: [],
	prepare: function () {
		prepared = true;
		return function () { cleaned = true; };
	},
	cleanupOnSuccess: true,
});
ok(success.ok && prepared && cleaned, '10.61 Gateway统一prepare/cleanup成功路径');
eq(hostCalls, 1, '10.61 正常Host调用只执行一次');

/* 主执行异常：先清理，再允许一次原生fallback。 */
hostCalls = 0;
cleaned = false;
let first = true;
const recovered = invokeHost({
	kind: EXECUTION_KINDS.COMPARE,
	player,
	orig: function () {
		hostCalls++;
		if (first) { first = false; throw new Error('boom'); }
		return 'fallback';
	},
	thisArg: player,
	args: [],
	prepare: function () {
		return function () { cleaned = true; };
	},
	failureReason: 'test failure',
});
eq(recovered.fallback, true, '10.61 Host异常走统一fallback');
eq(recovered.result, 'fallback', '10.61 fallback返回原生结果');
eq(hostCalls, 2, '10.61 异常路径最多一次primary+一次fallback');
ok(cleaned, '10.61 fallback前先恢复临时宿主改写');

/* Transaction Stage/Commit/Cancel 统一经 Gateway。 */
let committed = 0;
const tx = createDecisionTransaction(
	{ type: 'card', id: 'sha', target: '敌A' },
	function () { committed++; },
	{ ttl: 5000 }
);
const decision = {};
Object.defineProperty(decision, '__djscTransaction', { value: tx, enumerable: false });
ok(!!stageExecutionDecision(player, decision, 'use'), '10.61 Gateway统一Stage事务');
eq(peekDecisionTransaction(player).id, tx.id, '10.61 Stage后pending正确');
const commit = commitExecution(player, { type: 'card', id: 'sha', target: '敌A' });
ok(commit.ok, '10.61 Gateway统一Commit事务');
eq(committed, 1, '10.61 Commit副作用只执行一次');

const tx2 = createDecisionTransaction({ type: 'card', id: 'tao' }, function () {});
const decision2 = {};
Object.defineProperty(decision2, '__djscTransaction', { value: tx2, enumerable: false });
stageExecutionDecision(player, decision2, 'soft');
ok(cancelExecution(player, 'test-cancel', 'soft'), '10.61 Gateway统一Cancel事务');
eq(peekDecisionTransaction(player), null, '10.61 Cancel后无pending事务');

const stats = executionGatewayStats();
ok(stats.hostCalls >= 3, '10.61 Gateway集中记录Host调用统计');
ok(stats.staged >= 2 && stats.committed >= 1 && stats.cancelled >= 1,
	'10.61 Gateway集中记录事务生命周期统计');

/* 静态架构门禁：公共执行职责不能再散回各模块。 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const useSrc = readFileSync(join(root, 'score/decision/override/use.js'), 'utf8');
const respondSrc = readFileSync(join(root, 'score/decision/override/respond.js'), 'utf8');
const discardSrc = readFileSync(join(root, 'score/decision/override/discard.js'), 'utf8');
const compareSrc = readFileSync(join(root, 'score/decision/override/compare.js'), 'utf8');
const softSrc = readFileSync(join(root, 'score/decision/safety/aiOverride.js'), 'utf8');
const engineSrc = readFileSync(join(root, 'score/decision/engine/engine.js'), 'utf8');
const hookSrc = readFileSync(join(root, 'score/decision/engine/decisionHook.js'), 'utf8');
const indexSrc = readFileSync(join(root, 'score/decision/override/index.js'), 'utf8');

for (const [name, src] of [
	['use', useSrc], ['respond', respondSrc], ['discard', discardSrc], ['compare', compareSrc],
]) {
	ok(src.includes("executionGateway.js"), '10.61 ' + name + ' 接管接入Execution Gateway');
	ok(!src.includes('const DEGRADED = new Map()'), '10.61 ' + name + ' 不再私有维护degrade状态');
	ok(!src.includes("import { trip, isTripped }"), '10.61 ' + name + ' 不再直接维护熔断调用');
}

ok(softSrc.includes('stageExecutionDecision') && !softSrc.includes('stageDecisionTransaction'),
	'10.61 soft override事务Stage只走Gateway');
ok(engineSrc.includes('commitExecution') && !engineSrc.includes('commitDecisionTransaction'),
	'10.61 card/skill真实Commit只走Gateway');
ok(indexSrc.includes('isExecutionLayerEnabled') &&
	!indexSrc.includes("cfg('hardOverride'") &&
	!indexSrc.includes("isTripped('use')"),
	'10.61 接管层启停资格只由Gateway解释');
ok(hookSrc.includes('invokeObservedHost') &&
	!hookSrc.includes('if (!_checkLegality(this, name, result, args)) {\n                        return orig.apply'),
	'10.61 decisionHook变为单次调用监督员，不因检查失败重跑宿主');

process.stdout.write('\n');
if (fails.length) {
	console.error('\n❌ #35 execution gateway contract failed: ' + fails.length + ' / ' + (pass + fails.length));
	for (const f of fails) console.error('  FAIL ' + f);
	process.exitCode = 1;
} else {
	console.log('\n✅ #35 execution gateway contract passed: ' + pass + ' assertions');
}
