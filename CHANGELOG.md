# 无名AI 更新日志（CHANGELOG）

> **当前版本：v4.0.3-test（semver 4.0.3-test）｜发布日期：2026-10-04｜支持本体最低版本：1.11.1**
> 版本号唯一权威源：[js/config/version.js](js/config/version.js)（info.json / package.json 与之保持一致）。
> **当前模型契约（P2-36）：FEATURE_DIM = 130，网络 130 → 128 (GELU+LayerNorm) → 64 (GELU+LayerNorm) → 6 + Critic。**
> 下方 48 / 96 维相关条目均为历史版本记录，不代表当前契约；旧 48/96 维权重与训练数据不兼容，会被拒收。
> **状态：架构测试版。测试阶段以 P0/P1 回归修复为主，暂不继续叠加新的 AI 功能。**

---

## v4.0.3-test 扩展身份与测试入口修复（2026-10-04）

> 修复测试包可以加载，但扩展菜单被本体识别成 `UnknownAI` 空占位页，导致完整配置按钮和决策观察入口无法从扩展设置页恢复的问题。本次不修改 AI 决策策略。

### 扩展身份契约

- **统一扩展名称**：目录 `无名AI/`、`info.json.name` 与 `extension.js` 的扩展名统一为 `无名AI`。
- **兼容旧失败状态**：如果此前坏包曾让本体自动关闭 `extension_无名AI_enable`，更新后扩展页会正确显示“无名AI”，用户可重新开启并重启。
- **新增发布阻断**：Release audit 会比较包目录名、`info.json.name` 与 `extension.js` 名称，不一致直接禁止发布。

### 测试可观测性门禁

发布前强制确认以下关键入口仍存在并正确挂载：

- `openScorePanel`
- `openFeedbackPanel`
- `openPlanPanel`
- `openHealthPanel`
- `openDecisionDashboard`
- `openSelfCheck`

同时检查 `js/config/config.js` 已接入 `extensionPackage.config`，避免再次出现“扩展能加载但设置按钮缺失”的测试盲区。

---

## v4.0.2-test 发布包依赖修复（2026-10-04）

> 修复 v4.0.1-test Release ZIP 遗漏运行时 `logs/` 依赖，导致 `js/config/changelog.js` 无法解析、扩展入口加载失败的问题。该问题属于发布包完整性错误，不涉及 AI 决策逻辑。

### 发布包修复

- **恢复运行时 `logs/` 目录**：`logs/今日修改日志.js` 与 `logs/WORK_TRAIL.js` 被 `js/config/changelog.js` 直接 import，现正式纳入测试包。
- **新增 Release dependency audit**：打包阶段扫描包内 JS 模块的相对静态 `import/export` 与字面量 `import()`，目标文件缺失或越出扩展根目录时直接阻断发布。
- **新增关键运行时文件契约**：`extension.js`、`info.json`、`js/config/changelog.js`、两份 `logs/*.js` 必须实际存在于待发布目录。
- **ZIP 结构校验同步更新**：`logs/` 不再被误判为开发目录；仍排除 `.github/`、`tests/`、`build/`、`DEV_GUIDE/`。
- **发布文件名改用 ASCII**：测试资产统一为 `UnknownAI_<version>.zip`，避免中文文件名在 GitHub/下载链路中被截断或重写。

### 兼容说明

- `v4.0.1-test` 已知为不可用发布包，不建议继续测试。
- 本版本作为第一份可用于真实游戏加载验证的 4.0 测试候选版。

---

## v4.0.1-test 架构测试候选版（2026-10-04）

> 该版本用于验证 3.x 后期至当前累计的底层决策架构重构。重点不是继续增加规则，而是确认统一状态、敌我关系、动作评分、技能事务、身份推理、残局与特殊牌 evaluator 在真实对局中的整体稳定性和行为一致性。

### 状态、关系与身份信息边界

- **World-state / Relations 收敛**：关系变化、身份明置与行为证据变化会主动使旧决策缓存失效，避免沿用过期敌我结论。
- **身份配额推理**：区分 hard fact、逻辑可能身份和动态 stance；已知身份数量达到模式配额后，未明身份的候选空间会相应收缩。
- **信息边界加固**：身份推理和策略层只允许使用公开/可推断信息，避免通过宿主内部字段直接获取不该知道的隐藏事实。

### 动作候选、评分与策略层

- **Action Candidate 契约统一**：候选动作的类型、目标与执行身份保持一致，避免评分的是 A、最终执行成 B。
- **Utility / Policy Priority 分离**：动作收益与“必须优先执行”的策略权限分开；普通高分不会冒充强制动作。
- **Decision Margin / Policy Band 收敛**：统一“明显更优 / 同档候选”的比较语义，减少不同模块各自定义阈值。
- **评分方向修复**：保留价值只作为机会成本，不再反向提高出牌欲望；play feedback 与 keep feedback 分开。
- **Delta / Multiplier 契约统一**：相对增量与倍率不再混用，正增量在正负 utility 上都保持“提高收益”的方向一致性。

### 技能决策内核

- **通用技能目标决策**：技能目标、选牌与联合选择统一进入可比较的候选体系。
- **多阶段技能事务**：前一步已经选择的目标/牌会作为事务上下文传递到后续步骤，避免技能中途丢失意图后重新乱选。
- **Host bridge 对齐**：宿主侧实际选择结果与内核候选保持同一语义，减少技能 evaluator 与最终执行分叉。

