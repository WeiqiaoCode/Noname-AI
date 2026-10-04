/*
 * 无名AI设置中心
 * 仅负责展示层分组与交互；沿用既有配置键、保存方式与功能回调。
 * 玩家设置与开发者设置使用同一底层配置，避免重复状态与“死开关”。
 */

const QQ_GROUP = '1080487560';

export function arrangeConfig(source, lib, game) {
    const groups = [
        {
            scope: 'player', id: 'player_basic', title: '01 · 基础设置', accent: 'gold',
            keys: ['decisionScore', 'aiStrength', 'adaptiveDifficulty', 'openConfigPanel'],
        },
        {
            scope: 'player', id: 'player_identity', title: '02 · 身份与目标', accent: 'blue',
            keys: ['autoIdentityMatch', 'broadcastAI'],
        },
        {
            scope: 'player', id: 'player_cards', title: '03 · 卡牌策略', accent: 'gold',
            keys: [
                '@基本牌|基本牌的出牌、响应与保留策略。',
                'responseAI',
                '@锦囊牌|控制、伤害、连锁与响应锦囊统一归入此处；铁索连环属于锦囊牌。',
                'comboChain',
                '@装备牌|装备替换、武器/防具/坐骑收益目前沿用引擎规则评分，本版不增加未接线的假开关。',
                '@其他|虚拟牌、多目标、重铸、牌序与概率感知等跨牌类能力。',
                'compareAI', 'deckAwareness', 'deckConsumeAllPlayers',
            ],
        },
        {
            scope: 'player', id: 'player_tactics', title: '04 · 战术与协作', accent: 'blue',
            keys: ['enablePlanner', 'psychologyLayer', 'openPlanPanel'],
        },
        {
            scope: 'player', id: 'player_override', title: '05 · 原生AI接管', accent: 'amber',
            keys: ['hardOverride', 'override_use', 'override_respond', 'override_discard', 'override_compare', 'openOverridePanel'],
        },
        {
            scope: 'player', id: 'player_memory', title: '06 · 学习与记忆', accent: 'green',
            keys: ['useTrainedModel', 'decisionFeedback', 'skillFeedback', 'styleFeedback', 'crossGameMemory', 'playerMemory', 'championBoost', 'openMemoryPanel'],
        },
        {
            scope: 'player', id: 'player_report', title: '07 · 战报与回放', accent: 'blue',
            keys: ['showReport', 'archiveGames', 'narrator', 'showLog', 'testDecisionLog', 'persist', 'openPanel', 'openArchivePanel', 'openFeedbackPanel', 'openReplayPanel', 'openSmartPanel'],
        },
        {
            scope: 'player', id: 'player_data', title: '08 · 数据与反馈', accent: 'gold',
            keys: ['exportTrainingData', 'exportAllData', 'importTrainingData'],
        },

        {
            scope: 'developer', id: 'dev_runtime', title: 'D1 · 运行状态', accent: 'blue',
            keys: ['openBrainDashboard', 'openHealthPanel', 'openSelfCheck', 'openFullMonitor'],
        },
        {
            scope: 'developer', id: 'dev_decision', title: 'D2 · 决策链诊断', accent: 'blue',
            keys: ['openDecisionDashboard', 'openComparePanel', 'openSkillBreakdownPanel'],
        },
        {
            scope: 'developer', id: 'dev_identity', title: 'D3 · 身份与信息审计', accent: 'blue',
            keys: [
                '!隐藏信息隔离|强制启用；设置界面不提供关闭入口。',
                '!关系判断边界|身份与敌友关系由权威关系层统一解释。',
                'openPsychologyMonitor',
            ],
        },
        {
            scope: 'developer', id: 'dev_perf', title: 'D4 · Planner与性能', accent: 'blue',
            keys: ['profiler', 'openProfilerPanel', 'openProfilerMonitor', 'openComboMonitor'],
        },
        {
            scope: 'developer', id: 'dev_model', title: 'D5 · 模型与训练', accent: 'blue',
            keys: ['useResidual', 'learningRate', 'forceTrain', 'showSampleCount', 'showModelStatus', 'autoFixModel', 'openChampionPanel', 'openCalibratorPanel', 'openHotSwapPanel', 'openEvolutionPanel', 'openSharedPanel'],
        },
        {
            scope: 'developer', id: 'dev_guard', title: 'D6 · Guard与安全', accent: 'blue',
            keys: [
                '!最终合法性校验|安全边界；不作为普通玩家可关闭功能。',
                '!异常降级保护|接管层异常时保留回退路径。',
                'openGuardPanel', 'openPostCheckPanel', 'openPostCheckMonitor', 'openSoftMetricsMonitor',
            ],
        },
        {
            scope: 'developer', id: 'dev_storage', title: 'D7 · 数据与存储', accent: 'blue',
            keys: ['showTrainStats', 'clearTrainingBuffer', 'clearSamples', 'importOverwrite', 'importMerge', 'openExportPanel', 'quickExportAll', 'clearGameLogs'],
        },
        {
            scope: 'developer', id: 'dev_experimental', title: 'D8 · 实验与监控', accent: 'blue',
            keys: ['openMemoryMonitor', 'openAutoFeatureMonitor', 'openTrainBufferMonitor'],
        },
    ];

    const hidden = new Set([
        'openNarratorPanel', 'openSkillPanel', 'openRecommendPanel',
        'logRetain', 'qqGroup', 'openFeedbackGroup',
    ]);
    const text = html => String(html || '').replace(/<[^>]*>/g, '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').replace(/^\s*打开\s*[·・]?\s*/, '').trim();
    const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const explanations = {
        decisionScore: '无名AI核心决策引擎总开关。',
        aiStrength: '控制冠军策略对最终决策的影响力；不等同于“模型正确率”。',
        adaptiveDifficulty: '根据近期表现调整AI强度；关闭后保持固定档位。',
        openConfigPanel: '查看当前生效的主要配置与运行状态。',
        autoIdentityMatch: '根据身份模式自动匹配策略档案。',
        broadcastAI: '同阵营AI共享攻击意图与集火方向。',
        responseAI: '优化闪、桃、无懈等响应与关键资源保留。',
        comboChain: '识别酒杀、铁索属性伤害、拆防连杀等组合；铁索专项归属锦囊牌。',
        compareAI: '拼点与选牌优化，降低高点数关键牌被无意义消耗。',
        deckAwareness: '根据公开信息统计已出现牌，修正牌堆相关概率。',
        deckConsumeAllPlayers: '把所有玩家公开可见的牌消耗纳入牌堆统计，不读取隐藏手牌内容。',
        enablePlanner: '多步战术规划与残局推演。',
        psychologyLayer: '威慑、意图识别、压迫力与策略保留。',
        openPlanPanel: '查看最近一次真实决策产生的战术计划，不额外重复计算Planner。',
        hardOverride: '无名AI接管层总开关；异常时仍保留安全降级。',
        override_use: '接管出牌阶段相关决策。',
        override_respond: '接管响应阶段相关决策。',
        override_discard: '接管弃牌阶段相关决策。',
        override_compare: '接管拼点阶段相关决策。',
        openOverridePanel: '查看接管层、熔断与降级状态。',
        useTrainedModel: '允许已就绪模型参与当前支持的复核与学习链路。',
        decisionFeedback: '记录目标、阶段、留牌等决策反馈。',
        skillFeedback: '根据对局结果修正技能评价。',
        styleFeedback: '根据结果修正对手风格标签可信度。',
        crossGameMemory: '跨局保留可复用的策略记忆。',
        playerMemory: '保留玩家长期行为画像与相关统计。',
        championBoost: '控制已训练冠军策略对匹配决策点的提权强度。',
        openMemoryPanel: '查看跨局记忆与长期画像。',
        showReport: '对局结束后展示图文战报。',
        archiveGames: '保存历史战报供后续回看。',
        narrator: '把决策信号转换为可读解释。',
        showLog: '显示积分明细调试日志。',
        testDecisionLog: '摘要/详细模式显示最终动作、次选、分差、耗时及关键决策信号。',
        persist: '保存结算历史到本地存储。',
        openPanel: '打开决策积分主面板。',
        openArchivePanel: '查看已归档战报。',
        openFeedbackPanel: '回看最近决策与反馈信息。',
        openReplayPanel: '查看决策回放时间轴。',
        openSmartPanel: '打开智能可视化面板。',
        exportTrainingData: '导出训练样本及相关学习数据。',
        exportAllData: '将主要面板、训练、日志、知识与权重数据合并导出。',
        importTrainingData: '导入兼容的训练数据。',
        openBrainDashboard: '总览主要AI模块与运行状态。',
        openHealthPanel: '查看引擎健康度。',
        openSelfCheck: '执行模块自检。',
        openFullMonitor: '汇总显示主要监控数据。',
        openDecisionDashboard: '观察当前决策链关键状态。',
        openComparePanel: '对比不同策略档案在同一局面的选择。',
        openSkillBreakdownPanel: '查看技能拆解与识别结果。',
        openPsychologyMonitor: '查看博弈策略实时统计。',
        profiler: '记录决策各阶段耗时，用于定位卡顿。',
        openProfilerPanel: '查看性能分析结果。',
        openProfilerMonitor: '查看实时性能指标。',
        openComboMonitor: '查看当前识别到的连招组合。',
        useResidual: '模型高级结构选项；普通玩家无需调整。',
        learningRate: '模型训练学习率；仅建议测试/训练时调整。',
        forceTrain: '使用当前样本手动触发一次训练。',
        showSampleCount: '查看当前训练样本数量。',
        showModelStatus: '查看模型阶段、准确率与就绪状态。',
        autoFixModel: '检查模型关键结构并尝试修复异常启动状态。',
        openChampionPanel: '查看冠军策略嵌入。',
        openCalibratorPanel: '查看决策校准趋势。',
        openHotSwapPanel: '查看候选模型与A/B状态。',
        openEvolutionPanel: '查看策略进化状态。',
        openSharedPanel: '查看公共知识库。',
        openGuardPanel: '查看模型护栏与拦截统计。',
        openPostCheckPanel: '查看决策后检查结果。',
        openPostCheckMonitor: '查看后置检查实时状态。',
        openSoftMetricsMonitor: '查看软指标参数与统计。',
        showTrainStats: '查看训练缓冲区统计。',
        clearTrainingBuffer: '清空训练缓冲区；属于维护操作。',
        clearSamples: '清空训练样本；不可恢复。',
        importOverwrite: '用备份数据覆盖当前本地数据。',
        importMerge: '将兼容数据合并到当前本地数据。',
        openExportPanel: '打开完整导出面板。',
        quickExportAll: '快速导出全部支持的数据。',
        clearGameLogs: '清空扩展保存的对局日志。',
        openMemoryMonitor: '查看记忆系统实时状态。',
        openAutoFeatureMonitor: '查看自动特征统计。',
        openTrainBufferMonitor: '查看训练缓冲队列。',
    };

    const currentMode = lib.config.extension_无名AI_settings_mode === 'developer' ? 'developer' : 'player';

    function applyMode(mode) {
        const safeMode = mode === 'developer' ? 'developer' : 'player';
        try { game.saveConfig('extension_无名AI_settings_mode', safeMode); } catch (_) {}
        const apply = function () {
            if (!document || !document.body) return;
            document.body.dataset.djscSettingsMode = safeMode;
            document.querySelectorAll('.djsc-mode-choice').forEach(function (node) {
                node.dataset.active = node.dataset.mode === safeMode ? 'true' : 'false';
            });
        };
        try { apply(); } catch (_) {}
        try { setTimeout(apply, 0); } catch (_) {}
    }

    try {
        if (typeof document !== 'undefined' && document.body) document.body.dataset.djscSettingsMode = currentMode;
        else setTimeout(function () {
            if (typeof document !== 'undefined' && document.body) document.body.dataset.djscSettingsMode = currentMode;
        }, 0);
    } catch (_) {}

    function copyGroupNumber(button) {
        const finish = function (copied) {
            if (!button) return;
            button.textContent = copied ? '已复制' : '请手动复制';
            button.classList.add('djsc-copy-result');
            setTimeout(function () {
                button.textContent = '复制';
                button.classList.remove('djsc-copy-result');
            }, 1800);
        };
        (async function () {
            let copied = false;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(QQ_GROUP);
                    copied = true;
                }
            } catch (_) {}
            if (!copied) {
                const input = document.createElement('textarea');
                const previousFocus = document.activeElement;
                input.value = QQ_GROUP;
                input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
                document.body.appendChild(input);
                try {
                    input.focus();
                    input.select();
                    copied = document.execCommand('copy');
                } catch (_) {}
                finally {
                    input.remove();
                    if (previousFocus && previousFocus.focus) previousFocus.focus();
                }
            }
            finish(copied);
        })();
    }

    const result = {};

    const headerText = text(source.djscBd && source.djscBd.name ? source.djscBd.name : '无名AI');
    const versionText = (headerText.match(/v\s*([^\s]+)/i) || [null, ''])[1];
    result.settingsHeader = {
        clear: true,
        nopointer: true,
        name: '<div class="djsc-settings-header"><b>无名AI</b><span>' + (versionText ? 'v' + escape(versionText) : '设置中心') + '</span><small>决策 · 策略 · 学习 · 诊断</small></div>',
        onclick: function () { return false; },
    };

    result.settingsModePlayer = {
        clear: true,
        name: '<span class="djsc-mode-choice" data-mode="player" data-active="' + (currentMode === 'player') + '"><b>玩家选项</b><small>游戏体验与常用功能</small></span>',
        onclick: function () { applyMode('player'); return false; },
    };
    result.settingsModeDeveloper = {
        clear: true,
        name: '<span class="djsc-mode-choice" data-mode="developer" data-active="' + (currentMode === 'developer') + '"><b>开发者选项</b><small>测试、诊断与模型工具</small></span>',
        onclick: function () { applyMode('developer'); return false; },
    };

    result.aboutTeam = {
        clear: true,
        nopointer: true,
        name:
            '<div class="djsc-team-card">' +
                '<div class="djsc-team-title">无名AI开发团队</div>' +
                '<div class="djsc-team-grid">' +
                    '<span>原作者 / 核心开发</span><strong>飞升</strong>' +
                    '<span>当前维护 / 后续开发</span><strong>微雀qiao（WeiqiaoCode）</strong>' +
                    '<span>内测与宣传</span><strong>小小王同志</strong>' +
                '</div>' +
                '<div class="djsc-team-qq"><span>反馈与交流QQ群</span><strong>' + QQ_GROUP + '</strong></div>' +
            '</div>',
        onclick: function () { return false; },
    };
    result.copyQQGroup = {
        clear: true,
        name: '<span class="djsc-setting-action-row djsc-about-copy"><span class="djsc-setting-name">QQ群：<span class="djsc-feedback-number">' + QQ_GROUP + '</span></span><button type="button" class="djsc-setting-action">复制</button></span>',
        onclick: function () {
            copyGroupNumber(this.querySelector('.djsc-setting-action'));
            return false;
        },
    };

    const assigned = new Set();

    function optionAction(key) {
        if (/clear/i.test(key)) return '清空';
        if (/import/i.test(key)) return '导入';
        if (/export/i.test(key)) return '导出';
        if (key === 'forceTrain') return '训练';
        if (key === 'autoFixModel') return '修复';
        if (key === 'openSelfCheck' || key === 'openFullMonitor') return '检测';
        return '查看';
    }

    for (const group of groups) {
        const storageKey = 'extension_无名AI_settings_group_' + group.id;
        const defaultOpen = group.id === 'player_basic' || group.id === 'dev_runtime';
        const expanded = lib.config[storageKey] === undefined ? defaultOpen : !!lib.config[storageKey];

        result['group_' + group.id] = {
            clear: true,
            name: '<div class="djsc-settings-group" data-scope="' + group.scope + '" data-group="' + group.id + '" data-open="' + expanded + '" data-accent="' + group.accent + '"><span>' + group.title + '</span><span class="djsc-settings-arrow">' + (expanded ? '▼' : '▶') + '</span></div>',
            onclick: function () {
                const header = this.querySelector('.djsc-settings-group');
                const open = header.dataset.open !== 'true';
                header.dataset.open = String(open);
                header.querySelector('.djsc-settings-arrow').textContent = open ? '▼' : '▶';
                game.saveConfig(storageKey, open);
                return false;
            },
        };

        let pseudoIndex = 0;
        for (const key of group.keys) {
            if (key.startsWith('@')) {
                const raw = key.slice(1).split('|');
                const title = raw.shift();
                const desc = raw.join('|');
                result['sub_' + group.id + '_' + (++pseudoIndex)] = {
                    clear: true,
                    nopointer: true,
                    name: '<div class="djsc-setting-subsection" data-scope="' + group.scope + '" data-group="' + group.id + '"><b>' + escape(title) + '</b>' + (desc ? '<small>' + escape(desc) + '</small>' : '') + '</div>',
                    onclick: function () { return false; },
                };
                continue;
            }
            if (key.startsWith('!')) {
                const raw = key.slice(1).split('|');
                const title = raw.shift();
                const desc = raw.join('|');
                result['status_' + group.id + '_' + (++pseudoIndex)] = {
                    clear: true,
                    nopointer: true,
                    name: '<div class="djsc-protected-status" data-scope="' + group.scope + '" data-group="' + group.id + '"><span>🔒 ' + escape(title) + '</span><strong>已启用</strong>' + (desc ? '<small>' + escape(desc) + '</small>' : '') + '</div>',
                    onclick: function () { return false; },
                };
                continue;
            }

            assigned.add(key);
            if (!source[key] || hidden.has(key)) continue;

            const option = { ...source[key] };
            const fullName = text(option.name);
            const label = key === 'importTrainingData' ? '导入AI学习数据' : fullName.replace(/[（(].*$/s, '').trim();
            option.intro = explanations[key] || option.intro || fullName;
            const desc = explanations[key] || '';
            const descHtml = desc ? '<div class="djsc-setting-desc">' + escape(desc) + '</div>' : '';
            const name = '<span class="djsc-setting-name" data-scope="' + group.scope + '" data-group="' + group.id + '">' + escape(label) + descHtml + '</span>';

            if (String(option.name || '').includes('djsc-menu-config-btn')) {
                option.clear = true;
                option.name = '<span class="djsc-setting-action-row" data-scope="' + group.scope + '" data-group="' + group.id + '">' + name + '<button type="button" class="djsc-setting-action">' + optionAction(key) + '</button></span>';
            } else {
                option.name = name;
            }
            result[key] = option;
        }
    }

    const sectionKeys = new Set(Object.keys(source).filter(key => key.endsWith('Bd')));
    const leftovers = Object.keys(source).filter(key =>
        !sectionKeys.has(key) &&
        !assigned.has(key) &&
        !hidden.has(key) &&
        key !== 'openFeedbackGroup'
    );

    if (leftovers.length) {
        const groupId = 'dev_other';
        result.group_dev_other = {
            clear: true,
            name: '<div class="djsc-settings-group" data-scope="developer" data-group="' + groupId + '" data-open="false" data-accent="blue"><span>D9 · 兼容与其他</span><span class="djsc-settings-arrow">▶</span></div>',
            onclick: function () {
                const header = this.querySelector('.djsc-settings-group');
                const open = header.dataset.open !== 'true';
                header.dataset.open = String(open);
                header.querySelector('.djsc-settings-arrow').textContent = open ? '▼' : '▶';
                game.saveConfig('extension_无名AI_settings_group_' + groupId, open);
                return false;
            },
        };
        leftovers.forEach(function (key) {
            const option = { ...source[key] };
            const fullName = text(option.name);
            const name = '<span class="djsc-setting-name" data-scope="developer" data-group="' + groupId + '">' + escape(fullName) + '</span>';
            if (String(option.name || '').includes('djsc-menu-config-btn')) {
                option.clear = true;
                option.name = '<span class="djsc-setting-action-row" data-scope="developer" data-group="' + groupId + '">' + name + '<button type="button" class="djsc-setting-action">' + optionAction(key) + '</button></span>';
            } else {
                option.name = name;
            }
            result[key] = option;
        });
    }

    return result;
}
