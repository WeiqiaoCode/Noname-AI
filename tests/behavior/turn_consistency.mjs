/*
 * ============================================
 * // 作者：飞升原创
 * 交流群: 123456789
 * v3.1α
 * 版权所有，侵权必究
 * ============================================
 */

/* ================= Behavior Regression · 通用回合战略转移 =================
 * 测试案例可以使用具体卡牌复现真实 bug，但实现必须只认：
 *   create-state / remove-target-card / state family+dimension / target / value。
 */
import { ok, eq, getHost, loadScore, finish } from './_harness.mjs';

const tss = await loadScore('decision/state/turnStrategicState.js');
const terms = await loadScore('foundation/adapt/terms.js');

function mkP(name, rel, opts) {
    opts = opts || {};
    return {
        name: name, rel: rel, alive: true,
        hp: opts.hp == null ? 4 : opts.hp, maxHp: 4,
        _h: opts.h || [],
        _e: opts.e || [],
        _j: opts.j || [],
        countCards: function (a) {
            if (a === 'h') return this._h.length;
            if (a === 'e') return this._e.length;
            if (a === 'j') return this._j.length;
            return 0;
        },
        getCards: function (a) {
            if (a === 'h') return this._h;
            if (a === 'e') return this._e;
            if (a === 'j') return this._j;
            return [];
        },
    };
}
const C = function (id) { return { name: id }; };
const rctx = { relationOf: function (mi, t) { return t.rel; } };
const me = mkP('me', 1, { h: [C('sha'), C('shan')] });
const host = getHost();
host._status.currentPhase = me;
host.game.players = [me];

/* ---- 语义来自 gameProfile，不来自 engine 分支 ---- */
eq(terms.strategicEffectOf('lebu').operation, 'create-state', '乐 → create-state 仅由 profile 声明');
eq(terms.strategicEffectOf('guohe').operation, 'remove-target-card', '过河 → remove-target-card 仅由 profile 声明');
ok(terms.idsWithStrategicOperation('remove-target-card').indexOf('shunshou') >= 0, 'remove-target-card 可按 operation 枚举');

/* ---- 通用导出 ---- */
[
 'getJudgeCardNames', 'strategicStateIdsIn', 'evaluateDestroyPenalty',
 'evaluateRemovalChoice', 'evaluateCreateConsistency', 'evaluateActionTransitionPenalty',
 'recordStateCreation', 'recordStrategicStateFromAction', 'getStrategicRecords', 'clearTurnState',
].forEach(function (fn) { eq(typeof tss[fn], 'function', '导出 ' + fn); });

/* ---- profile 驱动的状态识别；保留旧延时族兼容 ---- */
eq(tss.hasDelayedControl(mkP('e', -1, { j: [C('lebu')] })), true, '判定区战略控制 → true');
eq(tss.hasDelayedControl(mkP('e', -1, { j: [C('shandian')] })), true, '延时风险状态仍被识别');
eq(tss.hasDelayedControl(mkP('e', -1, { j: [] })), false, '无战略状态 → false');

/* ---- 只有有利状态可拆：目标级完整降权，具体牌级强保护 ---- */
tss.clearTurnState();
const onlyState = mkP('onlyState', -1, { j: [C('lebu')] });
host.game.players = [me, onlyState];
tss.recordStateCreation(me, onlyState, 'lebu');
const onlyDp = tss.evaluateDestroyPenalty(me, onlyState, rctx);
ok(onlyDp.penalty > 0, '敌方有利状态：移除机会成本为正');
eq(onlyDp.effectivePenalty, onlyDp.penalty, '无其它可拆资源时保留完整 target penalty');
ok(tss.evaluateRemovalChoice(me, onlyState, onlyState._j[0], rctx).adjustment < 0,
   '具体选牌层保护敌方身上的有利状态');

/* ---- 同目标另有装备/手牌：允许选这个目标，但仍保护战略状态本身 ---- */
const withAlt = mkP('withAlt', -1, { e: [C('weapon')], j: [C('lebu')] });
const altDp = tss.evaluateDestroyPenalty(me, withAlt, rctx);
ok(altDp.effectivePenalty > 0 && altDp.effectivePenalty < altDp.penalty,
   '有其它资源可拆时只保留小额目标级 penalty');
ok(tss.evaluateRemovalChoice(me, withAlt, withAlt._j[0], rctx).adjustment < 0,
   '目标可选不代表可以拆掉其有利状态');

/* ---- 队友负面状态：具体牌级应鼓励解除 ---- */
const allyState = mkP('allyState', 1, { j: [C('lebu')] });
ok(tss.evaluateRemovalChoice(me, allyState, allyState._j[0], rctx).adjustment > 0,
   '队友有害状态 → 鼓励移除');

/* ---- 自己刚创建的状态得到额外 commitment 保护 ---- */
const observed = mkP('observed', -1, { j: [C('lebu')] });
const selfMade = mkP('selfMade', -1, { j: [C('lebu')] });
const observedAdj = tss.evaluateRemovalChoice(me, observed, observed._j[0], rctx).adjustment;
tss.clearTurnState();
tss.recordStateCreation(me, selfMade, 'lebu');
const selfAdj = tss.evaluateRemovalChoice(me, selfMade, selfMade._j[0], rctx).adjustment;
ok(selfAdj < observedAdj, '本回合自己建立的有利状态保护更强，但仍是有限分数');

/* ---- CREATE → 消失 → 同目标 RECREATE：soft reversal penalty ---- */
tss.clearTurnState();
const eA = mkP('eA', -1, { j: [C('lebu')] });
const eB = mkP('eB', -1, { j: [] });
host.game.players = [me, eA, eB];
tss.recordStateCreation(me, eA, 'lebu');
eA._j.length = 0;  // 真实状态已被移除
const reapplyA = tss.evaluateCreateConsistency(me, eA, 'lebu', rctx);
ok(reapplyA.penalty > 0 && Number.isFinite(reapplyA.penalty), '同目标重建同状态 → 有限 reversal penalty');
eq(tss.evaluateCreateConsistency(me, eB, 'lebu', rctx).penalty, 0, '换目标建立相同状态 → 不按反转处理');

/* ---- action transition 唯一入口：engine 无需识别牌名 ---- */
const eOnly = mkP('eOnly', -1, { j: [C('bingliang')] });
ok(tss.evaluateActionTransitionPenalty(me, eOnly, 'guohe', rctx).penalty > 0,
   'remove-target-card 对只有有利状态的敌方目标降权');
eq(tss.evaluateActionTransitionPenalty(me, eOnly, 'sha', rctx).penalty, 0,
   '非战略 transition 动作自然为 0');

/* ---- 下一 phase 清空 commitment，不跨回合污染 ---- */
host._status.currentPhase = mkP('otherPhase', 1, {});
eq(tss.evaluateCreateConsistency(me, eA, 'lebu', rctx).penalty, 0,
   'phase 切换后旧 reversal provenance 失效');

/* ---- 旧兼容接口仍委托通用层 ---- */
host._status.currentPhase = me;
tss.clearTurnState();
const eR = mkP('eR', -1, { j: [] });
host.game.players = [me, eR];
tss.recordSelfCreatedControl(me, { rule: 'guohe', strat: 'useCardAfter' }, eR);
eq(tss.getControlRecords().length, 0, 'remove 动作不会被误记为 create-state');
tss.recordSelfCreatedControl(me, { rule: 'lebu', strat: 'useCardAfter' }, eR);
eq(tss.getControlRecords().length, 1, '旧 recordSelfCreatedControl 兼容委托新语义层');

finish('turn_consistency');