### 战略连续性与特殊牌

- **Strategic Transition Ledger V2**：战略状态的创建/解除以真实公开状态变化确认，不再因为“计划执行”就提前假定状态已经改变。
- **桃 / 铁索 / 无懈 / 判定牌**：继续使用单一权威 evaluator，旧的并行最终 policy 已逐步退役。
- **回合内动作一致性**：加入自我抵消惩罚与状态 freshness，降低“刚兵乐又自己拆顺”等互相打架的连续动作。
- **AOE 单一评估入口**：南蛮/万箭只根据公开手牌数量、公开装备、公开血线、行为概率和牌堆记忆估算，不再精确读取对手隐藏杀/闪。

### 残局与多轮规划

- **统一 game phase**：`alive <= 4` 作为残局事实优先于轮次阶段；early / mid / late / endgame 不再由多个模块各自重新定义。
- **残局职责分离**：阶段层不再默认“全力进攻”；斩杀、保命、1v2、生存、救援等具体策略由 endgame evaluator 负责。
- **Multi-turn 收敛**：多轮规划消费统一 phase，残局不再重复给“杀 / 桃”做泛化倍率。

### 测试门禁

- 现有 release gate：**1296 项断言**。
- v4.0.1-test 新增并保留 phase/AOE contract：**31 项断言**。
- 当前自动化门禁合计：**1327 项功能 / 契约断言**，覆盖模型、训练、插件生命周期、桃、铁索、无懈、回合一致性、状态/关系契约、身份边界、技能事务、动作评分、残局与 AOE 等。
- 自动化门禁只负责防止已知契约回归；v4.0.1-test 的主要目的仍是进入真实对局进行冒烟、专项和完整局测试。

---

## v3.1β 整体架构稳定化（2026-10-02）

> 对应《05_DeepSeek4_整体架构稳定化指令》与《无名AI3.1_整体问题审计与修复路线总结》。
> 唯一目标：逐步收敛为 `Game State → Unified Snapshot → Unified Relations → Card/Response Evaluators → Unified Action Utility → bestAction → Override/Native AI`，同一局面只有一套事实解释、同一种最终决策只有一个权威策略。

### Stage A–C：状态事实 / 关系 / targetBrain 数据契约收敛

- **A·Unified Player State Snapshot**：统一 `alive/hp/maxHp/handCount/linked/judgeCards/equipCards/equipValue/nextToAct/threat`，收敛 `isLinked()/isLinked/isChained/judges/isJudge/isJudged/equipVal` 等碎片读取（见 `score/decision/state/`）。
- **B·Relations Single Source of Truth**：审计 `score/decision/**` 中 `get.attitude()`、身份直读与 `isAllyOf/isEnemyOf/dispositionOf`，最终 policy 决策统一走 `relations.js`。
- **C·targetBrain Data Contract**：形成唯一 `buildPlayerSnapshot()`/`buildTargetCandidate()`，确保 `handCount/equipValue/judgeCards/nextToAct/linked/relation/threat` 真实且更新。

### Stage D：Action Semantics / State Transition Utility

- **动作语义唯一源 `inferPurpose`**：`attack / control / dismantle / state / heal / gain / generic` 七类粗分类；把「过河拆桥/顺手牵羊」从 control 拆分独立为 `dismantle`，覆盖「过河拆队友乐」「顺手解队友负面判定区」反例。
- **收益系统 `actionValue` / 方向评分 `directionScore`**：对拆除类动作区分「拆敌人 / 拆队友负面判定区（正收益） / 拆队友好牌（仍负）」；新增 `_hasNegativeJudge` 识别乐不思蜀/兵粮寸断/闪电等负面延时牌。
- **铁索（`state`）/ 闪电（`generic`）归位**：铁索最终策略交由 `tiesuoEvaluator` 唯一权威；闪电为自用、`judgeBrain` 唯一决定。

### Stage E：Behavior Regression Suite

- 新增 `tests/behavior/`：`tao_rescue.mjs`、`tiesuo.mjs`、`wuxie.mjs`、`judge_control.mjs`、`turn_consistency.mjs`、`jiedao.mjs`、`global_tricks.mjs`，加之 `_harness.mjs` 统一断言底座；以后行为 bug 先写 failing behavior test。

### Stage F：特殊牌 Evaluator

- **借刀杀人**：`weaponHolder + victim` pair 动作评估（`jiedaoEvaluator.js`），枚举合法 pair 并选最优。
- **桃园结义**：按 `Σ allyHealValue − Σ enemyHealValue` 净治疗效用评估（`taoyuanTiming.js`）。
- **五谷丰登**：综合敌我人数、手牌需求、座次、选牌顺序与公开牌价值评估净效用（`wuguTiming.js`）。

### Stage G：Timing Audit

- 审计 `score/decision/timing/**` 的未显式 import `get/game`、silent fallback、重复最终 policy、未接入模块与 evaluator 冲突逻辑；每个模块标记 `ACTIVE/WRAPPER/LEGACY/DEAD/EXPERIMENTAL`。

### Stage H：Hook Lifecycle

