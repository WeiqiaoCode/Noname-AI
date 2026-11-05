/* 独立地址专用：真实 Player/useSkill/respond 与 GameEvent，不进入正式扩展。 */
export async function runHostScenarios() {
    const { lib, game } = await import('/noname.js');
    const tx = await import('/extension/无名AI/score/decision/state/decisionTransaction.js');
    const training = await import('/extension/无名AI/score/model/train/trainExport.js');
    const player = game.players.find(p => p !== game.me && p.isAlive());
    if (!player) throw new Error('请先进入对局，再运行宿主场景');
    const checks = [];
    const assert = (condition, label) => { checks.push({ label, pass: !!condition }); if (!condition) throw new Error(label); };
    const skill = 'b5_isolated_probe';
    const previous = lib.skill[skill];
    const oldMarker = player.storage[skill];
    const samplesBefore = training.bufferSize();
    let commits = 0;
    try {
        lib.skill[skill] = {
            charlotte: true, direct: true, popup: false, lose: false, discard: false, delay: false,
            async content(event, trigger, player) {
                player.storage.b5_isolated_probe = (player.storage.b5_isolated_probe || 0) + 1;
            },
        };
        const success = tx.createDecisionTransaction({ type: 'skill', id: skill }, () => { commits++; });
        tx.stageDecisionTransaction(player, success);
        const skillEvent = player.useSkill(skill);
        assert(commits === 0, 'useSkill 正常返回时不提前 Commit');
        await skillEvent;
        await Promise.resolve();
        assert(skillEvent.finished === true && !skillEvent._cancelled, '真实 useSkill 事件完成且未取消');
        assert(player.storage[skill] === (oldMarker || 0) + 1, '真实技能内容实际执行');
        assert(success.state === 'committed' && commits === 1, '技能完成后对应事务只提交一次');

        const cancelled = tx.createDecisionTransaction({ type: 'skill', id: skill }, () => { commits++; });
        tx.stageDecisionTransaction(player, cancelled);
        const cancelledEvent = player.useSkill(skill);
        cancelledEvent.cancel(true, null, 'notrigger');
        await cancelledEvent;
        await Promise.resolve();
        assert(cancelledEvent._cancelled === true && cancelled.state === 'cancelled', '真实取消事件取消自己的事务');
        assert(commits === 1 && player.storage[skill] === (oldMarker || 0) + 1, '取消技能不执行内容、不产生 Commit');

        const pending = tx.createDecisionTransaction({ type: 'card', id: 'b5_unexecuted' }, () => { commits++; });
        tx.stageDecisionTransaction(player, pending);
        const responseEvent = player.respond({ name: 'shan' }, [], false);
        await responseEvent;
        await Promise.resolve();
        assert(responseEvent.finished === true && responseEvent.name === 'respond', '真实 Player.respond 事件能够完成');
        assert(tx.peekDecisionTransaction(player)?.id === pending.id && commits === 1,
            '响应事件不冒充待执行主动动作、不误提交');
        tx.cancelDecisionTransaction(player, 'b5-scenario-cleanup');
        assert(training.bufferSize() === samplesBefore, '受控回调未产生训练样本（不把测试数据伪装成训练数据）');
        return { core: lib.version, checks, commits, samplesBefore, samplesAfter: training.bufferSize(),
            boundary: '真实宿主事件+受控事务回调；不是自然选牌或完整训练链验收' };
    } finally {
        tx.cancelDecisionTransaction(player, 'b5-scenario-cleanup');
        if (previous === undefined) delete lib.skill[skill]; else lib.skill[skill] = previous;
        if (oldMarker === undefined) delete player.storage[skill]; else player.storage[skill] = oldMarker;
    }
}