- 收敛 `Player.prototype.*` / `game.*` / `get.*` monkey patch 的 original ref / install flag / install / uninstall / restore 闭环；重点修复 `game.gameDraw`、`proto.phaseBegin`、`game.check`（广播）三处「卸不干净 / 重装失效」缺陷，验证 install→uninstall→install again。

### Stage I：Cache Audit

- 手牌推断缓存 `handInference.js` 新增 `_inferKey`（手牌数精确值 + 牌堆 log2 分桶 `/ _deckBucket`），`probHasShan/probHasWuxie/probHasTao/probHasSha/probHasJiu/probHasEquip/probHasCard` 统一接入。
- 局势评估缓存 `threat.js` 新增 `_aliveFingerprint`（存活玩家血量×手牌聚合指纹），纳入 `situationFactor`/`incomingPressure` 缓存 key，消除 stale cache。

### Stage J：Exception Health

- `diag/swallow.js` 新增 `reportUnexpected/resetUnexpected`（模块/原因/计数/最后发生时间）与 `unexpectedStats`（结构化诊断），统一挂载 `window.__DJSC`。
- `diag/health.js` 汇入「异常健康度」检查项；`extension.js` 面板挂载失败与 `installScoreEngine` 安装失败上报 unexpected，杜绝模块坏掉只表现为「AI 变笨」。

### ✅ 发布门禁

- [tests/run_tests.mjs](tests/run_tests.mjs) 全量 **727 项断言**通过（§10.1 … §10.33）；`tests/behavior/` 7 套行为套件全通过。`node tests/run_tests.mjs` 退出码 0，可接 CI。

---

## v3.1α 铁索连环状态规划修复（2026-10-02）

> 对应《02_DeepSeek4_铁索连环状态规划修复指令》与《无名AI3.1_铁索连环状态规划与重铸决策_实施方案》。
> 唯一目标：把【铁索连环】从"可选两目标的普通锦囊"改造为**对全局横置集合进行最多两次 toggle 的状态优化动作**，建立唯一权威的铁索策略源。
> **关键澄清**：本任务**不是**"铁索必须选两个目标"——单目标 / 双目标 / 重铸三者同等合法，由全局状态效用决定。

### 🔗 唯一权威：Tiesuo Evaluator

- **新增 [tiesuoEvaluator.js](score/decision/cards/tiesuoEvaluator.js)**：铁索最终策略唯一权威源。
  - 纯模拟器 `getCurrentLinkedSet` / `toggleLinkedSet`（对称差 toggle，**不改真实 Player**）。
  - 合法动作枚举 `generateTiesuoActions`：RECAST / 单目标 / 双目标，去重去非法，覆盖 8 人局 37 个候选（1 + 8 + 28），**拒绝 top1/top2 近似**。
  - `evaluateLinkedState`（relation + HP + role）、`scoreTiesuoAction`（ΔU）、`estimateTiesuoRecastValue`、主入口 `evaluateTiesuoActions`。
  - 轻量属性机会 modifier（§11.4）：我方有属性伤害手段 → enemy-linked ×1.15；敌方有属性威胁 → ally-linked 罚分 ×1.15。

### 🧩 状态事实层：唯一横置状态读取入口

- **新增 [playerState.js](score/decision/state/playerState.js)**：导出 `isPlayerLinked(player)`，全库唯一横置状态读取入口。
  - `isLinked` 是函数时调用取值，非函数时才回退 legacy 布尔字段；缺失/非法/抛错一律 **fail-closed 返回 false**。
  - 消除 `!!p.isLinked`（函数对象恒真陷阱）、`!target.isLinked`、`isChained` 与自造 `isLinking`。

### ⚙ 决策内核集成

- **[engine.js](score/decision/engine/engine.js)**：tiesuo 分支改调 `evaluateTiesuoActions`，删除旧 `top1/top2` 与"最多连 6 个"硬编码；`use → targetNames`、`recast → ba.recast=true`（重铸不再伪装成普通 use）；`_finalResult` 显式携带 `target`/`recast`；新增属性机会 modifier（复用 `threat.linkedChainValue`）并传入 evaluator；删除自造 `ctx.isLinking`。
- **[aiOverride.js](score/decision/safety/aiOverride.js)**：新增纯谓词 `isRecastRecommended(ba)`（严格 `recast === true`），在 `aiOrder`/`aiValue`/`useful` 三处加 recast 短路守卫，避免原生 AI 优先"打出铁索"而堵死宿主重铸路径。

### 🧹 legacy 铁索启发收敛（消除第二套最终 policy）

- **[cardPlayBrain.js](score/decision/cardplay/cardPlayBrain.js)**：删除 `canChainEnemies`、`if(id==='tiesuo') return 72/20` 专用优先级、`pickTarget` 中 tiesuo 专用分支与自造 `isLinking` 读取；tiesuo 落回 control 默认（分类/`isAllyUsable` 保留）。
- **[damageTransfer.js](score/decision/safety/damageTransfer.js)**：删除 `tiesuoTiming` / `tiesuoBonus` 两套并行启发式；保留 `countTiesuo`（纯统计）。
- **[optimization.js](js/content/optimization.js)**：火攻横置传导与 `lib.card.tiesuo` 覆写全部改调 `isPlayerLinked`，方向与 evaluator 对齐。
- **[threat.js](score/decision/threat/threat.js)**：`linkedChainValue` 改调 `isPlayerLinked`，并**保留复用**为 evaluator 属性机会 modifier 输入。

### 🩺 统一诊断

- 每次铁索决策写入 `_status.djsc_lastTiesuo`（当前横置集合 / 全部候选与 ΔU / 最终 `{type, targets, score, reason}`），可解释每次单/双/重铸选择。

### ✅ 发布门禁

- [tests/run_tests.mjs](tests/run_tests.mjs) 新增 **§10.13–§10.19** 断言矩阵（状态读取全矩阵、纯模拟器、动作枚举、utility/delta、recast 竞争、engine 集成与决策范例 1–4、aiOverride recast 对齐、legacy 收敛源码守卫），总计 **403 项**全通过（TDD 先红 19/403，后全绿）。

---

## v3.1α 桃救援策略修复（2026-10-02）

> 对应《01_DeepSeek4_桃救援策略修复指令》与《无名AI3.1_敌方濒死误出桃_修复方案》。
> 唯一目标：修复 AI 对**敌方濒死**角色错误使用【桃】的 P0 战术错误，建立唯一权威的救援策略源。

### 🍑 唯一权威：Tao Rescue Policy

- **新增 [rescuePolicy.js](score/decision/safety/rescuePolicy.js)**：导出 `evaluateTaoRescue(player, target, ctx)`，统一裁决"当前是否允许用桃救 target"，返回 `{ allow, relation, disposition, score, reason }`。
  - 不变量：`self → allow`、`ally → allow`、`neutral → block`、`enemy → block`、`invalid/missing → block`。
  - **「濒死」只提升紧急度，绝不反转敌我方向**；`target === player` 特判为自救（绕过 `dispositionOf(me,me)=0` 陷阱）。
  - 关系解析顺序：注入 `ctx.disposition` → `ctx.relations.dispositionOf` → `ctx.attitude` → 默认 `relations.dispositionOf` → `get.attitude` 回退；**任一关系源异常/缺失 → 非 self 一律 fail-closed 拦截**（宁可少救一个未知对象，也不把桃送给敌人）。
  - Score 契约与 `relations.actionValue()` 量级一致：`self +8 / ally +5 / neutral −3 / enemy −8 / invalid −8`。

### 🔧 三层软评分对齐（去掉"濒死优先于敌我"的 early-return）

- **[optimization.js](score/decision/safety/optimization.js)**：删除 `if (dying && dying === target) score = 5.0;` 的**无条件 +5**，改由 `_scoreTao()` 委托 policy —— 敌方/中性濒死得到**负分**，不再向 bestAction 暴露正救援倾向。
- **[responseAI.js](score/decision/cardplay/responseAI.js)**：`_shouldSaveTao()` 移除 `target.hp <= 0 → return false` 提前返回（该 early-return 直接绕过了敌我判断），濒死场景改由 policy 决定"是否保留桃"。
- **[respond.js](score/decision/override/respond.js)**：`_keepTao()` 移除 `dyingTarget.hp <= 0 → return false` 同型 shortcut，统一走 policy。

### 🛡 chooseToUse 窄范围 Hard Guard（Root Cause D）

- **[use.js](score/decision/override/use.js)**：新增 `_resolveDyingTarget()`（沿已验证事件链 `event.dying → getParent()…` 上溯，最大 6 层、`Set` 防循环引用、**绝不扫描 `game.players` 猜 hp≤0**）与 `_shouldBlockTaoRescue()`（唯一读 policy）。
- 在常规 `_shouldOverride()` **之前**安装"桃救援护栏"：仅包装 `ev.filterCard` 对 `tao` 追加 veto，非桃牌与其余路径完全走原生 filter；护栏异常时保守放行。
- **不删除 `_status.currentPhase !== player` 全局保护**（不扩大 bestAction 接管范围），只为"敌方/中性濒死求桃"建立窄范围例外；allow（self/ally）时仍走原生流程。
- 回合外路径 `currentPhase !== rescuer` 时，敌方濒死 `filterCard(tao) === false`，桃对 AI 不可用。

### 🩺 统一诊断

- 救援拦截/放行统一写入 `_status.djsc_lastResponse`（`kind: 'tao-rescue-block' | 'tao-rescue-allow'`，含 `relation / disposition / reason / target / source / ts`），F12 可直接定位"为什么救/为什么不救"；仅记录标量与目标名，不持有大对象引用。

### ✅ 发布门禁

- [tests/run_tests.mjs](tests/run_tests.mjs) 新增 **§10.12 桃救援策略**断言矩阵（含 self/ally/enemy/neutral/invalid、attitude 回退、disposition=NaN 回退、relation API 失败 fail-closed、1 桃/多桃方向不变、optimization/responseAI/respond/use 四层防线覆盖），总计 **280 项**全通过。

---

## v3.1α 深度系统审查修复（2026-09-30 ～ 2026-10-01）

> 对应《无名AI3.1α 深度系统审查报告》P0（10 项）/ P1（20 项）/ P2（9 项），共 39 项全部闭环。

### 🔧 模型链路（最高优先级）

- Int16 偏置 codec 修复（B1–B4 此前按 Int8 解码，任何 save/load 都几何错位）；load 路径补全 shape/type 校验，失败 fail-closed。
- 内置默认权重（v6 旧契约）与运行时 v7 不一致时**明确拒绝**：不再"显示预训练、实际随机"；诊断可经 `getDefaultDiag()` 查询。v7 离线预训练权重待重新生成（需真实对局样本）。
- 修复 B2/B3 持久化写错网络层；HotSwap 快照补全 Critic 头与残差投影、全部 AdamW 动量；候选训练与 stable 完全隔离，discard/promote 语义闭环。
- 反向传播改为"先算完全部梯度再统一 AdamW 更新"；三套前向（forward / forwardWithValue / forwardFastWithValue）统一为同一几何（GELU + LayerNorm + 残差投影）。
- **修复 `predict()` 恒返回兜底的致命问题**：`softmax` 返回 `Float32Array`，旧代码用 `Array.isArray` 判定恒为 false，导致线上 action 恒为 B、置信度恒 0；兜底均匀分布同步改为严格归一（1/6）。
- `resetWeights()` 失败时不再偷偷随机化在线权重，真正"原样保留、不落盘"。
- 训练数据导入强契约：仅 **130 维且逐项有限数**的样本可入 BUFFER（48/96/129/131 维、NaN、字符串一律拒收并计数）。

### 🔌 插件生命周期 / 自检

- enginePlugin 注册与安装分离；依赖失败可自恢复；卸载清 props / timers / 动态 import / hook patch；延迟注册复活问题修复。
- verifyAll 改为真实 await、按面板独立判定；selfCheck 从空壳改为真检查；modularReady 时序修正。
- eventBus 真正接入业务链路（game:start/end、train:start/done/fail、局末 flush 落盘）。

### 🛠 工程收敛

- 业务层 localStorage 直调（43 文件）全部收敛到中央存储；配额守护分级清理，绝不静默删除权重/战报/记忆。
- 1498 处空 catch 全部接入限流观测器（`__DJSC.swallow / swallowStats / resetSwallow`），默认只计数、采样日志，不打断对局。
- 版本号单一权威源 [js/config/version.js](js/config/version.js)；语义审计快照改由 `build/semantic_audit.mjs` 生成。
- 删除假 Worker（从未被调用、只模拟损失），本地训练改分片协程让出主线程。
- **新增发布门禁**：[tests/run_tests.mjs](tests/run_tests.mjs)（`node tests/run_tests.mjs`，零依赖，203 项断言覆盖报告 §10.1~10.9，含反向传播逐层有限差分核验、首步更新方向验证、插件生命周期全段；§10.10 自检面板须游戏内控制台验证；失败退出码 1，可接 CI）。

### 🧬 A/B 状态机合并（报告 §7/§8）

- **§8：modelState.js 与 modelHotSwap.js 双状态机（重复真相源）已合并为单一 A/B 状态机**，本体在 [modelState.js](score/model/net/modelState.js)：`STABLE → trainCandidate() → CANDIDATE → evaluate() → PROMOTE / DISCARD → STABLE`，每状态带不变式（STABLE 无候选；CANDIDATE 每局 `hotGameStart` 明确分组、局末精确还原；PROMOTE 换入候选并持久化、清分组备份不还原；DISCARD 还原稳定模型）。
- 手动 `forceTrain` 与自动 `triggerHotTrain` 共用**同一候选槽、同一分组、同一评估口径**（实战胜率差 ≥5% 晋升，可经配置 `modelPromoteGap` 调整）；原 modelState 的"训练准确率 vs 基线准确率"伪评估已废弃，统一为真实 A/B 分组分数。
- 统一持久化到单一存储键 `djsc_model_state`（v2），原 `djsc_hotswap_v1` 存档一次性迁移（候选/计数保留）后删除；候选跨会话存活自动恢复 A/B。
- **modelHotSwap.js 降级为兼容外壳**：导出签名（`triggerHotTrain/hotGameStart/hotRecordABScore/hotSwapStats/resetHotSwap/forcePromote/forceDiscard`）与 `window.__DJSC.hotSwap.*` 挂载保持不变，全部委托 modelState.js；引擎、配置面板、selfCheck、发布门禁零改动。
- **§7：weights.js 落地单一模型契约 `MODEL_SCHEMA`**（version/featureDim/dims/dtype/architecture），`DIM_CHECK` 与 A/B 快照结构护栏（NET）统一由它派生，消除手写维度。
- 门禁新增 4 条 §8 不变式断言（state 流转、统一存储键写入、legacy 键迁移删除），总计 203 项。

### 🧭 自检系统四层拆分（报告 §9）

- **新增 [layers.js](score/verification/layers.js) 四层统一自检**，解决"检查真实功能"与"检查有没有一个函数名"混层问题：
  - **L1 加载契约** —— 8 个关键模块 import 成功 + 导出 shape/type 逐项核对 + `MODEL_SCHEMA` 契约形状（version/featureDim/dims/dtype/architecture）；
  - **L2 运行时连接契约** —— 委托 `registry.audit()`（CONTRACT 权威）+ `__DJSC` 关键命名空间 + 插件 disabled 状态 + `modularReady`；
  - **L3 功能 smoke** —— 真实调用：`forward(zeros130)` 6 维全 finite、`predict` probs 归一（Σ≈1）、三套前向同几何、中央存储 encode→decode 精确 roundtrip（临时键即写即删）、A/B 状态机合法态、eventBus 真实业务订阅（≥3）；
  - **L4 实战行为验证** —— 目标选择/响应/弃牌/拼点/回合结束/异常模式 6 项，显式标注 manual、**永远不计入失败**，只能真实对局确认。
- 调用入口：`__DJSC.verifyLayers()`（结构化）/ `__DJSC.verifyLayersText()`（可读文本）；verifyAll 报告头部新增四层汇总条与"分层"分类行，原分类明细零改动。
- 六套既有自检归位：`registry.audit`→L2 权威；`selfCheck`/`verifyAll` 存在性检查→L1/L2、功能级调用→L3；`health`→L2/L3 运行时环境；`professionalReadiness`/`semanticAudit`→架构就绪度与静态审计（L1 静态侧），保持独立。
- 门禁新增 §10.11 共 20 条断言（L1/L3 Node 下全通过；L2 依赖宿主挂载面只校验结构；L4 必须全 manual），总计 **226 项**。

### 🏋 离线预训练管线（报告 §14C）

- **新增 [build/train_default_weights.mjs](build/train_default_weights.mjs)**：用真实对局导出的 JSONL 样本离线重训 v7 内置默认权重，打通 P0-03 正向闭环。
  - 训练口径与游戏内 localTrainer 完全一致：130 维契约校验（脏样本拒收计数）→ 打乱 → 80/20 划分 → 余弦退火 `trainOneWithValue` → 验证集准确率 → `saveWeights` 序列化（Int8 权重 / Int16 偏置 base64）→ 重写 `defaultWeights.js`。
  - 用法：`node build/train_default_weights.mjs <样本.jsonl> [--epochs N] [--lr 0.02]`，样本需 ≥200 条（游戏内经 `__DJSC.trainExport()` 导出）。
- **门禁 §10.2/§10.3 改为版本自适应**：默认权重 v6（当前）走 fail-closed 分支；重训出 v7 后自动切换正向分支（加载成功、ready=true、reset 确定性恢复出厂、连续两次 hash 一致）。
- **门禁同时充当默认模型质量闸**：§10.5 梯度有限差分探针会拒绝饱和/死梯度模型——样本质量不足时训练脚本会提示但门禁阻止发布，这是设计行为。
- **修复游戏内控制台 `DJSC is not defined`**：扩展全局对象只挂了 `window.__DJSC`，控制台/旧教程裸写 `DJSC.xxx` 直接 ReferenceError；现 `window.DJSC` 指向同一对象作为兼容别名（extension.js）。

### 🛡 数据隔离（新旧版本数据不互相污染）

- **样本层统一清洗闸**（[trainExport.js](score/model/train/trainExport.js) `_sanitizeSample`）：旧版本样本存在 reward 写入 bug（reward 恒 ~100，与 meta.score 完全脱节）。以 `meta.score`（±147 裁剪前原始评分）为权威值，`|reward − clamp(round(score))| > 1` 即判旧版污染并自动修复，无依据且非法的样本丢弃。三个入口全部接管：IndexedDB 启动加载、localStorage 回退加载、手动导入旧导出文件；导入返回新增 `repairedReward` 字段报告修复条数。
- **权重层数据纪元**（weights.js `DATA_EPOCH = 2`）：客户设备上"旧版本自己打 + 手动训练"得到的权重参数本身已被污染标签训歪，v7 版本号只能挡结构不兼容、挡不住"结构对但标签脏"。现 `saveWeights` 统一写入 `dv=2`；凡 v7 存档缺 `dv` 标记且 `trained > 0`，`loadWeights` 一律拒载并回退内置默认权重（日志明确提示）。内置默认权重 `trained=0` 不受影响。

---

## v3.1α / 3.1.0（2026-09-26）

### 📦 架构分层（`score/` 域化重构）

- **165 个平铺模块 → 11 个功能域子目录**：`core / model / think / decision / economy / timing / observe / guard / optimize / ui / selfcheck`
- **唯一对外入口不变**：`score/index.js` 保持原位，`extension.js`、`js/config.js`、`build-mod.mjs` 对分层透明
- **619 处相对 `import` 按新深度重写**；跨域引用改为相对路径，宿主引用统一为 `../../../../noname.js`
- **域结构索引**：`score/_DOMAIN.md` 重写为权威清单 + 依赖规则；`DEV_GUIDE` 目录树同步更新

### 🔧 Bug 修复（本次一并处理）

| 问题 | 影响 | 修复 |
|---|---|---|
| `postCheck.js` 中 `const campDelta` 被重新赋值 | 赋值抛异常 → `gain += campNet*0.5` 永不执行，阵营净收益未并入 gain | 改为 `let campDelta` |
| `selfHeal.js` 用 `key + '.js'` 拼路径动态 import | `narrator` 键映射到不存在的 `narrator.js`，自修复静默失败 | 契约表显式声明 `file` 字段（narrator → decisionNarrator.js） |
| 迁移后 `panel.js` / `allyExempt.js` 跨层引用深度错误 | `./override/index.js`、`../js/utils.js` 失效 | 修正为 `../override/index.js`、`../../js/utils.js` |

---

## v2.5.0（2026-09-23）

### 🔧 Bug 修复（导致扩展加载失败/功能不生效）

| 问题 | 影响 | 修复 |
|---|---|---|
| `trainExport.js` 引用未定义的全局函数 `exportJSONL` | **整个扩展加载崩溃**，弹 ReferenceError | 删除无效的劫持代码，扩展数据通过 `collectExtendedTrainingData()` 单独导出 |
| `allyExempt.js` 错误 import `../../js/utils.js` | 真实加权校验模块加载失败，静默退回硬编码内联桩 | 修正为 `../js/utils.js` |
| 25 个子目录文件、121 处相对 import 路径错误 | 子目录模块化版全部无法加载 | 批量修正：`./core/logger.js` → `../core/logger.js` 等 |

### 📦 架构升级

- **子目录模块化版激活**：通过 `import('./core/index.js')` 递归加载所有子目录模块（300+ 文件），仅注册不重复安装 hook
- **批量暴露 31 个模块到全局 `window.__DJSC`**：供自检面板访问各模块的 stats/getStats 函数
- **活代码文件数**：~154 → 358

### ✅ 自检面板升级

- **功能级自检**：33 个模块逐个调用 `stats()` / `getStats()` / `guardStatus()` 等函数，真正执行并验证返回值
- **模块化版状态检测**：检测子目录版是否已加载
- **allyExempt 真实实现检测**：区分加权实现 vs 内联桩
- **修正断言**：`modelState.getState()` 返回字符串状态名是正常设计，不再误报

---

## v2.0.0（2026-09-22）

### 🔥 核心架构升级：从单层规则 → 多层认知闭环

#### 1. 特征系统升级：48维 → 96维

| 维度段 | 内容 | 状态 |
|---|---|---|
| 0-47 | 基础局面特征（血量/手牌/装备/敌人等） | 保留不动，兼容旧模型 |
| 48-63 | 时序特征 + AI 自我状态（校准偏移 + 元认知熟悉度） | ✅ 新增 |
| 64-79 | 相对强度 + 元认知干预级别 | ✅ 新增 |
| 80-95 | 概率/牌堆/全局校准统计 | ✅ 新增 |

**关键设计**：不新增维度，只填充原来预留的空位，旧模型不用重训也能跑。

---

#### 2. 神经网络升级：单层加权 → 多层感知机

- 网络结构：96 → 64(ReLU) → 6
- Int8 量化 + Base64 存储
- 兼容旧 `getWeights()/getBias()/predict()` 接口
- 新增 `__getW1/__getB1/__getW2/__getB2/__applySnapshot` 接口（供热更新用）

---

#### 3. 元认知系统（6维架构）

| 维度 | 权重 | 说明 |
|---|---|---|
| 元素认知 | 35% | 技能/卡牌熟练度 |
| 模式认知 | 15% | 身份局/国战/斗地主模式熟悉度 |
| 局面类型 | 15% | 开局/中期/残局/优势/劣势 |
| 目标认知 | 10% | 集火目标/保护目标判断 |
| 局势认知 | 15% | 队友/敌人数量与状态 |
| 时间压力 | 10% | 回合剩余时间 |

**输出**：`familiarity`（0~1）+ `modulator`（0.5~1.0）+ `level`（high/mid/low）
**干预级别**：model(w=0.5) / blend(w=0.3) / rule(w=0.1) / skip(w=0)

---

#### 4. 决策校准器（自动校准）

- 每次冲突决策记录 pending，1500ms 后观察真实结果（HP/手牌/分数）
- 判定谁更优，自动微调权重
- 单次调整 ≤ 0.03，累计偏差 ≤ 0.3，学习率衰减 0.95
- 偏移维度：atk / def / wAtkCard / wDefCard / modelTrust

---

#### 5. 多档案协同系统

- 5 个预置档案：均衡型 / 激进型 / 保守型 / 守护型 / 独狼型
- 每 3 局融合一次：胜率 < 0.4 降权 0.5，> 0.6 升权 1.5
- 低胜率档案可模仿高胜率档案（70% 自己 + 30% 最优）
- 有效偏移 = 档案偏移 50% + 全局融合偏移 50%

---

#### 6. 策略总线（冲突仲裁）

- 触发条件：规则和模型都高置信（>0.55）但结论不同
- 仲裁方式：
  - 分差 > 5 → 直接选高分
  - 调用 planner 走 2 步预测
  - 简化版：检查目标是否有闪/桃等反制手段
- 输出：winner(rule/model/planner) + picked(action) + reason

---

#### 7. 模型护栏（红线拦截）

- 8 条红线规则（打队友/过度出牌/自残等）
- 冷却时间 30 分钟（避免反复触发）
- 拦截后自动降级为规则引擎决策

---

#### 8. 元素反馈闭环

- **elementAccess.js**：影子表读写系统，记录每个技能/卡牌的实战表现
- **elementFeedback.js**：500ms 观察 → 自动修正定义
- 跨模式迁移：技能/卡牌走 global 层，身份/阵营走 mode 层
- 自动提升：某元素在 ≥3 个模式都出现 → 提升为全局通用认知

---

#### 9. 认知日志 + 认知冲突检测

- **cognitiveLog.js**：记录每次决策的完整链路（特征→模型→认知→冲突→结果）
- **conflictDetector.js**：检测规则 vs 模型的决策分歧
- 采样权重：元认知熟悉度越低，采样权重越高（重点学习陌生局面）

---

#### 10. 权重持久化（固化进模型）

- 把校准偏移直接写进模型输出层偏置 B2
- atk>0 → B2[D]（进攻标签）增加
- def>0 → B2[C]（保守标签）增加
- modelTrust>0 → 所有 B2 减小（降低模型自信）
- 每局结束消化一次，消化后 shift 归零

---

#### 11. 模型热更新闭环

- 攒够 300 个样本 → 自动触发训练
- 训练结果存为"候选模型"
- 候选跑 20 局 A/B 测试
- 胜率超过旧模型 5% → 自动替换；否则丢弃
- 全程无需重启，运行时热替换权重

---

#### 12. 协同学习（公共知识库）

- 局面指纹：血量段 + 手牌段 + 敌人 HP 段 + 集火状态
- 每个指纹下记录"选择→胜率"
- 高置信（≥3 样本）选择 → 给对应候选加分（群体智慧加成）
- 本地 AI 可选择性采纳

---

#### 13. 策略进化（遗传算法）

- 种群大小：8 个档案
- 每 5 局进化一次
- 精英保留：Top 2 直接进入下一代
- 杂交：Top 40% 两两混合，单点交叉
- 变异：15% 概率随机扰动 ±0.08
- 淘汰：Bottom 20% 移除

---

### 📊 可视化面板系统

| 面板 | 功能 | 入口 |
|---|---|---|
| 🧠 AI 大脑总览 | 校准/认知/冲突/多档案/策略总线/护栏 一屏看完 | `openBrainDashboard()` |
| 📈 校准趋势面板 | 权重偏移柱状图 + 规则胜率曲线 + 冲突次数趋势 | `openCalibratorPanel()` |
| 🎬 决策回放时间轴 | 每次决策的完整链路回放（状态→候选→模型→总线→执行→结果） | `openReplayPanel()` |
| ⚖️ 决策对比模式 | 同一局面下，不同档案的选择对比 + 分歧检测 | `openComparePanel()` |
| 🔥 模型热更新 | 候选模型状态 + A/B 进度 + 晋升历史 | `openHotSwapPanel()` |
| 🤝 公共知识库 | 局面指纹 + 高置信选择 Top 列表 | `openSharedPanel()` |
| 🧬 策略进化 | 种群排行 + 适应度 + 基因组 + 强制进化 | `openEvolutionPanel()` |
| 🔍 模块自检 | 所有模块挂载状态检查 + 历史记录 | `openSelfCheck()` |

---

### 📂 新增文件清单（v2.0 新增 20+ 模块）

```
score/
├── metaCognition.js          # 6维元认知
├── cognitiveLog.js          # 认知日志
├── conflictDetector.js      # 认知冲突检测
├── decisionCalibrator.js    # 决策结果回填+自动校准
├── calibratorPanel.js       # 校准趋势面板
├── multiProfile.js          # 多档案协同
├── strategyBus.js           # 策略总线
├── brainDashboard.js        # AI 大脑总览面板
├── decisionReplay.js        # 决策回放记录
├── replayPanel.js           # 决策回放面板
├── modelGuard.js            # 模型护栏
├── weightPersist.js         # 权重持久化
├── crossModeTransfer.js     # 跨模式迁移
├── decisionCompare.js       # 决策对比
├── comparePanel.js          # 决策对比面板
├── modelHotSwap.js          # 模型热更新
├── sharedKnowledge.js       # 协同学习
├── evolution.js             # 策略进化
├── elementAccess.js         # 影子表读写
├── elementFeedback.js       # 元素反馈闭环
├── confidence.js            # 置信度评估
├── localTrainer.js          # 本地训练器
└── selfCheck.js             # 动态自检
```

---

### 🔧 技术参数速查

| 参数 | 值 |
|---|---|
| 特征维度 | 96 维 |
| 网络结构 | 96 → 64(ReLU) → 6 |
| Int8 范围 | [-127, 127] |
| 分层量化 SCALE | 32 |
| 训练样本阈值 | 200（fast=300，slow=1000） |
| 元认知熟悉度分级 | ≥0.7 high，≥0.4 mid，<0.4 low |
| 干预级别权重 | model=0.5 / blend=0.3 / rule=0.1 / skip=0 |
| 护栏冷却 | 30 分钟 |
| 校准器单次调整 | ≤ 0.03 |
| 校准器累计偏差上限 | ≤ 0.3 |
| 校准器学习率衰减 | 0.95 |
| 多档案融合间隔 | 每 3 局 |
| 多档案胜率降权 | <0.4 降权 0.5 |
| 多档案胜率升权 | >0.6 升权 1.5 |
| 权重持久化学习率 | DIGEST_LR=8 |
| 热更新样本阈值 | 300 |
| 热更新 A/B 局数 | 20 |
| 热更新晋升阈值 | 胜率 +5% |
| 进化种群大小 | 8 |
| 进化精英保留 | Top 2 |
| 进化间隔 | 每 5 局 |
| 变异率 | 15% |
| 变异幅度 | ±0.08 |

---

## v1.x 版本历史（2026-09-19 ~ 2026-09-21）

### v1.1.1
- 24 核心优化模块
- 训练蒸馏闭环
- 决策点自动发现体系
- 模型护栏初版
- 特征升级到 96 维
- 多层网络初版

### v1.1.0
- 元素反馈闭环
- 元认知初版
- 认知日志
- 认知冲突检测
- 决策校准初版

### v1.0.0
- 基础规则打分引擎
- 48 维特征
- 单层加权求和
- 基础面板系统
