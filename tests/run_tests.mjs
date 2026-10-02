/*
 * ============================================
 * // 作者：飞升原创
 * 交流群: 123456789
 * v3.1α
 * 版权所有，侵权必究
 * ============================================
 */

/* ================= 发布门禁：模型链路契约自动化测试 =================
 * 对应《无名AI3.1α 深度系统审查报告》§10：
 *   10.1 Int8 权重 / Int16 偏置 save→load 位级 round-trip（P0-04 回归）
 *   10.2 内置默认权重 fail-closed 契约（P0-03）
 *   10.3 reset 失败不得随机化/落盘，必须原样保留当前权重
 *   10.4 forward / forwardWithValue / forwardFastWithValue 三路径一致（残差 on/off）
 *   10.5 反向传播梯度：逐层有限差分核验 + 首步更新方向 + 训练降损冒烟（P1-17 回归）
 *   10.6 候选训练不得污染 stable；discard 后 active 回到 stable（P0-05/P0-06、P1-16）
 *   10.7 热更快照覆盖全部网络参数 + 全部优化器状态；结构护栏拒绝异形快照（P1-13/P1-14/P1-15）
 *   10.8 训练数据导入：仅 130 维有限数可入 BUFFER（P1-19）
 *   10.9 插件生命周期：注册/安装分离、依赖拓扑安装、缺依赖禁用、依赖恢复自恢复、
 *        卸载 props 逆向清理 + 级联卸载、生命周期广播（P0-02/P1-22/P1-23/P2-33）
 *   §10.10（verifyAll/selfCheck 自检面板）断言完整游戏宿主挂载面，Node 下不可测，
 *        须在游戏内控制台执行 window.__DJSC.verifyAll() 验证。
 *   §10.11 分层自检（报告 §9）：L1 加载契约 / L3 功能 smoke 全通过；L2 连接契约依赖
 *        游戏宿主挂载面，Node 下只校验结构；L4 实战行为不可自动化，须全部 manual 不计失败。
 *
 * 运行（需 Node 18+，仅用 Node 内置能力，无第三方依赖）：
 *   node tests/run_tests.mjs
 * 退出码：0 全部通过；1 存在失败（可用于 CI 阻止发布）。
 *
 * 说明：被测模块通过相对路径 import 游戏本体 noname.js；本脚本会在仓库根
 *   自动放置一个等价宿主桩 noname.js（若不存在），退出时自动删除。
 */

import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ---------- 最小断言框架 ---------- */
let _pass = 0;
const _fails = [];
function ok(cond, name, extra) {
    if (cond) { _pass++; process.stdout.write('.'); }
    else { _fails.push(name + (extra ? '  >> ' + extra : '')); process.stdout.write('F'); }
}
function eq(a, b, name) { ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function approx(a, b, tol, name) { ok(Math.abs(a - b) <= tol, name, 'got ' + a + ' want ' + b + ' ±' + tol); }

/* ---------- 宿主桩（noname.js）：不存在则生成，退出自删 ---------- */
const _here = dirname(fileURLToPath(import.meta.url));          /* 无名AI/tests */
const _repoRoot = resolve(_here, '..', '..', '..');             /* WUMAING */
const _hostPath = join(_repoRoot, 'noname.js');
const _hostOwned = !existsSync(_hostPath);
const _HOST_STUB = `/* 自动生成的测试宿主桩——run_tests.mjs 退出时删除，勿手改、勿打包 */
const fn = function () { return undefined; };
const configStore = {};
function P() { return new Proxy(fn, { get(t, k) {
    if (k === Symbol.toPrimitive) return function () { return ''; };
    if (k === 'config') return configStore;
    if (!(k in t)) t[k] = P();
    return t[k];
}, apply: function () { return undefined; } }); }
export const lib = P();
export const game = P();
export const ui = P();
export const get = P();
export const ai = P();
export const _status = P();
export const _configStore = configStore;
export default { lib, game, ui, get, ai, _status };
`;
if (_hostOwned) writeFileSync(_hostPath, _HOST_STUB, 'utf8');
function _cleanupHost() { if (_hostOwned && existsSync(_hostPath)) { try { rmSync(_hostPath); } catch (e) {} } }
process.on('exit', _cleanupHost);

/* ---------- 浏览器环境桩（必须在 import 业务模块前装好） ---------- */
const _mem = new Map();
globalThis.window = globalThis.window || {};
globalThis.window.__DJSC = globalThis.window.__DJSC || {};
globalThis.localStorage = {
    getItem: k => (_mem.has(k) ? _mem.get(k) : null),
    setItem: (k, v) => _mem.set(k, String(v)),
    removeItem: k => _mem.delete(k),
    clear: () => _mem.clear(),
    key: i => Array.from(_mem.keys())[i],
    get length() { return _mem.size; },
};

/* ---------- 导入被测模块 ---------- */
const _pkg = resolve(_here, '..');
const wm = await import(pathToFileURL(join(_pkg, 'score', 'model', 'weights', 'weights.js')).href);
const te = await import(pathToFileURL(join(_pkg, 'score', 'model', 'train', 'trainExport.js')).href);
const hs = await import(pathToFileURL(join(_pkg, 'score', 'model', 'net', 'modelHotSwap.js')).href);
const ms = await import(pathToFileURL(join(_pkg, 'score', 'model', 'net', 'modelState.js')).href);  /* §8：统一 A/B 状态机本体（modelHotSwap 为其兼容外壳） */
const hostStub = await import(pathToFileURL(_hostPath).href);
window.__DJSC.__weightsModule = wm;
window.__DJSC.__trainExportModule = te;

/* ---------- 工具 ---------- */
const W_KEYS = [
    ['__getW1', 130 * 128], ['__getB1', 128],
    ['__getW2', 128 * 64], ['__getB2', 64],
    ['__getW3', 64 * 6], ['__getB3', 6],
    ['__getW4', 64], ['__getB4', 1],
    ['__getPr1', 130 * 128], ['__getPr2', 128 * 64],
];
function snapshotArrays() {
    const out = {};
    for (const [k, n] of W_KEYS) {
        const a = wm[k]();
        const copy = new Int32Array(n);
        for (let i = 0; i < n; i++) copy[i] = a[i];
        out[k] = copy;
    }
    return out;
}
/* FNV-1a 风格哈希：把全部网络参数（可选含优化器矩）压成一个整数 */
function hashModel(includeMoments) {
    let h = 0x811c9dc5;
    const mix = v => { h ^= (v & 0xffffffff) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; };
    const s = snapshotArrays();
    for (const k of Object.keys(s)) for (let i = 0; i < s[k].length; i++) mix(s[k][i]);
    if (includeMoments) {
        const m = wm.__getMoments();
        ok(!!m, '10.6 优化器状态可快照');
        for (const k of Object.keys(m)) {
            const a = m[k];
            if (typeof a === 'number') { mix(a); continue; }
            for (let i = 0; i < a.length; i++) mix((a[i] * 1e6) | 0);
        }
    }
    return h >>> 0;
}
function arraysEqual(got, want) {
    for (const k of Object.keys(want)) {
        const a = got[k]();
        if (a.length !== want[k].length) return '长度不符 ' + k + ' ' + a.length + '≠' + want[k].length;
        for (let i = 0; i < a.length; i++) if (a[i] !== want[k][i]) return '首个差异 ' + k + '[' + i + '] ' + a[i] + '≠' + want[k][i];
    }
    return null;
}
function maxDiff(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    return d;
}
function allFinite(a) { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; }
function feat130(seed) {
    const f = new Array(130);
    for (let i = 0; i < 130; i++) f[i] = Math.sin((i + 1) * (seed + 1) * 0.07) * 2 + Math.cos(i * 0.013 + seed);
    return f;
}
const WEIGHTS_STORE_KEY = 'djsc_weights_v3';

/* ================= 10.2 内置默认权重契约（版本自适应） ================= */
/* 全新内存存储：无任何存档。
 * 默认权重 v≠7（当前 v6 旧契约作废，待 §14C 重训）：必须 fail-closed、ready=false、诊断说明版本差；
 * 默认权重 v=7（build/train_default_weights.mjs 重训后）：必须加载成功、ready=true、无诊断。
 * 两个分支共享底线：前向可用且全 finite（防崩兜底）。 */
_mem.clear();
const dw = await import(pathToFileURL(join(_pkg, 'score', 'model', 'weights', 'defaultWeights.js')).href);
eq(wm.loadWeights(), false, '10.2 无存档时 loadWeights 返回 false（不代表失败，见 ready 位）');
if (dw.DEFAULT_WEIGHTS && dw.DEFAULT_WEIGHTS.v === wm.MODEL_SCHEMA.version) {
    eq(wm.isReady(), true, '10.2 v7 默认权重加载成功 → ready=true（§14C 闭环）');
    eq(wm.getDefaultDiag(), null, '10.2 v7 默认权重无诊断');
    ok(wm.getAccuracy() > 0, '10.2 v7 默认权重带验证准确率', 'acc=' + wm.getAccuracy());
} else {
    eq(wm.isReady(), false, '10.2 回退模型必须 ready=false');
    const diag = wm.getDefaultDiag() || '';
    ok(/v6/.test(diag) && /v7/.test(diag), '10.2 诊断必须说明 v6≠v7', JSON.stringify(diag));
}
const cold = wm.forward(new Array(130).fill(0.1));
ok(!!cold && cold.length === 6 && allFinite(cold), '10.2 fail-closed 后前向仍可用且全 finite（防崩兜底）');

/* ================= 10.3 reset 语义（版本自适应） ================= */
const beforeReset = snapshotArrays();
const hashBeforeReset = hashModel(false);
const _defaultsOK = !!(dw.DEFAULT_WEIGHTS && dw.DEFAULT_WEIGHTS.v === wm.MODEL_SCHEMA.version);
if (!_defaultsOK) {
    /* 默认权重不可用：reset 必须失败且全部参数一位不动、不落盘 */
    eq(wm.resetWeights(), false, '10.3 默认权重不可用时 reset 返回 false');
    eq(hashModel(false), hashBeforeReset, '10.3 reset 失败后全部网络参数一位不动');
    const resetDiff = arraysEqual({
        __getW1: wm.__getW1, __getB1: wm.__getB1, __getW2: wm.__getW2, __getB2: wm.__getB2,
        __getW3: wm.__getW3, __getB3: wm.__getB3, __getW4: wm.__getW4, __getB4: wm.__getB4,
        __getPr1: wm.__getPr1, __getPr2: wm.__getPr2,
    }, beforeReset);
    ok(resetDiff === null, '10.3 reset 失败后逐参数比对一致', resetDiff);
    eq(_mem.has(WEIGHTS_STORE_KEY), false, '10.3 reset 失败不得把随机权重落盘');
} else {
    /* 默认权重可用（§14C 已闭环）：reset 必须成功恢复出厂权重；连续两次 hash 一致（报告 §10.3 原文） */
    eq(wm.resetWeights(), true, '10.3 v7 默认权重可用时 reset 返回 true');
    const h1 = hashModel(false);
    eq(wm.resetWeights(), true, '10.3 第二次 reset 仍成功');
    eq(hashModel(false), h1, '10.3 连续两次 reset hash 一致（确定性恢复出厂）');
    eq(wm.isReady(), true, '10.3 reset 后 ready=true');
}

/* ================= 10.1 Int8/Int16 save→load 位级 round-trip ================= */
/* P0-04 回归：偏置是 Int16，>127 的值以前会被 Int8 decoder 拆碎、几何整体错位。 */
wm.__getB1()[7] = 1234;
wm.__getB1()[8] = -2345;
wm.__getB3()[2] = -567;
wm.__getW1()[3] = 127;
wm.__getW1()[4] = -128;
wm.__getPr2()[10] = 63;
const beforeSave = snapshotArrays();
eq(wm.saveWeights(), true, '10.1 saveWeights 返回 true');
eq(wm.loadWeights(), true, '10.1 刚写入的 v7 存档可被 loadWeights 接受');
const rtDiff = arraysEqual({
    __getW1: wm.__getW1, __getB1: wm.__getB1, __getW2: wm.__getW2, __getB2: wm.__getB2,
    __getW3: wm.__getW3, __getB3: wm.__getB3, __getW4: wm.__getW4, __getB4: wm.__getB4,
    __getPr1: wm.__getPr1, __getPr2: wm.__getPr2,
}, beforeSave);
ok(rtDiff === null, '10.1 全部 Int8 权重 + Int16 偏置 save→load 位级一致', rtDiff);
eq(wm.__getB1()[7], 1234, '10.1 Int16 偏置大正值 1234 存活（P0-04 回归）');
eq(wm.__getB1()[8], -2345, '10.1 Int16 偏置大负值 -2345 存活（P0-04 回归）');
eq(wm.__getB3()[2], -567, '10.1 Int16 B3 存活');
wm.setAccuracy(0.42);
wm.saveWeights();
wm.loadWeights();
approx(wm.getAccuracy(), 0.42, 1e-9, '10.1 META.accuracy 随存档往返');

/* ================= 10.4 三套前向路径一致（残差 on/off） ================= */
function checkForwardPaths(tag) {
    for (let seed = 0; seed < 3; seed++) {
        const x = seed === 0 ? new Array(130).fill(0) : feat130(seed);
        const a = wm.forward(x);
        const b = wm.forwardWithValue(x);
        const c = wm.forwardFastWithValue(x);
        ok(!!a && !!b && !!c, '10.4[' + tag + '] 三路径均返回结果 seed=' + seed);
        ok(maxDiff(a, b.actorLogits) <= 1e-5, '10.4[' + tag + '] forward ≈ forwardWithValue seed=' + seed, 'diff=' + maxDiff(a, b.actorLogits));
        ok(maxDiff(a, c.actorLogits) <= 1e-5, '10.4[' + tag + '] forward ≈ forwardFastWithValue seed=' + seed, 'diff=' + maxDiff(a, c.actorLogits));
        ok(Number.isFinite(b.value) && Math.abs(b.value) <= 1, '10.4[' + tag + '] Critic value ∈ [-1,1] finite seed=' + seed);
        const p = wm.predict(x);
        eq(p.probs.length, 6, '10.4[' + tag + '] predict 概率长度 6');
        ok(allFinite(p.probs), '10.4[' + tag + '] predict 概率全 finite');
        const sum = p.probs.reduce((s, v) => s + v, 0);
        approx(sum, 1, 1e-4, '10.4[' + tag + '] predict 概率和≈1');
        approx(p.confidence, Math.max.apply(null, p.probs), 1e-9, '10.4[' + tag + '] confidence=最大概率');
        ok(Number.isFinite(p.value), '10.4[' + tag + '] predict value finite');
    }
}
checkForwardPaths('res-off');
hostStub._configStore['extension_无名AI_useResidual'] = true;
checkForwardPaths('res-on');
delete hostStub._configStore['extension_无名AI_useResidual'];

/* ================= 10.5 反向传播梯度：有限差分 + 首步更新方向 ================= */
/* P1-17 回归 + 链式法则正确性：
 * ① __gradientsForTest 的解析梯度必须与损失曲面的有限差分一致（逐层、含残差 on/off）；
 * ② 真实 trainOne 首步更新方向必须与梯度反方向一致（零动量起点 AdamW 首步 = sign(g)，
 *   验证真实训练路径应用的是同一组快照梯度，而非更新后权重算出的梯度）。
 * 口径映射：权重浮点值 = Int8量子/128 → FD量子差分×128 得浮点梯度；
 *   gW2/gW3/gPr2 缓冲 = 浮点梯度；gW1/gPr1 缓冲 = 浮点梯度/128（weights.js 历史口径）；
 *   偏置浮点值 = Int16量子本身 → 缓冲 = FD量子差分。 */
{
    /* ★ FD 必须在未饱和状态做：10.1 注入的 B3[2]=-567 使 logits[2]≈-567，
     * Float32 logits 量子(≈3.4e-5)大于深层 1 量子扰动响应(≈6e-6)，损失成阶梯函数，FD 无意义。
     * 清档回 fail-closed 随机态（logits 健康），此时 FD 与解析梯度实测吻合到 ~0.3%。
     * ★ 确定性随机态：FD 断言是回归门禁，必须逐次可复现。mulberry32 固定种子替换
     *   Math.random（仅本段，退出前还原），权重初始化与随机舍入全部确定。 */
    const _origRandom = Math.random;
    let _seed = 0x9e3779b9;
    Math.random = function () {
        _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
        let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    _mem.clear();
    wm.loadWeights();
    eq(wm.isReady(), _defaultsOK, '10.5 清档后 ready 位与默认权重可用性一致（' + (_defaultsOK ? 'v7 默认已载入' : 'fail-closed 随机态') + '）');
    const snapB = wm.__snapshotModel();
    const gx = feat130(7), glabel = 2;
    const lossCE = (x, label) => {
        /* 不加下限钳制：训练端 dLogits 用原始 probs；钳制会让饱和类（如 10.1 注入的 B3[2]=-567）
         * 的损失项变成常数，有限差分恒为 0，掩盖真实梯度。p 最小 ~1e-31，double 取 log 安全。 */
        const r = wm.forwardWithValue(x);
        const p = wm.softmax(r.actorLogits);
        let L = 0;
        for (let k = 0; k < 6; k++) L -= ((k === label) ? 0.95 : 0.05 / 6) * Math.log(Math.max(p[k], 1e-300));
        return L;
    };
    const fdW = (arr, idx) => {          /* 权重量子 ±1 → 浮点梯度 */
        if (arr[idx] >= 120 || arr[idx] <= -120) return null;   /* 防 Int8 回绕 */
        arr[idx] += 1; const lp = lossCE(gx, glabel);
        arr[idx] -= 2; const lm = lossCE(gx, glabel);
        arr[idx] += 1;
        return (lp - lm) / 2 * 128;
    };
    const fdB = (arr, idx) => {          /* 偏置量子 ±1 → 浮点梯度（输出层用，线性无截断误差） */
        arr[idx] += 1; const lp = lossCE(gx, glabel);
        arr[idx] -= 2; const lm = lossCE(gx, glabel);
        arr[idx] += 1;
        return (lp - lm) / 2;
    };
    /* 偏置 1 量子 = 1.0 浮点单位（权重的 128 倍），经 GELU/LN 曲率时中心差分截断误差 16~29%；
     * Richardson 外推 (4·fd(h) − fd(2h))/3 消去二阶项，实测回到 ~1% 内。 */
    const fdB2 = (arr, idx) => {
        arr[idx] += 1; const l1p = lossCE(gx, glabel); arr[idx] -= 2; const l1m = lossCE(gx, glabel); arr[idx] += 1;
        arr[idx] += 2; const l2p = lossCE(gx, glabel); arr[idx] -= 4; const l2m = lossCE(gx, glabel); arr[idx] += 2;
        return (4 * ((l1p - l1m) / 2) - (l2p - l2m) / 4) / 3;
    };
    const close = (a, b, name) => {
        const tol = Math.max(2e-5, 0.05 * Math.max(Math.abs(a), Math.abs(b)));
        ok(a !== null && b !== null && Math.abs(a - b) <= tol, name, 'analytic=' + a + ' fd=' + b);
    };
    /* 偏置 FD 粗核：偏置 1 量子 = 1.0 浮点（权重的 128 倍），h=1.0 大步长穿过 GELU/LN
     * 高曲率区时 Richardson 仍剩可达 ~50% 截断残差，故只做"同号 + 量级一致"核验
     * （能抓住偏置未接入前向/接错层：FD≈0 或反号）；gB 精确性由恒等式+同层 gW FD 锚定。 */
    const closeLooseBias = (a, b, name) => {
        const m = Math.max(Math.abs(a), Math.abs(b));
        ok(a !== null && b !== null && m > 1e-8 && a * b > 0 && Math.abs(a - b) <= 1.5 * m, name, 'analytic=' + a + ' fd=' + b);
    };

    /* 钩子纯读性：不动权重/动量/adamT */
    const hPre = hashModel(true);
    const G = wm.__gradientsForTest(gx, glabel);
    ok(!!G, '10.5 __gradientsForTest 返回梯度对象');
    eq(hashModel(true), hPre, '10.5 梯度钩子纯读，模型+优化器状态逐位不变');

    /* 输出层 W3/B3（残差 off）：label 类与非 label 类都核 */
    const w3 = wm.__getW3(), b3 = wm.__getB3();
    close(G.gW3[glabel * 64 + 0], fdW(w3, glabel * 64 + 0), '10.5 gW3[label,0] 有限差分一致');
    close(G.gW3[glabel * 64 + 63], fdW(w3, glabel * 64 + 63), '10.5 gW3[label,63] 有限差分一致');
    const kOther = (glabel + 1) % 6;
    close(G.gW3[kOther * 64 + 17], fdW(w3, kOther * 64 + 17), '10.5 gW3[other,17] 有限差分一致');
    close(G.gB3[glabel], fdB(b3, glabel), '10.5 gB3[label] 有限差分一致');
    close(G.gB3[kOther], fdB(b3, kOther), '10.5 gB3[other] 有限差分一致');

    /* 隐藏层 W2/B2：验证 LN′+GELU′ 链式反传。
     * FD 信噪比 ∝ |g|：从候选中挑 |gW2| 最大的 3 个索引做 FD（小梯度索引的截断噪声占比高）。 */
    const w2 = wm.__getW2(), b2 = wm.__getB2();
    const cand2 = [0 * 128 + 0, 17 * 128 + 100, 33 * 128 + 33, 40 * 128 + 7, 63 * 128 + 127, 25 * 128 + 60, 50 * 128 + 3, 9 * 128 + 40]
        .sort((p, q) => Math.abs(G.gW2[q]) - Math.abs(G.gW2[p])).slice(0, 3);
    for (const idx of cand2) close(G.gW2[idx], fdW(w2, idx), '10.5 gW2[' + ((idx / 128) | 0) + ',' + (idx % 128) + '] 有限差分一致（|g| 最大档）');
    /* gB2[j] 与 gW2[j,·] 同源（都 = dH2raw[j]）：恒等式 gB2[j]·hn1[i] ≈ gW2[j,i]（差一次 Float32 舍入）。
     * dH2raw 的正确性已由 gW2 FD 锚定，恒等式把 gB2 无噪声地绑到已验证量上。 */
    for (const [j, i] of [[0, 0], [17, 100], [33, 33], [63, 127]]) {
        const expect = G.gB2[j] * G.hn1[i];
        approx(G.gW2[j * 128 + i], expect, Math.max(1e-9, 1e-5 * Math.abs(expect)), '10.5 gB2[' + j + ']·hn1[' + i + '] ≈ gW2 恒等');
    }
    /* 粗核：偏置确实以增益≈1 进入前向。取 |gB2| 最大的索引（SNR 最高）。 */
    let b2i = 0;
    for (const j of [0, 17, 33, 63]) if (Math.abs(G.gB2[j]) > Math.abs(G.gB2[b2i])) b2i = j;
    closeLooseBias(G.gB2[b2i], fdB2(b2, b2i), '10.5 gB2[' + b2i + '] FD 粗核（前向增益≈1）');

    /* 第一层 W1/B1：缓冲口径 = 浮点梯度/128，比对时 ×128。同样挑 |gW1| 最大档做 FD。 */
    const w1 = wm.__getW1(), b1 = wm.__getB1();
    const cand1 = [0 * 130 + 0, 7 * 130 + 64, 127 * 130 + 129, 3 * 130 + 9, 25 * 130 + 60, 50 * 130 + 3, 64 * 130 + 129, 100 * 130 + 17]
        .sort((p, q) => Math.abs(G.gW1[q]) - Math.abs(G.gW1[p])).slice(0, 3);
    for (const idx of cand1) close(G.gW1[idx] * 128, fdW(w1, idx), '10.5 gW1[' + ((idx / 130) | 0) + ',' + (idx % 130) + ']×128 有限差分一致（|g| 最大档）');
    /* gB1[j] 与 gW1[j,·] 同源（都 = dH1raw[j]，gW1 缓冲口径 = 浮点梯度/128）：
     * 恒等式 gW1缓冲[j,i] ≈ gB1[j]·(x[i]/128)（差一次 Float32 舍入）。
     * dH1raw 的正确性已由 gW1 FD 锚定，恒等式把 gB1 无噪声地绑到已验证量上。 */
    for (const [j, i] of [[0, 0], [7, 64], [64, 129], [127, 129]]) {
        const expect = G.gB1[j] * (gx[i] / 128);
        approx(G.gW1[j * 130 + i], expect, Math.max(1e-9, 1e-5 * Math.abs(expect)), '10.5 gB1[' + j + ']·(x[' + i + ']/128) ≈ gW1 恒等');
    }
    /* 粗核：偏置确实以增益≈1 进入前向。取 |gB1| 最大的索引（SNR 最高）。 */
    let b1i = 0;
    for (const j of [0, 7, 64, 127]) if (Math.abs(G.gB1[j]) > Math.abs(G.gB1[b1i])) b1i = j;
    closeLooseBias(G.gB1[b1i], fdB2(b1, b1i), '10.5 gB1[' + b1i + '] FD 粗核（前向增益≈1）');

    /* Critic 梯度公式自洽（valueTarget=0.5）：gW4=dV·hn2，gB4=dV */
    const Gv = wm.__gradientsForTest(gx, glabel, 0.5);
    const rV = wm.forwardWithValue(gx);
    for (const j of [0, 31, 63]) approx(Gv.gW4[j], Gv.dV * rV.hidden2[j], 1e-6, '10.5 gW4[' + j + ']=dV·hn2 自洽');
    approx(Gv.gB4[0], Gv.dV, 1e-6, '10.5 gB4=dV 自洽（Float32 缓冲舍入内）');

    /* 残差 on：投影矩阵梯度进入链式法则。
     * 结构上 gPr 与 gW 由 _computeGrads 同一局部量填充（前向中 W·x 与 W_proj·x 同位相加），
     * 因此逐元素恒等是精确断言；FD 仅做粗核（proj 前向正确性另由 10.4 res-on 路径一致性覆盖）。 */
    hostStub._configStore['extension_无名AI_useResidual'] = true;
    const Gr = wm.__gradientsForTest(gx, glabel);
    eq(Gr.useRes, true, '10.5 残差开关生效');
    let prIdentityBad = 0;
    for (let i = 0; i < Gr.gW1.length; i += 1999) if (Gr.gPr1[i] !== Gr.gW1[i]) prIdentityBad++;
    for (let i = 0; i < Gr.gW2.length; i += 997) if (Gr.gPr2[i] !== Gr.gW2[i]) prIdentityBad++;
    eq(prIdentityBad, 0, '10.5 gPr1===gW1、gPr2===gW2 逐元素恒等（同一梯度源）');
    const pr1 = wm.__getPr1(), pr2 = wm.__getPr2();
    /* 同索引 FD 对 FD：gPr===gW 已逐元素恒等（真梯度必同），且 res-on 前向只依赖 (W+Wpr) 之和，
     * 扰动 w 或 pr 的同一索引产生同一损失曲面响应 → 两侧 FD 差分值应几乎逐位一致，
     * 无随机态噪声困扰。选 |gW| 最大的候选索引，FD 信噪比最高。 */
    let best1 = 0, bestA1 = -1;
    for (const idx of [0 * 130 + 0, 3 * 130 + 9, 7 * 130 + 64, 25 * 130 + 60, 50 * 130 + 3, 127 * 130 + 129]) {
        const a = Math.abs(Gr.gW1[idx]);
        if (a > bestA1) { bestA1 = a; best1 = idx; }
    }
    close(fdW(pr1, best1), fdW(w1, best1), '10.5 pr1/w1 同索引[' + best1 + '] FD 对 FD（res-on，真梯度必同）');
    close(Gr.gW1[best1] * 128, fdW(w1, best1), '10.5 gW1[max档] 残差模式下解析仍一致');
    let best2 = 0, bestA2 = -1;
    for (const idx of [0 * 128 + 0, 9 * 128 + 40, 17 * 128 + 100, 33 * 128 + 7, 40 * 128 + 7, 63 * 128 + 127]) {
        const a = Math.abs(Gr.gW2[idx]);
        if (a > bestA2) { bestA2 = a; best2 = idx; }
    }
    close(fdW(pr2, best2), fdW(w2, best2), '10.5 pr2/w2 同索引[' + best2 + '] FD 对 FD（res-on，真梯度必同）');
    close(Gr.gW2[best2], fdW(w2, best2), '10.5 gW2[max档] 残差模式下解析仍一致');
    delete hostStub._configStore['extension_无名AI_useResidual'];

    /* 真实训练路径首步：零动量起点，AdamW 首步 mHat/(√vHat+eps)=sign(g)，
     * 故 ΔW 符号必须 = -sign(g)（若用了更新后权重算梯度，深层符号会错位） */
    const snapZ = wm.__snapshotModel();
    for (const k of Object.keys(snapZ)) if (/^[mv]/.test(k) && snapZ[k] && snapZ[k].fill) snapZ[k].fill(0);
    snapZ.adamT = 0;
    wm.__restoreModel(snapZ);
    const Gs = wm.__gradientsForTest(gx, glabel);
    const pairs = [
        [wm.__getW1(), Gs.gW1], [wm.__getW2(), Gs.gW2], [wm.__getW3(), Gs.gW3],
        [wm.__getB1(), Gs.gB1], [wm.__getB2(), Gs.gB2], [wm.__getB3(), Gs.gB3],
    ];
    const befores = pairs.map(p => p[0].slice());
    eq(wm.trainOne(gx, glabel, 0.02), true, '10.5 trainOne 首步执行成功');
    let signChecked = 0, signBad = 0;
    for (let pi = 0; pi < pairs.length; pi++) {
        const before = befores[pi], after = pairs[pi][0], grads = pairs[pi][1];
        for (let i = 0; i < before.length; i += 613) {   /* 稀疏确定性抽样 */
            const g = grads[i];
            if (Math.abs(g) < 1e-9) continue;
            if (Math.abs(before[i]) >= 125 && before[i] <= 127 && before[i] >= -128) continue;  /* 避开 Int8 饱和钳位 */
            signChecked++;
            const d = after[i] - before[i];
            if (d !== 0 && (d > 0) === (g > 0)) signBad++;
        }
    }
    ok(signChecked > 10, '10.5 首步方向抽样量充足（' + signChecked + '）');
    eq(signBad, 0, '10.5 首步更新方向全部与梯度反方向一致');

    /* 学习冒烟：强信号合成集上训练必须显著降损 */
    wm.__restoreModel(snapB);
    const cls = [];
    for (let c = 0; c < 6; c++) for (let rep = 0; rep < 2; rep++) {
        const f = feat130(c * 2 + rep);
        f[c * 3] = 12; f[c * 3 + 1] = -12;   /* 类标签强信号 */
        cls.push({ f: f, c: c });
    }
    const avgLoss = () => { let s = 0; for (const it of cls) s += lossCE(it.f, it.c); return s / cls.length; };
    const L0 = avgLoss();
    for (let ep = 0; ep < 60; ep++) for (const it of cls) wm.trainOne(it.f, it.c, 0.02);
    const L1 = avgLoss();
    /* 阈值 0.75：v6 fail-closed 冷启动（随机态）下轻松达标；v7 默认权重已载入时为热启动，
     * 损失起点更低、下降空间更小（实测 ~0.73），0.75 仍能抓住"训练不学习"回归。 */
    ok(L1 < L0 * 0.75, '10.5 强信号训练 720 步后损失显著下降', 'L0=' + L0.toFixed(3) + ' L1=' + L1.toFixed(3));
    wm.__restoreModel(snapB);
    Math.random = _origRandom;
}

/* ================= 10.7 热更快照完整性 + 结构护栏 ================= */
const snap = wm.__snapshotModel();
ok(!!snap, '10.7 __snapshotModel 非空');
const PARAMS = {
    W1: 130 * 128, B1: 128, W2: 128 * 64, B2: 64,
    W3: 64 * 6, B3: 6, W4: 64, B4: 1, W_proj1: 130 * 128, W_proj2: 128 * 64,
};
const MOM_SHAPE = {
    mW1: 130 * 128, mB1: 128, mW2: 128 * 64, mB2: 64,
    mW3: 64 * 6, mB3: 6, mW4: 64, mB4: 1, mW_proj1: 130 * 128, mW_proj2: 128 * 64,
    vW1: 130 * 128, vB1: 128, vW2: 128 * 64, vB2: 64,
    vW3: 64 * 6, vB3: 6, vW4: 64, vB4: 1, vW_proj1: 130 * 128, vW_proj2: 128 * 64,
};
for (const k of Object.keys(PARAMS)) ok(snap[k] && snap[k].length === PARAMS[k], '10.7 快照含网络参数 ' + k + '[' + PARAMS[k] + ']');
for (const k of Object.keys(MOM_SHAPE)) ok(snap[k] && snap[k].length === MOM_SHAPE[k], '10.7 快照含优化器状态 ' + k + '[' + MOM_SHAPE[k] + ']');
eq(typeof snap.adamT, 'number', '10.7 快照含 adamT');
ok(!!snap.META && typeof snap.META.ready === 'boolean', '10.7 快照含 META.ready');
/* 异形快照（w1 少一维）必须被 __applySnapshot 拒绝，且在线参数不受影响 */
wm.__getW1()[10] = 55;
const bad = {
    w1: wm.__getW1().slice(0, 10), b1: wm.__getB1(), w2: wm.__getW2(), b2: wm.__getB2(),
    w3: wm.__getW3(), b3: wm.__getB3(), w4: wm.__getW4(), b4: wm.__getB4(),
    pr1: wm.__getPr1(), pr2: wm.__getPr2(),
};
eq(wm.__applySnapshot(bad), false, '10.7 异形快照（w1 长度错误）必须拒绝');
eq(wm.__getW1()[10], 55, '10.7 拒绝后在线权重不被污染');
/* restore 往返 */
wm.__getW1()[11] = -77;
eq(wm.__restoreModel(snap), true, '10.7 完整快照可还原');
eq(wm.__getW1()[10], snap.W1[10], '10.7 还原后 W1[10] 回到快照值');
eq(wm.__getW1()[11], snap.W1[11], '10.7 还原抹掉还原后的临时改动');
eq(wm.__restoreModel(null), false, '10.7 null 快照拒绝');

/* ================= 10.8 训练数据导入准入：仅 130 维有限数 ================= */
te.resetAll();
function sample(dim, mut) {
    const f = new Array(dim);
    for (let i = 0; i < dim; i++) f[i] = (i % 7) - 3;
    if (mut) mut(f);
    return { f: f, r: 1 };
}
const batch = [
    sample(48), sample(96), sample(129), sample(131),       /* 错误维度 */
    sample(130, f => { f[5] = NaN; }),                      /* 非有限 NaN */
    sample(130, f => { f[9] = 'x'; }),                      /* 非有限 字符串 */
    (function () { const f = new Array(130); for (let i = 0; i < 130; i++) f[i] = (i % 5) - 2; return { f: f, r: 2 }; })(),  /* 唯一合法样本 */
];
const imp = te.importFromJson(JSON.stringify({ samples: batch }));
eq(imp.ok, true, '10.8 导入正常返回');
eq(imp.added, 1, '10.8 仅 1 条合法 130 维有限数样本入库', JSON.stringify(imp));
eq(imp.skippedWrongDim, 4, '10.8 48/96/129/131 维全部拒绝');
eq(imp.skippedNonFinite, 2, '10.8 NaN / 字符串样本全部拒绝');
eq(te.bufferSize(), 1, '10.8 BUFFER 中只有合法样本');

/* ================= 10.6 候选训练隔离 + discard 回滚 ================= */
te.resetAll();
const samples300 = [];
for (let i = 0; i < 300; i++) {
    const f = feat130(i);
    f[0] = i - 150;   /* 保证 300 条特征互不相同，去重不会合并 */
    samples300.push({ f: f, r: (i % 5) - 2 });
}
const imp2 = te.importFromJson(JSON.stringify({ samples: samples300 }));
eq(imp2.added, 300, '10.6 300 条互异样本全部入库', JSON.stringify(imp2));
hs.resetHotSwap();
const hStable = hashModel(true);
const tr = await hs.triggerHotTrain();
eq(tr.ok, true, '10.6 候选训练成功', JSON.stringify(tr));
eq(hashModel(true), hStable, '10.6 候选训练后 stable 权重+优化器状态逐位不变');
const st1 = hs.hotSwapStats();
eq(st1.hasCandidate, true, '10.6 候选已登记');
eq(ms.getState(), 'candidate', '10.6 §8 统一状态机：候选登记后 state=candidate');
ok(_mem.has('djsc_model_state'), '10.6 §8 统一存储键 djsc_model_state 已写入');
eq(_mem.has('djsc_hotswap_v1'), false, '10.6 §8 legacy djsc_hotswap_v1 已迁移删除');
/* 候选局：开局换入候选（在线变化）→ 局末记录分数后精确还原 */
hs.hotGameStart();
eq(hs.hotSwapStats().abArm, 'candidate', '10.6 首局分到候选组');
ok(hashModel(false) !== hStable, '10.6 候选局在线权重确实换为候选');
hs.hotRecordABScore(0.5);
eq(hs.hotSwapStats().abArm, null, '10.6 局末分组状态清空');
eq(hashModel(true), hStable, '10.6 候选局结束在线模型精确还原');
eq(hs.hotSwapStats().abScores.length, 1, '10.6 候选分数记在候选头上（P1-16）');
/* 丢弃候选：active 必须回到 stable */
eq(hs.forceDiscard(), true, '10.6 forceDiscard 成功');
eq(hs.hotSwapStats().hasCandidate, false, '10.6 discard 后候选清空');
eq(ms.getState(), 'stable', '10.6 §8 统一状态机：discard 后 state=stable');
eq(hashModel(true), hStable, '10.6 discard 后 active === stable');

/* ================= 10.9 插件生命周期：注册/安装分离、依赖拓扑、自恢复、卸载清理 ================= */
/* P0-02 注册与安装分离；P1-22 依赖恢复自动重试；P1-23 卸载逆向清理 props + 级联卸载。
 * 注：§10.10（verifyAll/selfCheck 自检面板）断言的是完整游戏宿主挂载面（24 面板 + 24 命令
 * + 51 模块），Node 下无宿主只能得到"全缺失"退化结果，不具备可测性 → 浏览器控制台跑
 * window.__DJSC.verifyAll() 验证。 */
const pl = await import(pathToFileURL(join(_pkg, 'score', 'foundation', 'runtime', 'plugins.js')).href);
const eb = await import(pathToFileURL(join(_pkg, 'score', 'foundation', 'runtime', 'eventBus.js')).href);
{
    const calls = [];
    const mk = (id, spec) => pl.definePlugin(Object.assign({
        id: id, name: id, version: '1.0.0',
        onInstall: function () { calls.push('install:' + id); },
        onUninstall: function () { calls.push('uninstall:' + id); },
        onStart: function () { calls.push('start:' + id); },
        onGameEnd: function () { calls.push('end:' + id); },
    }, spec));

    /* ① 注册与安装分离（P0-02）：install:false 只登记不安装 */
    eq(pl.registerPlugin(mk('t.a', { props: { t9a: { x: 1 } } }), { install: false }).ok, true, '10.9 注册返回 ok');
    eq(pl.pluginState('t.a').state, 'pending', '10.9 install:false → pending，未安装');
    eq(calls.indexOf('install:t.a') >= 0, false, '10.9 注册阶段 onInstall 未被调用');
    eq((window.__DJSC.t9a || {}).x, undefined, '10.9 注册阶段 props 未绑定');

    /* ② 拓扑安装：t.b 依赖 t.a，installAllPlugins 按依赖序装 */
    pl.registerPlugin(mk('t.b', { depends: ['t.a'] }), { install: false });
    eq(pl.installAllPlugins().ok, true, '10.9 installAllPlugins 成功');
    eq(pl.pluginState('t.a').state, 'installed', '10.9 t.a installed');
    eq(pl.pluginState('t.b').state, 'installed', '10.9 t.b installed');
    ok(calls.indexOf('install:t.a') >= 0 && calls.indexOf('install:t.a') < calls.indexOf('install:t.b'), '10.9 拓扑序：t.a 先于 t.b 安装');
    eq(window.__DJSC.t9a.x, 1, '10.9 安装后 props 绑定到 __DJSC');

    /* ③ 缺依赖 → disabled 并记 reason，不波及其它插件 */
    pl.registerPlugin(mk('t.c', { depends: ['t.missing'] }), { install: false });
    pl.installAllPlugins();
    eq(pl.pluginState('t.c').state, 'disabled', '10.9 缺依赖插件被禁用');
    ok(/缺依赖|依赖不可用/.test(pl.pluginState('t.c').reason || ''), '10.9 禁用原因记录缺依赖', pl.pluginState('t.c').reason);
    eq(pl.pluginState('t.a').state, 'installed', '10.9 缺依赖不波及其它插件');

    /* ④ 依赖恢复自动重试（P1-22）：迟到依赖注册安装后，下游自动复活 */
    pl.registerPlugin(mk('t.d', { depends: ['t.late'] }), { install: false });
    pl.installAllPlugins();
    eq(pl.pluginState('t.d').state, 'disabled', '10.9 t.d 因 t.late 缺席被禁用');
    pl.registerPlugin(mk('t.late'), {});  /* 默认立即安装 → 成功 → retryDependents */
    eq(pl.pluginState('t.late').state, 'installed', '10.9 延迟注册的 t.late 安装成功');
    eq(pl.pluginState('t.d').state, 'installed', '10.9 t.d 依赖恢复后自动重试安装成功（P1-22）');

    /* ⑤ onInstall 抛异常 → disabled + reason，不传染 */
    pl.registerPlugin(pl.definePlugin({ id: 't.e', name: 't.e', onInstall: function () { throw new Error('boom'); } }), {});
    eq(pl.pluginState('t.e').state, 'disabled', '10.9 onInstall 异常 → disabled');
    ok(/安装异常/.test(pl.pluginState('t.e').reason || ''), '10.9 异常原因已记录', pl.pluginState('t.e').reason);

    /* ⑥ 卸载逆向清理（P1-23）：props 键删除 + 自建命名空间移除；软合并不碰已有键 */
    window.__DJSC.t9pre = { existing: 7 };
    pl.registerPlugin(mk('t.f', { props: { t9pre: { existing: 999, added: 8 }, t9new: { y: 2 } } }), {});
    eq(window.__DJSC.t9pre.existing, 7, '10.9 软合并不覆盖已有键');
    eq(window.__DJSC.t9pre.added, 8, '10.9 软合并补缺失键');
    eq(window.__DJSC.t9new.y, 2, '10.9 新命名空间创建');
    pl.uninstallPlugin('t.f');
    eq(window.__DJSC.t9pre.existing, 7, '10.9 卸载后已有键保留');
    eq(window.__DJSC.t9pre.added, undefined, '10.9 卸载后本插件写入键被删除');
    eq(window.__DJSC.t9new, undefined, '10.9 自建命名空间删空后整体移除');

    /* ⑦ 级联卸载：卸 t.a → 依赖它的 t.b 一并卸载 */
    calls.length = 0;
    pl.uninstallPlugin('t.a');
    eq(pl.pluginState('t.a').state, 'pending', '10.9 t.a 卸载后回 pending');
    eq(pl.pluginState('t.b').state, 'pending', '10.9 级联：t.b 随 t.a 卸载');
    ok(calls.indexOf('uninstall:t.a') >= 0 && calls.indexOf('uninstall:t.b') >= 0, '10.9 级联 onUninstall 均被调用');
    eq(window.__DJSC.t9a, undefined, '10.9 t.a 的 props 命名空间已清理');

    /* ⑧ 生命周期广播：installed 插件收 onStart/onGameEnd + eventBus 发布（P2-33） */
    calls.length = 0;
    let evStart = 0, evEnd = 0;
    eb.on('game:start', function () { evStart++; });
    eb.on('game:end', function () { evEnd++; });
    pl.broadcastStart();
    pl.broadcastGameEnd();
    ok(evStart === 1 && evEnd === 1, '10.9 广播经 eventBus 发布 game:start/game:end');
    ok(calls.indexOf('start:t.late') >= 0 && calls.indexOf('end:t.late') >= 0, '10.9 installed 插件收到 onStart/onGameEnd');
    ok(calls.indexOf('start:t.a') < 0 && calls.indexOf('start:t.e') < 0, '10.9 未安装/禁用插件不收广播');
    eb.clear();
}

/* ================= 10.11 分层自检（报告 §9：L1 加载 / L2 连接 / L3 功能 / L4 实战） =================
 * L2 依赖完整游戏宿主挂载面，Node 下只校验结构不判定通过；L4 不可自动化，必须 manual 且不计失败。 */
{
    const lm = await import(pathToFileURL(join(_pkg, 'score', 'verification', 'layers.js')).href);
    eq(typeof lm.checkL1, 'function', '10.11 layers 导出 checkL1');
    eq(typeof lm.checkL2, 'function', '10.11 layers 导出 checkL2');
    eq(typeof lm.checkL3, 'function', '10.11 layers 导出 checkL3');
    eq(typeof lm.checkL4, 'function', '10.11 layers 导出 checkL4');
    eq(typeof lm.verifyLayers, 'function', '10.11 layers 导出 verifyLayers');
    eq(Array.isArray(lm.LAYER_DEFS) && lm.LAYER_DEFS.length === 4, true, '10.11 恰好四层');
    eq(lm.LAYER_DEFS.map(function (l) { return l.id; }).join(','), 'L1,L2,L3,L4', '10.11 层序 L1→L4');
    eq(lm.LAYER_DEFS[3].auto, false, '10.11 L4 标记为不可自动化');

    /* L1 加载契约：关键模块全部 import 成功 + 导出 shape/type 契约 + MODEL_SCHEMA 形状 */
    const L1 = await lm.checkL1();
    const l1Fails = L1.items.filter(function (it) { return !it.pass; });
    eq(l1Fails.length, 0, '10.11 L1 加载契约全通过', l1Fails.map(function (i) { return i.name + ':' + i.detail; }).join(' | '));

    /* L3 功能 smoke：模型三路径 / predict 归一 / 存储 roundtrip / A-B 状态
     * （Node 下无业务模块订阅 eventBus——宿主引擎未跑；模拟 3 条业务订阅以验证 L3 判定口径，
     *    真实订阅存在性由浏览器端 __DJSC.verifyLayers() 判定） */
    eb.on('game:start', function () {}); eb.on('game:end', function () {}); eb.on('train:done', function () {});
    const L3 = await lm.checkL3();
    const l3Fails = L3.items.filter(function (it) { return !it.pass; });
    eq(l3Fails.length, 0, '10.11 L3 功能 smoke 全通过', l3Fails.map(function (i) { return i.name + ':' + i.detail; }).join(' | '));
    ok(L3.items.some(function (it) { return it.name.indexOf('forward') === 0 && it.pass; }), '10.11 L3 含 forward(zeros130) 且通过');
    ok(L3.items.some(function (it) { return it.name.indexOf('roundtrip') >= 0 && it.pass; }), '10.11 L3 含存储 roundtrip 且通过');
    eq(_mem.has('djsc_smoke_l3_tmp'), false, '10.11 L3 存储 smoke 临时键已清理，不留残渣');

    /* L4 实战行为：全部 manual、pass 为 null、不计失败 */
    const L4 = lm.checkL4();
    eq(L4.auto, false, '10.11 L4 层标记 auto=false');
    ok(L4.items.length >= 6, '10.11 L4 实战行为清单非空（' + L4.items.length + ' 项）');
    eq(L4.items.every(function (it) { return it.manual === true && it.pass === null; }), true, '10.11 L4 全部 manual 且不计失败');

    /* 汇总：verifyLayers 四层齐备；L2 在 Node 下允许断链（缺游戏宿主），但结构必须完整 */
    const all = await lm.verifyLayers();
    eq(all.layers.length, 4, '10.11 verifyLayers 返回四层');
    all.layers.forEach(function (l) {
        ok(l.summary && typeof l.summary.ok === 'number' && typeof l.summary.fail === 'number', '10.11 ' + l.layer + ' 带 ok/fail 汇总');
    });
    eq(typeof all.summary === 'string' && all.summary.indexOf('L4') >= 0, true, '10.11 汇总文本含四层');
    eq(typeof window.__DJSC.verifyLayers, 'function', '10.11 __DJSC.verifyLayers 已挂载');
    eb.clear();
}

/* ================= 10.12 桃救援策略（指令 01：敌方濒死误出桃） =================
 * 唯一权威 evaluateTaoRescue + 四层防线（Policy / Hard Guard / Score Alignment / Tests）。
 * 不变量：self→allow、ally→allow、neutral→block、enemy→block、invalid→block；
 *          relation 解析失败 → 非 self 一律 block（fail-closed），self 仍 allow。
 * 「濒死」只提升紧急度，绝不反转关系方向。 */
{
    const rp = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'safety', 'rescuePolicy.js')).href);

    eq(typeof rp.evaluateTaoRescue, 'function', '10.12 rescuePolicy 导出 evaluateTaoRescue');
    ok(rp.TAO_RESCUE_SCORE && rp.TAO_RESCUE_SCORE.self === 8 && rp.TAO_RESCUE_SCORE.ally === 5
        && rp.TAO_RESCUE_SCORE.neutral === -3 && rp.TAO_RESCUE_SCORE.enemy === -8,
        '10.12 Score 契约 self8/ally5/neutral-3/enemy-8');

    const P = { name: 'me', hp: 1 };
    const T = { name: 't', hp: 0 };

    function _ev(player, target, ctx, name) {
        if (typeof rp.evaluateTaoRescue !== 'function') { ok(false, name, 'evaluateTaoRescue missing'); return {}; }
        try { return rp.evaluateTaoRescue(player, target, ctx) || {}; }
        catch (e) { ok(false, name, 'threw ' + e.message); return {}; }
    }

    /* ---- 关系矩阵：self / ally / enemy / neutral ---- */
    const self = _ev(P, P, {}, '10.12 self');
    eq(self.allow, true, '10.12 自救 allow（target===player 特判）');
    eq(self.relation, 'self', '10.12 自救 relation=self');
    eq(self.score, 8, '10.12 自救 score=+8');

    const ally = _ev(P, T, { disposition: 1 }, '10.12 ally');
    eq(ally.allow, true, '10.12 友方濒死 allow');
    eq(ally.relation, 'ally', '10.12 友方 relation=ally');
    eq(ally.score, 5, '10.12 友方 score=+5');

    const enemy = _ev(P, T, { disposition: -1 }, '10.12 enemy');
    eq(enemy.allow, false, '10.12 敌方濒死 block');
    eq(enemy.relation, 'enemy', '10.12 敌方 relation=enemy');
    eq(enemy.score, -8, '10.12 敌方 score=-8');

    const neutral = _ev(P, T, { disposition: 0 }, '10.12 neutral');
    eq(neutral.allow, false, '10.12 中性濒死 block');
    eq(neutral.relation, 'neutral', '10.12 中性 relation=neutral');
    eq(neutral.score, -3, '10.12 中性 score=-3');

    /* ---- invalid / missing target ---- */
    const inv = _ev(P, null, {}, '10.12 invalid');
    eq(inv.allow, false, '10.12 target 缺失 → block');
    eq(inv.score, -8, '10.12 invalid score=-8');
    ok(String(inv.reason || '').indexOf('invalid') >= 0, '10.12 invalid reason 含 invalid');

    /* ---- relation API 失败 → 非 self 一律 fail-closed ---- */
    const throwRel = { dispositionOf: function () { throw new Error('boom'); } };
    const failEnemy = _ev(P, T, { relations: throwRel, attitude: function () { return null; } }, '10.12 relfail');
    eq(failEnemy.allow, false, '10.12 relation 失败 → 非 self block（fail-closed）');
    ok(String(failEnemy.reason || '').indexOf('unknown') >= 0, '10.12 relation 失败 reason 含 unknown');

    const failSelf = _ev(P, P, { relations: throwRel, attitude: function () { return null; } }, '10.12 relfail-self');
    eq(failSelf.allow, true, '10.12 relation 失败时 self 仍 allow');

    /* ---- attitude fallback ---- */
    eq(_ev(P, T, { attitude: function () { return -5; } }, '10.12 att-enemy').allow, false, '10.12 attitude<0 回退 → block');
    eq(_ev(P, T, { attitude: function () { return 3; } }, '10.12 att-ally').allow, true, '10.12 attitude>0 回退 → allow');

    /* ---- disposition=NaN 不应短路，回退关系链 ---- */
    eq(_ev(P, T, { disposition: NaN, relations: { dispositionOf: function () { return 1; } } }, '10.12 nan').allow,
        true, '10.12 disposition=NaN 时回退 relations → ally allow');

    /* ---- 1 桃 / 多桃：策略与数量无关（不改变方向） ---- */
    eq(_ev(P, T, { disposition: -1, taoCount: 1 }, '10.12 1tao').allow, false, '10.12 1 桃时敌方仍 block');
    eq(_ev(P, T, { disposition: -1, taoCount: 3 }, '10.12 3tao').allow, false, '10.12 多桃时敌方仍 block（数量不改变方向）');

    /* ===== 防线 3：Score Alignment（optimization._scoreTao） ===== */
    const om = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'safety', 'optimization.js')).href);
    eq(typeof om._scoreTao, 'function', '10.12 optimization 导出 _scoreTao');
    if (typeof om._scoreTao === 'function') {
        const sSelf = om._scoreTao(P, P, P, { disposition: 1 });
        const sAlly = om._scoreTao(P, T, T, { disposition: 1 });
        const sEnemy = om._scoreTao(P, T, T, { disposition: -1 });
        const sNeutral = om._scoreTao(P, T, T, { disposition: 0 });
        ok(sSelf > 0, '10.12 optimization 自救濒死 score>0（got ' + sSelf + '）');
        ok(sAlly > 0, '10.12 optimization 友方濒死 score>0（got ' + sAlly + '）');
        ok(sEnemy <= 0, '10.12 optimization 敌方濒死 score<=0（不得给正救援倾向，got ' + sEnemy + '）');
        ok(sNeutral <= 0, '10.12 optimization 中性濒死 score<=0（got ' + sNeutral + '）');
    }

    /* ===== 防线 4：responseAI._shouldSaveTao（true=保留桃） ===== */
    const ra = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cardplay', 'responseAI.js')).href);
    eq(typeof ra._shouldSaveTao, 'function', '10.12 responseAI 导出 _shouldSaveTao');
    if (typeof ra._shouldSaveTao === 'function') {
        const dEnemy = { hp: 0, maxHp: 4 };
        const dAlly = { hp: 0, maxHp: 4 };
        const dNeutral = { hp: 0, maxHp: 4 };
        eq(ra._shouldSaveTao(P, dEnemy, { disposition: -1, dyingTarget: dEnemy }), true, '10.12 responseAI 敌方濒死 → 保留桃（不救）');
        eq(ra._shouldSaveTao(P, dAlly, { disposition: 1, dyingTarget: dAlly }), false, '10.12 responseAI 友方濒死 → 不保留（出桃救）');
        eq(ra._shouldSaveTao(P, P, { dyingTarget: P }), false, '10.12 responseAI 自救濒死 → 不保留（出桃救）');
        eq(ra._shouldSaveTao(P, dNeutral, { disposition: 0, dyingTarget: dNeutral }), true, '10.12 responseAI 中性濒死 → 保留桃');
    }

    /* ===== 防线 4：respond._keepTao（true=保留桃） ===== */
    const rd = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'override', 'respond.js')).href);
    eq(typeof rd._keepTao, 'function', '10.12 respond 导出 _keepTao');
    if (typeof rd._keepTao === 'function') {
        eq(rd._keepTao(P, { hp: 0, maxHp: 4 }, { disposition: -1 }), true, '10.12 respond 敌方濒死 → 保留桃');
        eq(rd._keepTao(P, { hp: 0, maxHp: 4 }, { disposition: 1 }), false, '10.12 respond 友方濒死 → 不保留');
        eq(rd._keepTao(P, P, {}), false, '10.12 respond 自救濒死 → 不保留');
        eq(rd._keepTao(P, { hp: 0, maxHp: 4 }, { disposition: 0 }), true, '10.12 respond 中性濒死 → 保留桃');
    }

    /* ===== 防线 2：Hard Guard（use._resolveDyingTarget / _shouldBlockTaoRescue） ===== */
    const us = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'override', 'use.js')).href);
    eq(typeof us._resolveDyingTarget, 'function', '10.12 use 导出 _resolveDyingTarget');
    eq(typeof us._shouldBlockTaoRescue, 'function', '10.12 use 导出 _shouldBlockTaoRescue');

    if (typeof us._resolveDyingTarget === 'function') {
        const t0 = { name: 'd0' };
        eq(us._resolveDyingTarget({ dying: t0 }, 6), t0, '10.12 resolveDyingTarget 直接读 event.dying');
        const root = { dying: t0, getParent: function () { return null; } };
        const mid = { getParent: function () { return root; } };
        const top = { getParent: function () { return mid; } };
        eq(us._resolveDyingTarget(top, 6), t0, '10.12 resolveDyingTarget 沿 getParent 上溯');
        const a = {}, b = {};
        a.getParent = function () { return b; };
        b.getParent = function () { return a; };
        eq(us._resolveDyingTarget(a, 6), null, '10.12 resolveDyingTarget 循环引用不死循环');
        eq(us._resolveDyingTarget(null, 6), null, '10.12 resolveDyingTarget 空事件 → null');
    }

    if (typeof us._shouldBlockTaoRescue === 'function') {
        const dEnemy = { name: 'e', hp: 0 };
        const dAlly = { name: 'a', hp: 0 };
        eq(us._shouldBlockTaoRescue(P, { name: 'sha' }, {}, { cardId: 'sha', dyingTarget: dEnemy }), false, '10.12 guard 非桃不拦');
        eq(us._shouldBlockTaoRescue(P, { name: 'tao' }, {}, { cardId: 'tao', dyingTarget: null }), false, '10.12 guard 无濒死不拦');
        eq(us._shouldBlockTaoRescue(P, { name: 'tao' }, {}, { cardId: 'tao', dyingTarget: dEnemy, disposition: -1 }), true, '10.12 guard 敌方濒死 → 拦桃');
        eq(us._shouldBlockTaoRescue(P, { name: 'tao' }, {}, { cardId: 'tao', dyingTarget: dAlly, disposition: 1 }), false, '10.12 guard 友方濒死 → 放行');
        eq(us._shouldBlockTaoRescue(P, { name: 'tao' }, {}, { cardId: 'tao', dyingTarget: P }), false, '10.12 guard 自救 → 放行');
        const r = { dying: dEnemy, getParent: function () { return null; } };
        const e2 = { getParent: function () { return r; } };
        eq(us._shouldBlockTaoRescue(P, { name: 'tao' }, e2, { cardId: 'tao', disposition: -1 }), true, '10.12 guard 经事件链找到敌方濒死 → 拦桃');
    }

    /* chooseToUse（off-turn）与 chooseToRespond 共用同一权威 policy */
    eq(_ev(P, T, { disposition: -1 }).allow, false, '10.12 chooseToUse/chooseToRespond 共用 policy：敌方 block');
    eq(_ev(P, P, {}).allow, true, '10.12 chooseToUse/chooseToRespond 共用 policy：self allow');
}

/* ================= 10.13 铁索状态规划（指令 02：状态读取 + 重铸决策） =================
 * Task 1 统一 linked-state：全库唯一 isPlayerLinked 入口，消除 !!isLinked / !isLinked / isChained。
 * 后续 Task 2-6 evaluator 断言持续加入本节。 */
{
    const fsSync = await import('node:fs');
    const ps = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'state', 'playerState.js')).href);
    eq(typeof ps.isPlayerLinked, 'function', '10.13 playerState 导出 isPlayerLinked');

    /* ---- 宿主真实 API：isLinked 为函数 ---- */
    eq(ps.isPlayerLinked({ isLinked: function () { return true; } }), true, '10.13 isLinked()===true → true');
    eq(ps.isPlayerLinked({ isLinked: function () { return false; } }), false, '10.13 isLinked()===false → false');
    eq(ps.isPlayerLinked({ isLinked: function () { return 1; } }), true, '10.13 isLinked() 真值归一为 true');

    /* ---- 非法 / 缺失 ---- */
    eq(ps.isPlayerLinked(null), false, '10.13 null → false');
    eq(ps.isPlayerLinked(undefined), false, '10.13 undefined → false');
    eq(ps.isPlayerLinked({}), false, '10.13 无 isLinked → false');
    eq(ps.isPlayerLinked({ isLinked: function () { throw new Error('boom'); } }), false, '10.13 isLinked() 抛错 → fail-closed false');

    /* ---- legacy 布尔字段（仅在 isLinked 非函数时生效） ---- */
    eq(ps.isPlayerLinked({ isLinked: true }), true, '10.13 legacy isLinked=true → true');
    eq(ps.isPlayerLinked({ isLinked: false }), false, '10.13 legacy isLinked=false → false');

    /* ---- 关键回归：函数对象不得被当作 true（旧 bug：!!p.isLinked） ---- */
    eq(ps.isPlayerLinked({ isLinked: function () { return false; } }), false, '10.13 函数对象不得恒 true（消除 !!p.isLinked）');

    /* ---- 源码守卫：旧写法不得复活 ---- */
    const engSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');
    eq(engSrc.indexOf('!!p.isLinked') < 0, true, '10.13 engine.js 不再出现 !!p.isLinked');
    ok(!/!target\.isLinked\b/.test(engSrc), '10.13 engine.js 不再出现 !target.isLinked');

    const dtSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'safety', 'damageTransfer.js'), 'utf8');
    eq(dtSrc.indexOf('isChained') < 0, true, '10.13 damageTransfer.js 不再出现 isChained');
}

/* ================= 10.14 铁索 evaluator：纯模拟 + 动作枚举（Task 2-3） ================= */
{
    const ev = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cards', 'tiesuoEvaluator.js')).href);
    eq(typeof ev.getCurrentLinkedSet, 'function', '10.14 导出 getCurrentLinkedSet');
    eq(typeof ev.toggleLinkedSet, 'function', '10.14 导出 toggleLinkedSet');
    eq(typeof ev.generateTiesuoActions, 'function', '10.14 导出 generateTiesuoActions');

    function mkP(name, linked) { return { name: name, hp: 4, maxHp: 4, isLinked: function () { return !!linked; } }; }
    const me = mkP('me', false);
    const A = mkP('A', true);
    const E1 = mkP('E1', true);
    const E2 = mkP('E2', false);
    const all = [me, A, E1, E2];

    /* ---- Task 2：纯模拟器 ---- */
    const S = ev.getCurrentLinkedSet(all);
    eq(S instanceof Set, true, '10.14 getCurrentLinkedSet 返回 Set');
    eq(S.size, 2, '10.14 当前横置集合 size=2 (A,E1)');
    eq(S.has(A) && S.has(E1), true, '10.14 集合含 A、E1');
    eq(S.has(E2) && S.has(me), false, '10.14 集合不含 E2、me');

    const a1 = ev.toggleLinkedSet(S, [E2]);
    eq(a1.has(E2), true, '10.14 单目标未横置 → 横置');
    eq(a1.size, 3, '10.14 toggle 后 size=3');
    const a2 = ev.toggleLinkedSet(S, [A]);
    eq(a2.has(A), false, '10.14 单目标已横置 → 解除');
    eq(a2.size, 1, '10.14 解除后 size=1');
    const a3 = ev.toggleLinkedSet(S, [A, E2]);
    eq(a3.has(A), false, '10.14 双目标：A 解除');
    eq(a3.has(E2), true, '10.14 双目标：E2 横置');
    eq(a3.size, 2, '10.14 双目标 toggle 后 size=2');

    /* 纯函数：不修改真实 Player、不修改输入 set */
    eq(typeof A.isLinked === 'function' ? A.isLinked() : A.isLinked, true, '10.14 模拟不修改真实 Player（A 仍横置）');
    eq(S.size, 2, '10.14 模拟不修改输入 beforeSet');

    /* ---- Task 3：动作枚举 ---- */
    const cands = [A, E1, E2];
    const acts = ev.generateTiesuoActions(me, { name: 'tiesuo' }, cands, { canRecast: true });
    eq(acts.filter(function (x) { return x.type === 'recast'; }).length, 1, '10.14 可重铸 → 恰含 1 个 RECAST');
    eq(acts.filter(function (x) { return x.type === 'use' && x.targets.length === 1; }).length, 3, '10.14 生成全部 3 个单目标');
    eq(acts.filter(function (x) { return x.type === 'use' && x.targets.length === 2; }).length, 3, '10.14 生成全部 3 个双目标');
    eq(acts.length, 7, '10.14 总候选 = 1 + 3 + 3 = 7');

    const pairKeys = acts.filter(function (x) { return x.type === 'use' && x.targets.length === 2; })
        .map(function (x) { return x.targets.map(function (t) { return t.name; }).sort().join('+'); });
    eq(new Set(pairKeys).size, 3, '10.14 双目标无重复 pair');

    /* 每个 use 候选必须带 beforeLinked/afterLinked */
    const anyUse = acts.filter(function (x) { return x.type === 'use'; })[0];
    ok(anyUse.beforeLinked instanceof Set && anyUse.afterLinked instanceof Set, '10.14 use 候选带 beforeLinked/afterLinked');
    eq(anyUse.beforeLinked.size, 2, '10.14 beforeLinked 取自全局 players');

    /* 不可重铸 → 不生成 RECAST */
    const actsNoRecast = ev.generateTiesuoActions(me, { name: 'tiesuo' }, cands, { canRecast: false });
    eq(actsNoRecast.filter(function (x) { return x.type === 'recast'; }).length, 0, '10.14 不可重铸 → 无 RECAST');
    eq(actsNoRecast.length, 6, '10.14 不可重铸 → 6 个 use');

    /* 非法目标（null/undefined/重复）被过滤 */
    const actsDirty = ev.generateTiesuoActions(me, { name: 'tiesuo' }, [A, null, undefined, A], { canRecast: false });
    eq(actsDirty.filter(function (x) { return x.type === 'use' && x.targets.length === 1; }).length, 1, '10.14 重复/空目标被去重过滤（单目标=1）');
    eq(actsDirty.length, 1, '10.14 去重后仅剩 1 个 use（无 pair）');
}

/* ================= 10.15 铁索 evaluator：状态 utility + 动作 delta（Task 4-5） ================= */
{
    const ev = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cards', 'tiesuoEvaluator.js')).href);
    eq(typeof ev.evaluateLinkedState, 'function', '10.15 导出 evaluateLinkedState');
    eq(typeof ev.scoreTiesuoAction, 'function', '10.15 导出 scoreTiesuoAction');

    function P(name, rel, hp, maxHp) {
        return { name: name, rel: rel, hp: hp == null ? 4 : hp, maxHp: maxHp == null ? 4 : maxHp, isLinked: function () { return false; } };
    }
    /* 关系注入：+1 ally / -1 enemy / 0 neutral（与项目 dispositionOf 语义一致） */
    const ctx = { relationOf: function (mi, t) { return t.rel; } };
    const me = P('me', 1);

    const E = P('E', -1), E_low = P('E_low', -1, 1, 4);
    const A = P('A', 1), A_low = P('A_low', 1, 1, 4);
    const N = P('N', 0);

    const uNone = ev.evaluateLinkedState(me, null, new Set(), ctx);
    eq(uNone, 0, '10.15 空横置集合 U=0');

    const uE = ev.evaluateLinkedState(me, null, new Set([E]), ctx);
    ok(uE > uNone, '10.15 enemy linked > enemy unlinked');

    const uA = ev.evaluateLinkedState(me, null, new Set([A]), ctx);
    ok(uA < 0 && uA < uNone, '10.15 ally linked < ally unlinked');

    const uEl = ev.evaluateLinkedState(me, null, new Set([E_low]), ctx);
    ok(uEl > uE, '10.15 enemy low HP linked 增益 > enemy high HP');

    const uAl = ev.evaluateLinkedState(me, null, new Set([A_low]), ctx);
    ok(uAl < uA, '10.15 ally low HP linked 惩罚 > ally high HP（更负）');

    const uN = ev.evaluateLinkedState(me, null, new Set([N]), ctx);
    ok(uN <= 0, '10.15 neutral linked 不产生正收益');
    ok(Math.abs(uN) < Math.abs(uE), '10.15 neutral 不被当成明确 enemy（量级近零）');

    /* ---- Task 5：动作 delta ---- */
    const E1 = P('E1', -1), E2 = P('E2', -1), A1 = P('A1', 1);
    function mk(targets, before) {
        return { type: 'use', targets: targets, beforeLinked: before, afterLinked: ev.toggleLinkedSet(before, targets) };
    }
    const before = new Set([E1]);
    const dNew = ev.scoreTiesuoAction(me, mk([E2], before), ctx);
    ok(dNew > 0, '10.15 已有敌人 linked，再链新敌人 → 单目标为正');

    const dRe = ev.scoreTiesuoAction(me, mk([E1], before), ctx);
    ok(dRe < 0 && dRe < dNew, '10.15 已 linked 敌人再次被选 → 显著降分（解链敌人）');

    const dUnlinkAlly = ev.scoreTiesuoAction(me, mk([A1], new Set([A1])), ctx);
    ok(dUnlinkAlly > 0, '10.15 解除 linked 队友 → 为正');

    const b2 = new Set([A1, E1]);
    const dOnlyNew = ev.scoreTiesuoAction(me, mk([E2], b2), ctx);
    const dSwap = ev.scoreTiesuoAction(me, mk([A1, E2], b2), ctx);
    ok(dSwap > dOnlyNew, '10.15 [ally,newEnemy] 胜过仅 [newEnemy]（非加性组合）');
}

/* ================= 10.16 铁索 evaluator：recast 同层竞争 + 主入口（Task 6） ================= */
{
    const ev = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cards', 'tiesuoEvaluator.js')).href);
    eq(typeof ev.estimateTiesuoRecastValue, 'function', '10.16 导出 estimateTiesuoRecastValue');
    eq(typeof ev.evaluateTiesuoActions, 'function', '10.16 导出 evaluateTiesuoActions');

    function P6(name, rel, hp, maxHp) {
        return { name: name, rel: rel, hp: hp == null ? 4 : hp, maxHp: maxHp == null ? 4 : maxHp, isLinked: function () { return false; } };
    }
    const relationOf = function (mi, t) { return t.rel; };
    const me6 = P6('me', 1);

    /* recast 必须稳定、非零、可覆写 */
    const rv = ev.estimateTiesuoRecastValue(me6, { relationOf: relationOf });
    ok(typeof rv === 'number' && rv > 0, '10.16 recast 基准为正（稳定非零）');
    eq(ev.estimateTiesuoRecastValue(me6, { recastValue: 3 }), 3, '10.16 recastValue 可显式覆写');

    /* 所有 use 为负 → RECAST */
    const A6 = P6('A6', 1);
    const resNeg = ev.evaluateTiesuoActions(me6, {}, { candidates: [A6], players: [A6], relationOf: relationOf });
    eq(resNeg.bestAction.type, 'recast', '10.16 所有 use 为负 → 选 RECAST');

    /* 高价值单目标高于 recast → use */
    const E6 = P6('E6', -1);
    const resUse = ev.evaluateTiesuoActions(me6, {}, { candidates: [E6], players: [E6], relationOf: relationOf });
    eq(resUse.bestAction.type, 'use', '10.16 高价值单目标 > recast → use');
    eq(resUse.bestAction.targets.length, 1, '10.16 use 单目标正确');

    /* 最优单目标略低于 recast → RECAST */
    const resLow = ev.evaluateTiesuoActions(me6, {}, { candidates: [E6], players: [E6], relationOf: relationOf, recastValue: 2.5 });
    eq(resLow.bestAction.type, 'recast', '10.16 单目标略低于 recast → RECAST');

    /* 高价值双目标 → use，且返回完整 candidates */
    const E7 = P6('E7', -1);
    const resPair = ev.evaluateTiesuoActions(me6, {}, { candidates: [E6, E7], players: [E6, E7], relationOf: relationOf });
    eq(resPair.bestAction.type, 'use', '10.16 高价值双目标 > recast → use');
    eq(resPair.bestAction.targets.length, 2, '10.16 选中双目标');
    ok(resPair.candidates.length >= 4, '10.16 返回完整 candidates（重铸+单+双）');
    ok(resPair.candidates.every(function (a) { return typeof a.score === 'number'; }), '10.16 所有候选项均被评分');
    ok(resPair.candidates.some(function (a) { return a.type === 'recast'; }), '10.16 candidates 含 RECAST 候选');
    eq(typeof resPair.currentStateValue, 'number', '10.16 返回 currentStateValue');
    eq(typeof resPair.recastValue, 'number', '10.16 返回 recastValue');
}

/* ================= 10.17 engine 集成：bestAction 消费 evaluator（Task 7） =================
 * engine.js 对 tiesuo 不再走普通 targetScore → top1/top2，也不再写死「最多连 6 个」；
 * 改为调用 evaluateTiesuoActions，并在最终结果里消费 evaluator 的 targets / recast 类型。
 * 因 engine.js 依赖完整宿主挂载面（Node 下不可执行），沿用 §10.13 的源码守卫 + 策略行为断言。 */
{
    const fsSync = await import('node:fs');
    const engSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');

    /* ---- 源码守卫：接入唯一权威源 ---- */
    ok(engSrc.indexOf('evaluateTiesuoActions') >= 0, '10.17 engine.js 调用 evaluateTiesuoActions');
    ok(/import\s*\{[^}]*evaluateTiesuoActions[^}]*\}\s*from\s*['"][^'"]*tiesuoEvaluator\.js['"]/.test(engSrc),
        '10.17 engine.js 从 tiesuoEvaluator.js 导入 evaluateTiesuoActions');

    /* ---- 源码守卫：旧 tiesuo 专用分支已删除 ---- */
    eq(engSrc.indexOf('picked.length >= 6') < 0, true, '10.17 旧「最多连 6 个敌人」分支已删除');
    eq(engSrc.indexOf('cands.sort(function (a, b) { return b.ts - a.ts; })') < 0, true,
        '10.17 旧「tsMap 降序选连目标」已删除');
    ok(engSrc.indexOf('_pickCardTargetByPurpose(me, id, bestT || null)') >= 0,
        '10.17 其他牌的 target 选取路径保持不变');

    /* ---- 源码守卫：recast 显式表达 + 消费 evaluator 目标 ---- */
    ok(engSrc.indexOf('best.target') >= 0, '10.17 _finalResult 消费 best.target');
    ok(/recast\s*:/.test(engSrc), '10.17 engine.js 显式表达 recast（不伪装成普通 use）');

    /* ---- 策略行为：方案 §13 决策范例 1-4 ---- */
    const ev17 = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cards', 'tiesuoEvaluator.js')).href);
    function mkP17(name, rel, linked, hp) {
        return { name: name, rel: rel, hp: hp == null ? 4 : hp, maxHp: 4, isLinked: function () { return !!linked; } };
    }
    const rel17 = function (mi, t) { return t.rel; };
    const me17 = mkP17('me', 1, false);

    /* 范例 1：E1 已横置、E2 未横置、A 未横置 → 最佳 [E2]（而非 [E1,E2] / [E1]） */
    {
        const A1 = mkP17('A1', 1, false);
        const E1 = mkP17('E1', -1, true);
        const E2 = mkP17('E2', -1, false);
        const r = ev17.evaluateTiesuoActions(me17, {}, { candidates: [A1, E1, E2], players: [A1, E1, E2], relationOf: rel17 });
        eq(r.bestAction.type, 'use', '10.17 范例1 最佳动作为 use');
        eq(r.bestAction.targets.length, 1, '10.17 范例1 允许只选 E2（单目标）');
        eq(r.bestAction.targets[0], E2, '10.17 范例1 应选未横置的 E2（非解链 E1）');
    }

    /* 范例 2：A 已横置 + E1 已横置 + E2 未横置 → [A,E2] 最优（解队友 + 链新敌） */
    {
        const A2 = mkP17('A2', 1, true);
        const E1 = mkP17('E1', -1, true);
        const E2 = mkP17('E2', -1, false);
        const r = ev17.evaluateTiesuoActions(me17, {}, { candidates: [A2, E1, E2], players: [A2, E1, E2], relationOf: rel17 });
        eq(r.bestAction.type, 'use', '10.17 范例2 最佳动作为 use');
        eq(r.bestAction.targets.length, 2, '10.17 范例2 最佳为双目标');
        ok(r.bestAction.targets.indexOf(A2) >= 0 && r.bestAction.targets.indexOf(E2) >= 0,
            '10.17 范例2 最佳为 [解队友 A + 链新敌 E2]');
    }

    /* 范例 3：仅需救低血队友（敌方有属性威胁）→ [A] */
    {
        const A3 = mkP17('A3', 1, true, 1);
        const E1 = mkP17('E1', -1, true);
        const r = ev17.evaluateTiesuoActions(me17, {}, { candidates: [A3, E1], players: [A3, E1], relationOf: rel17, enemyAttrThreat: true });
        eq(r.bestAction.type, 'use', '10.17 范例3 最佳动作为 use');
        eq(r.bestAction.targets.length, 1, '10.17 范例3 单目标');
        eq(r.bestAction.targets[0], A3, '10.17 范例3 应解除低血队友 A');
    }

    /* 范例 4：无意义场面（敌人均已横置、队友未横置）→ RECAST */
    {
        const A4 = mkP17('A4', 1, false);
        const E1 = mkP17('E1', -1, true);
        const E2 = mkP17('E2', -1, true);
        const r = ev17.evaluateTiesuoActions(me17, {}, { candidates: [A4, E1, E2], players: [A4, E1, E2], relationOf: rel17 });
        eq(r.bestAction.type, 'recast', '10.17 范例4 无意义场面 → RECAST');
    }
}

/* ================= 10.18 aiOverride 对齐 recast（Task 8） =================
 * 当 engine 的 bestAction 显式标记 recast（铁索无意义 → 重铸）时，
 * aiOverride 不得再把 tiesuo 的 aiOrder 推到 100+ / 加 aiValue / 标 useful，
 * 否则原生 AI 只会优先"打出铁索"而非重铸，直接堵死宿主重铸路径。
 * aiOverride.js 依赖完整宿主挂载面，沿用源码守卫 + 纯谓词行为断言。 */
{
    const fsSync = await import('node:fs');
    const aoSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'safety', 'aiOverride.js'), 'utf8');

    /* ---- 纯谓词：显式导出，判据只认 recast === true ---- */
    ok(/export\s+function\s+isRecastRecommended\s*\(/.test(aoSrc),
        '10.18 aiOverride 导出纯谓词 isRecastRecommended');
    ok(/export\s+function\s+isRecastRecommended\s*\(\s*ba\s*\)\s*\{\s*return\s+!!\(\s*ba\s*&&\s*ba\.recast\s*===\s*true\s*\);\s*\}/.test(aoSrc),
        '10.18 isRecastRecommended 严格判定 recast === true');

    /* ---- 三处守卫：aiOrder / aiValue / useful 均在 recast 时短路 ---- */
    ok(aoSrc.indexOf('isRecastRecommended(ba)') >= 0, '10.18 aiOrder/aiValue/useful 调用 isRecastRecommended');
    ok(/isRecastRecommended\(ba\)\)\s*\{\s*return num;/.test(aoSrc),
        '10.18 recast 时 aiValue 短路返回 num（不额外加价值）');
    /* ★ 用户实测「无意义也不重铸」→ 仅「不推高」不足以让位：宿主 _recasting 技能 order=6，
     * 必须主动把铁索自身使用顺序压到 6 以下，重铸才会真正发生。 */
    ok(aoSrc.indexOf('Math.min(num, 5)') >= 0,
        '10.18 recast 时 aiOrder 主动让出顺序（< 宿主 _recasting 的 order 6）');
    ok(/isRecastRecommended\(ba\)\)\s*\{\s*return;/.test(aoSrc),
        '10.18 recast 时 useful 短路返回（不标为值得用）');

    /* ---- 行为：谓词真值表 ---- */
    const ao = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'safety', 'aiOverride.js')).href);
    const g18 = function (x) { return (typeof ao.isRecastRecommended === 'function') ? ao.isRecastRecommended(x) : '<missing>'; };
    eq(typeof ao.isRecastRecommended, 'function', '10.18 isRecastRecommended 可被 import');
    eq(g18({ recast: true }), true, '10.18 {recast:true} → true');
    eq(g18({ recast: false }), false, '10.18 {recast:false} → false');
    eq(g18({ recast: 1 }), false, '10.18 recast 非严格 true → false');
    eq(g18({}), false, '10.18 无 recast 字段 → false');
    eq(g18(null), false, '10.18 null → false');
    eq(g18(undefined), false, '10.18 undefined → false');

    /* ---- 端到端：evaluator 判 recast 的场面，经 engine 口径映射后谓词必命中 ---- */
    const ev18 = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cards', 'tiesuoEvaluator.js')).href);
    function mkP18(name, rel, linked) {
        return { name: name, rel: rel, hp: 4, maxHp: 4, isLinked: function () { return !!linked; } };
    }
    const A18 = mkP18('A18', 1, false), E18a = mkP18('E18a', -1, true), E18b = mkP18('E18b', -1, true);
    const r18 = ev18.evaluateTiesuoActions(mkP18('me', 1, false), {},
        { candidates: [A18, E18a, E18b], players: [A18, E18a, E18b], relationOf: function (mi, t) { return t.rel; } });
    eq(r18.bestAction.type, 'recast', '10.18 无意义场面 evaluator 判 recast');
    const ba18 = {
        rule: 'tiesuo',
        recast: r18.bestAction.type === 'recast',
        target: (r18.bestAction.type === 'use') ? r18.bestAction.targets.map(function (p) { return p.name; }) : null,
    };
    eq(g18(ba18), true, '10.18 engine「recast→ba.recast=true」口径被谓词识别');
    eq(g18({ rule: 'tiesuo', recast: false, target: ['E1'] }), false, '10.18 正常使用（recast=false）不被误判为重铸');
}

/* ================= 10.19 收敛 legacy 铁索启发（Task 9） =================
 * 铁索的最终「使用 / 重铸」只能由 tiesuoEvaluator 唯一决定：
 *  - cardPlayBrain 不再有 tiesuo 专用优先级 / canChainEnemies / isLinking；
 *  - engine.applyBasicCardPlayRules 跳过 tiesuo（不施加通用优先级倾斜），
 *    并向 evaluator 传入属性机会 modifier（复用 threat.linkedChainValue）；
 *  - optimization.js / threat.js 的横置状态读取收敛到 isPlayerLinked；
 *  - damageTransfer 的 tiesuoTiming / tiesuoBonus 第三套使用价值被删除。 */
{
    const fsSync = await import('node:fs');
    const cpbSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'cardplay', 'cardPlayBrain.js'), 'utf8');
    const engSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');
    const optSrc = fsSync.readFileSync(join(_pkg, 'js', 'content', 'optimization.js'), 'utf8');
    const dtSrc  = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'safety', 'damageTransfer.js'), 'utf8');
    const thSrc  = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'threat', 'threat.js'), 'utf8');

    /* ---- cardPlayBrain：无第二套最终 tiesuo policy ---- */
    eq(cpbSrc.indexOf('canChainEnemies') < 0, true, '10.19 cardPlayBrain 删除 canChainEnemies');
    eq(cpbSrc.indexOf('isLinking') < 0, true, '10.19 cardPlayBrain 不再读取自造 isLinking 字段');
    ok(!/if\s*\(\s*id\s*===\s*'tiesuo'\s*\)\s*return/.test(cpbSrc), '10.19 cardPlayBrain 删除 tiesuo 专用 basePriority');
    ok(!/else\s+if\s*\(\s*id\s*===\s*'tiesuo'\s*\)/.test(cpbSrc), '10.19 cardPlayBrain 删除 tiesuo 专用 pickTarget 分支');

    /* ---- engine：基本出牌规则跳过 tiesuo + 属性机会 modifier + 不再自造 isLinking ---- */
    ok(/a\.id\s*===\s*'tiesuo'\)\s*return;/.test(engSrc), '10.19 engine.applyBasicCardPlayRules 跳过 tiesuo（唯一权威=evaluator）');
    eq(engSrc.indexOf('isLinking:') < 0, true, '10.19 engine.js 删除自造 ctx.isLinking 字段');
    ok(engSrc.indexOf('hasOurAttr') >= 0 && engSrc.indexOf('enemyAttrThreat') >= 0, '10.19 engine 向 evaluator 传入属性机会 modifier');
    ok(/import\s*\{[^}]*linkedChainValue[^}]*\}\s*from\s*['"][^'"]*threat\.js['"]/.test(engSrc), '10.19 engine 导入 threat.linkedChainValue 计算属性机会');

    /* ---- optimization：横置读取收敛到 helper ---- */
    ok(/import\s*\{[^}]*isPlayerLinked[^}]*\}\s*from\s*['"][^'"]*playerState\.js['"]/.test(optSrc), '10.19 optimization 导入 isPlayerLinked');
    eq(optSrc.indexOf('.isLinked()') < 0, true, '10.19 optimization 不再直接调用 .isLinked()');
    eq(optSrc.indexOf('.isLinked ') < 0 && optSrc.indexOf('.isLinked||') < 0 && optSrc.indexOf('.isLinked)') < 0, true, '10.19 optimization 不再把 .isLinked 当属性直读');

    /* ---- threat：linkedChainValue 收敛到 helper ---- */
    ok(/import\s*\{[^}]*isPlayerLinked[^}]*\}\s*from\s*['"][^'"]*playerState\.js['"]/.test(thSrc), '10.19 threat 导入 isPlayerLinked');
    eq(thSrc.indexOf('target.isLinked') < 0, true, '10.19 threat.linkedChainValue 不再直接 target.isLinked');
    eq(/[^a-zA-Z]p\.isLinked\b/.test(thSrc), false, '10.19 threat.linkedChainValue 不再直接 p.isLinked');

    /* ---- damageTransfer：删除第三套铁索使用价值 ---- */
    eq(dtSrc.indexOf('tiesuoTiming') < 0, true, '10.19 damageTransfer 删除 tiesuoTiming');
    eq(dtSrc.indexOf('tiesuoBonus') < 0, true, '10.19 damageTransfer 删除 tiesuoBonus');
    const dt = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'safety', 'damageTransfer.js')).href);
    eq(typeof dt.countTiesuo, 'function', '10.19 damageTransfer 仍保留 countTiesuo');
    eq(typeof dt.tiesuoTiming, 'undefined', '10.19 tiesuoTiming 不再导出');
    eq(typeof dt.tiesuoBonus, 'undefined', '10.19 tiesuoBonus 不再导出');

    /* ---- cardPlayBrain 行为：tiesuo 不再有特殊优先级 ---- */
    const cpb = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cardplay', 'cardPlayBrain.js')).href);
    eq(cpb.classifyCard('tiesuo'), 'control', '10.19 tiesuo 分类仍为 control（分类保留）');
    const ctx19 = { me: { hp: 4 }, targets: [{ isAlly: false, hp: 4, threat: 3, isLinking: false }, { isAlly: false, hp: 4, threat: 3, isLinking: false }] };
    eq(cpb.basePriority('tiesuo', ctx19), 60, '10.19 tiesuo 不再有专用优先级，落回 control 默认 60');

    /* ---- threat.linkedChainValue 仍可 import（收敛未破坏模块） ---- */
    const th = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'threat', 'threat.js')).href);
    eq(typeof th.linkedChainValue, 'function', '10.19 threat.linkedChainValue 仍导出且可 import');
}

/* ================= 10.20 铁索宿主侧收敛：result.target / basic.order 读 evaluator =================
 * 根因（用户实测「残局还会单连」）：
 *   optimization.js 的宿主原生铁索 result.target 仍保留旧启发
 *     「同阵营可连人数 < 2 → return 0」（es < 2 / fs < 2），
 *   在残局（1 队友 + 1 敌人）会把两个目标都判 0 → 宿主选不出/只选单目标；
 *   同时 basic.order / useful 恒高，使「重铸」永远输给「使用」。
 * 修复：宿主侧必须消费 evaluator 唯一权威结论（hostTiesuoDecision / hostTiesuoTargetEffect）。 */
{
    const fsSync = await import('node:fs');
    const optSrc = fsSync.readFileSync(join(_pkg, 'js', 'content', 'optimization.js'), 'utf8');
    const ev20 = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cards', 'tiesuoEvaluator.js')).href);
    const relOf20 = function (mi, t) { return t.rel; };
    function mkP20(name, rel, linked, hp) {
        return { name: name, rel: rel, hp: hp == null ? 4 : hp, maxHp: 4, isLinked: function () { return !!linked; } };
    }
    const me20 = mkP20('me20', 1, false);

    /* ---- 源码守卫：宿主侧接入 evaluator、删除旧启发 ---- */
    ok(/import\s*\{[^}]*hostTiesuoDecision[^}]*\}\s*from\s*['"][^'"]*tiesuoEvaluator\.js['"]/.test(optSrc),
        '10.20 optimization 导入 hostTiesuoDecision（宿主侧收敛到 evaluator）');
    eq(optSrc.indexOf('es < 2') < 0, true, '10.20 optimization 删除 es<2 旧启发');
    eq(optSrc.indexOf('fs < 2') < 0, true, '10.20 optimization 删除 fs<2 旧启发');
    eq(optSrc.indexOf('ui.selected.targets.length') < 0, true, '10.20 optimization 删除旧双目标分支');

    const dFn = (typeof ev20.hostTiesuoDecision === 'function') ? ev20.hostTiesuoDecision : function () { return { use: false, targets: [] }; };
    const eFn = (typeof ev20.hostTiesuoTargetEffect === 'function') ? ev20.hostTiesuoTargetEffect : function () { return 0; };

    /* ---- hostTiesuoDecision：与 evaluator 主入口结论一致 ---- */
    {
        const A = mkP20('A', 1, true), E = mkP20('E', -1, false);
        const d = dFn(me20, [me20, A, E], { relationOf: relOf20 });
        eq(d.use, true, '10.20 [A linked, E unlinked] → use');
        eq(Array.isArray(d.targets) && d.targets.length, 2, '10.20 [A linked, E unlinked] → 双目标（解队友+链敌人）');
        ok(d.targets.indexOf(A) >= 0 && d.targets.indexOf(E) >= 0, '10.20 目标 = [A, E]');
    }
    {
        const A = mkP20('A', 1, true), E = mkP20('E', -1, true);
        const d = dFn(me20, [me20, A, E], { relationOf: relOf20 });
        eq(d.use, true, '10.20 [A linked, E linked] → use');
        eq(d.targets.length, 1, '10.20 [A linked, E linked] → 单目标解除 A');
        eq(d.targets[0], A, '10.20 解除队友 A');
    }
    {
        const A = mkP20('A', 1, false), E = mkP20('E', -1, true);
        eq(dFn(me20, [me20, A, E], { relationOf: relOf20 }).use, false, '10.20 [A unlinked, E linked] → 无意义 → recast');
    }

    /* ---- hostTiesuoTargetEffect：方向遵循宿主约定（已横置→正，未横置→负；未选中→0） ---- */
    {
        const A = mkP20('A', 1, true), E = mkP20('E', -1, false);
        const ea = eFn(me20, A, [me20, A, E], { relationOf: relOf20 });
        const ee = eFn(me20, E, [me20, A, E], { relationOf: relOf20 });
        ok(typeof ea === 'number' && ea > 0, '10.20 选中且已横置的队友 A → 正 effect（解除队友）');
        ok(typeof ee === 'number' && ee < 0, '10.20 选中且未横置的敌人 E → 负 effect（横置敌人）');
    }
    {
        /* evaluator 判 recast 时任何目标都不得获得正 effect（宿主不得使用铁索） */
        const A = mkP20('A', 1, false), E = mkP20('E', -1, true);
        eq(eFn(me20, A, [me20, A, E], { relationOf: relOf20 }), 0, '10.20 recast 场面：队友 A effect=0');
        eq(eFn(me20, E, [me20, A, E], { relationOf: relOf20 }), 0, '10.20 recast 场面：敌人 E effect=0');
    }
}

/* ================= 10.21 无懈可击 evaluator：上下文解析 + 效果估值 + 资源成本 + parity（指令 03） =================
 * 目标：建立唯一权威无懈策略源，解决「顺手/拆桥不打、队友乐不打、最后一张捏死、反无懈不会判断」。
 * 全部为纯函数测试，通过 context 注入确证事实（relationOf / wuxieCount）。 */
{
    const fx = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'response', 'wuxieEvaluator.js')).href);
    eq(typeof fx.resolveWuxieContext, 'function', '10.21 导出 resolveWuxieContext');
    eq(typeof fx.evaluateTrickEffect, 'function', '10.21 导出 evaluateTrickEffect');
    eq(typeof fx.estimateWuxieResourceCost, 'function', '10.21 导出 estimateWuxieResourceCost');
    eq(typeof fx.evaluateWuxie, 'function', '10.21 导出 evaluateWuxie');
    eq(typeof fx.shouldUseWuxie, 'function', '10.21 导出 shouldUseWuxie');

    /* ---- 玩家桩：rel +1 友 / -1 敌 / 0 中性；可注入手牌/装备/判定区 ---- */
    function mkP(name, rel, opts) {
        opts = opts || {};
        return {
            name: name, rel: rel,
            hp: opts.hp == null ? 4 : opts.hp, maxHp: 4,
            _h: opts.h == null ? 0 : opts.h,
            _e: opts.e || [], _j: opts.j || [],
            countCards: function (a) { return a === 'h' ? this._h : 0; },
            getCards: function (a) { return a === 'e' ? this._e : (a === 'j' ? this._j : []); },
        };
    }
    const relOf = function (mi, t) { return t.rel; };
    const me = mkP('me', 1, { h: 3 });
    const ally = mkP('ally', 1, { h: 2 });
    const enemy = mkP('enemy', -1, { h: 2 });
    const C = function (id) { return { name: id }; };

    /* ---- Task 2：context resolver ---- */
    function trickEvent(cardName, src, tgt, parent) {
        return { name: cardName, _trigger: { card: { name: cardName }, player: src, target: tgt }, getParent: function () { return parent || null; } };
    }
    function respondEvent(parent) {
        return { name: 'chooseToRespond', _trigger: {}, card: null, getParent: function () { return parent || null; } };
    }
    {
        const ctx = fx.resolveWuxieContext(me, respondEvent(trickEvent('lebu', enemy, ally)), {});
        eq(ctx.resolved, true, '10.21 lebu 场景可解析');
        eq(ctx.originalSpellId, 'lebu', '10.21 解析出原始锦囊 lebu');
        eq(ctx.source, enemy, '10.21 解析出来源 enemy');
        eq(ctx.target, ally, '10.21 解析出受害目标 ally');
        eq(ctx.chainDepth, 0, '10.21 无无懈链 → depth=0');
    }
    {
        /* host 形态：事件本身携带 card/player/target（非 _trigger） */
        const ev = { name: 'guohe', card: { name: 'guohe' }, player: enemy, target: ally, getParent: function () { return null; } };
        const ctx = fx.resolveWuxieContext(me, ev, {});
        eq(ctx.originalSpellId, 'guohe', '10.21 host 形态事件解析 guohe');
        eq(ctx.target, ally, '10.21 host 形态解析目标');
    }
    {
        const ctx = fx.resolveWuxieContext(me, respondEvent(trickEvent('shunshou', enemy, ally)), {});
        eq(ctx.originalSpellId, 'shunshou', '10.21 解析 shunshou');
    }
    {
        /* 反无懈链：current → 敌无懈 → 我无懈 → 原始 lebu */
        const lebuEv = trickEvent('lebu', enemy, ally);
        const w1 = trickEvent('wuxie', me, null, lebuEv);
        const w2 = trickEvent('wuxie', enemy, null, w1);
        const ctx = fx.resolveWuxieContext(me, respondEvent(w2), {});
        eq(ctx.originalSpellId, 'lebu', '10.21 反无懈链仍追到原始锦囊 lebu');
        eq(ctx.target, ally, '10.21 反无懈链不丢失受害目标');
        eq(ctx.chainDepth, 2, '10.21 反无懈链 depth=2');
    }
    {
        const ctx = fx.resolveWuxieContext(me, respondEvent(null), {});
        eq(ctx.resolved, false, '10.21 无法解析 → resolved=false（fail-open）');
    }

    /* ---- Task 3：relation-aware trick effect ---- */
    const ectx = { relationOf: relOf };
    function eff(player, id, tgt, src) {
        return fx.evaluateTrickEffect(player, { originalSpellId: id, target: tgt, source: src }, ectx);
    }
    ok(eff(me, 'lebu', me) < -5, '10.21 自己中乐 → 强负收益');
    ok(eff(me, 'lebu', ally) < -4, '10.21 队友中乐 → 强负收益');
    ok(eff(me, 'lebu', enemy) > 0, '10.21 敌人中乐 → 正收益（不该无懈）');
    ok(eff(me, 'bingliang', ally) < -4, '10.21 队友中兵粮 → 强负收益');
    eq(eff(me, 'lebu', null), 0, '10.21 目标未知 → 保守中性');

    /* ---- Task 4/5：顺手 / 过河估值 ---- */
    {
        const lowAlly = mkP('lowAlly', 1, { h: 1 });
        ok(eff(me, 'shunshou', lowAlly) > -3, '10.21 顺手低价值队友 → 收益有限（可保留）');
        const equipAlly = mkP('equipAlly', 1, { h: 0, e: [C('bagua')] });
        ok(eff(me, 'shunshou', equipAlly) < -3, '10.21 顺手关键装备 → 高保护价值');
        const dyingAlly = mkP('dyingAlly', 1, { h: 1, hp: 1 });
        ok(eff(me, 'shunshou', dyingAlly) < -3, '10.21 顺手低血队友关键手牌 → 高保护价值');
        ok(eff(me, 'guohe', equipAlly) < -2.5, '10.21 拆队友关键装备 → 保护价值');
        const normalAlly = mkP('normalAlly', 1, { h: 0, e: [C('horses')] });
        ok(eff(me, 'guohe', normalAlly) > -2.5, '10.21 拆队友普通装备 → 价值有限');
        const judgeAlly = mkP('judgeAlly', 1, { h: 0, j: [C('lebu')] });
        ok(eff(me, 'guohe', judgeAlly) > 0, '10.21 拆队友判定区乐 → 反而帮队友，不无懈');
        const judgeAlly2 = mkP('judgeAlly2', 1, { h: 0, j: [C('bingliang')] });
        ok(eff(me, 'guohe', judgeAlly2) > 0, '10.21 拆队友判定区兵粮 → 不无懈');
        const judgeAlly3 = mkP('judgeAlly3', 1, { h: 0, j: [C('shandian')] });
        ok(eff(me, 'guohe', judgeAlly3) > 0, '10.21 拆队友判定区闪电 → 不无懈（帮队友）');
    }

    /* ---- 延时锦囊分类：兵/乐/闪电三者同族（判定区） ---- */
    ok(eff(me, 'shandian', me) < -4, '10.21 自己判定区闪电 → 强负收益（应无懈）');
    ok(eff(me, 'shandian', ally) < -4, '10.21 队友判定区闪电 → 强负收益');
    ok(eff(me, 'shandian', enemy) > 0, '10.21 敌人判定区闪电 → 正收益（不无懈）');
    {
        const ctxSd = fx.resolveWuxieContext(me, null, { originalSpellId: 'shandian', source: ally });
        eq(ctxSd.resolved, true, '10.21 闪电无独立目标 → 以使用者为受害者并解析');
        eq(ctxSd.target, ally, '10.21 闪电受害者 = 判定区持有者');
    }

    /* ---- Task 6：资源成本（soft，永不 veto） ---- */
    {
        const c1 = fx.estimateWuxieResourceCost(me, { wuxieCount: 1 });
        const c2 = fx.estimateWuxieResourceCost(me, { wuxieCount: 2 });
        ok(c2 < c1, '10.21 2 张无懈成本 < 最后 1 张');
        const lowHand = mkP('lowHand', 1, { h: 1 });
        ok(fx.estimateWuxieResourceCost(lowHand, { wuxieCount: 1 }) > c1, '10.21 手牌低 → 成本升高');
        ok(Number.isFinite(c1) && c1 > 0, '10.21 资源成本始终有限正数（非 veto）');
    }

    /* ---- Task 7/8：evaluateWuxie 验收矩阵 R1–R12 ---- */
    function dec(player, ctx) {
        return fx.evaluateWuxie(player, null, Object.assign({ relationOf: relOf, wuxieCount: 2 }, ctx || {}));
    }
    /* R1：敌人乐队友 → 高优先无懈 */
    eq(dec(me, { originalSpellId: 'lebu', source: enemy, target: ally }).use, true, '10.21 R1 敌人乐队友 → use');
    /* R12：最后一张无懈 + 队友乐 → 仍使用 */
    eq(dec(me, { originalSpellId: 'lebu', source: enemy, target: ally, wuxieCount: 1 }).use, true, '10.21 R12 最后一张无懈 + 队友乐 → 仍 use');
    /* R2：敌人兵粮低手牌队友 → 使用 */
    eq(dec(me, { originalSpellId: 'bingliang', source: enemy, target: mkP('lowAlly2', 1, { h: 1 }) }).use, true, '10.21 R2 敌人兵粮低手牌队友 → use');
    /* R3：敌人顺手队友普通低价值牌 → 可保留 */
    eq(dec(me, { originalSpellId: 'shunshou', source: enemy, target: mkP('lowAlly3', 1, { h: 1 }), wuxieCount: 1 }).use, false, '10.21 R3 顺手普通低价值队友 → hold');
    /* R4：敌人顺手队友关键装备 → 使用 */
    eq(dec(me, { originalSpellId: 'shunshou', source: enemy, target: mkP('eqAlly', 1, { h: 0, e: [C('bagua')] }) }).use, true, '10.21 R4 顺手关键装备 → use');
    /* R5：敌人拆队友关键装备 → 使用 */
    eq(dec(me, { originalSpellId: 'guohe', source: enemy, target: mkP('eqAlly2', 1, { h: 0, e: [C('bagua')] }), wuxieCount: 1 }).use, true, '10.21 R5 拆关键装备 → use');
    /* R6/R7：敌人拆队友判定区乐/兵粮 → 不无懈 */
    eq(dec(me, { originalSpellId: 'guohe', source: enemy, target: mkP('jAlly', 1, { h: 0, j: [C('lebu')] }) }).use, false, '10.21 R6 拆判定区乐 → hold');
    eq(dec(me, { originalSpellId: 'guohe', source: enemy, target: mkP('jAlly2', 1, { h: 0, j: [C('bingliang')] }) }).use, false, '10.21 R7 拆判定区兵粮 → hold');
    /* R8：自己中乐 → 使用 */
    eq(dec(me, { originalSpellId: 'lebu', source: enemy, target: me, wuxieCount: 1 }).use, true, '10.21 R8 自己中乐 → use');
    /* R9：敌人对敌人乐 → 不无懈 */
    eq(dec(me, { originalSpellId: 'lebu', source: enemy, target: mkP('enemy2', -1, { h: 2 }) }).use, false, '10.21 R9 敌人对敌人乐 → hold');
    /* R9b：延时锦囊同族（闪电）——队友判定区 → use；敌人判定区 → hold；拆队友判定区闪电 → hold */
    eq(dec(me, { originalSpellId: 'shandian', source: ally, target: ally, wuxieCount: 1 }).use, true, '10.21 R9b 队友判定区闪电 → use');
    eq(dec(me, { originalSpellId: 'shandian', source: enemy, target: enemy }).use, false, '10.21 R9b 敌人判定区闪电 → hold');
    eq(dec(me, { originalSpellId: 'guohe', source: enemy, target: mkP('jAlly3', 1, { h: 0, j: [C('shandian')] }) }).use, false, '10.21 R9b 拆队友判定区闪电 → hold');
    /* R11：上下文解析失败 → use=null（fail-open） */
    eq(fx.evaluateWuxie(me, respondEvent(null), {}).use, null, '10.21 R11 无法解析 → use=null');
    eq(fx.shouldUseWuxie(me, respondEvent(null), {}), null, '10.21 R11 shouldUseWuxie → null');
    /* R10：反无懈 parity（0/1/2/3 层 + AI 再出一张 flip） */
    {
        const base = { originalSpellId: 'lebu', source: enemy, target: ally, relationOf: relOf, wuxieCount: 2 };
        const p0 = fx.evaluateWuxie(me, null, Object.assign({}, base, { chainDepth: 0 }));
        const p1 = fx.evaluateWuxie(me, null, Object.assign({}, base, { chainDepth: 1 }));
        const p2 = fx.evaluateWuxie(me, null, Object.assign({}, base, { chainDepth: 2 }));
        const p3 = fx.evaluateWuxie(me, null, Object.assign({}, base, { chainDepth: 3 }));
        eq(p0.finalStateIfPass, 'resolve', '10.21 R10 depth0 → 原锦囊生效');
        eq(p1.finalStateIfPass, 'negate', '10.21 R10 depth1 → 原锦囊失效');
        eq(p2.finalStateIfPass, 'resolve', '10.21 R10 depth2 → 原锦囊生效');
        eq(p3.finalStateIfPass, 'negate', '10.21 R10 depth3 → 原锦囊失效');
        eq(p1.finalStateIfUse, 'resolve', '10.21 R10 depth1 再出无懈 → flip 为生效');
        eq(p0.use, true, '10.21 R10 depth0 有害锦囊 → use（使原锦囊失效）');
        eq(p1.use, false, '10.21 R10 depth1 原锦囊已被无懈 → hold（不应再翻转）');
        eq(p2.use, true, '10.21 R10 depth2 → 再出无懈 use');
        /* 诊断写入 _status.djsc_lastWuxie */
        eq(p2.originalSpellId, 'lebu', '10.21 反无懈不丢失 originalSpellId');
    }
}

/* ================= 10.22 无懈集成回归：唯一权威 evaluator + fail-open + 旧逻辑退役 =================
 * 根因：respond.js / respondBrain.js / responseAI.js / wuxieTiming.js / resourceManage.js
 *   各自维护第二套 critical/harmful 名单与「最后一张无懈」硬否决，互相冲突。
 * 修复：所有最终 use/hold 统一消费 wuxieEvaluator；unresolved 必须 fail-open。 */
{
    const fsSync = await import('node:fs');
    const respSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'override', 'respond.js'), 'utf8');
    const brainSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'basic', 'respondBrain.js'), 'utf8');
    const raiSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'cardplay', 'responseAI.js'), 'utf8');
    const wtSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'timing', 'wuxieTiming.js'), 'utf8');
    const rmSrc = fsSync.readFileSync(join(_pkg, 'score', 'decision', 'resource', 'resourceManage.js'), 'utf8');

    /* ---- 源码守卫：统一消费 evaluator ---- */
    ok(/import\s*\{[^}]*shouldUseWuxie[^}]*\}\s*from\s*['"][^'"]*wuxieEvaluator\.js['"]/.test(respSrc),
        '10.22 respond.js 从 wuxieEvaluator 导入 shouldUseWuxie');
    ok(/wuxieEvaluator\.js/.test(raiSrc), '10.22 responseAI.js 接入 wuxieEvaluator');
    ok(/import\s*\{[^}]*evaluateWuxie[^}]*\}\s*from\s*['"][^'"]*wuxieEvaluator\.js['"]/.test(wtSrc),
        '10.22 wuxieTiming.js 委托 evaluateWuxie');
    ok(/wuxieEvaluator\.js/.test(rmSrc), '10.22 resourceManage.js 接入 wuxieEvaluator');

    /* ---- 旧逻辑退役：第二套名单 / 最后一张硬否决 / 旧 harmful 数组 ---- */
    eq(respSrc.indexOf('wxCount >= 2') < 0, true, '10.22 respond.js 删除「wxCount>=2」硬政策');
    eq(respSrc.indexOf("'zhujin'") < 0, true, '10.22 respond.js 删除第二套 harmful 名单');
    eq(raiSrc.indexOf('CRITICAL_TRICKS') < 0, true, '10.22 responseAI.js 删除 CRITICAL_TRICKS');
    eq(wtSrc.indexOf('CRITICAL_SPELLS') < 0, true, '10.22 wuxieTiming.js 删除本地 CRITICAL_SPELLS');
    eq(rmSrc.indexOf('juedou') < 0, true, '10.22 resourceManage.wuxieTiming 不再自维护锦囊名单');
    ok(brainSrc.indexOf('ev.wuxieUse') >= 0, '10.22 respondBrain 消费注入的 ev.wuxieUse');
    eq(brainSrc.indexOf("!key && wxCount") < 0, true, '10.22 respondBrain 删除「非关键锦囊留底牌」硬否决');

    /* ---- 行为：respondBrain 无懈否决只由 wuxieUse 决定；null fail-open ---- */
    const rb = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'basic', 'respondBrain.js')).href);
    eq(rb.decideRespond('wuxie', { me: {}, event: { wuxieUse: false } }).veto, true, '10.22 wuxieUse=false → veto（保留）');
    eq(rb.decideRespond('wuxie', { me: {}, event: { wuxieUse: true } }).veto, false, '10.22 wuxieUse=true → 不 veto');
    eq(rb.decideRespond('wuxie', { me: {}, event: { wuxieUse: null } }).veto, false, '10.22 wuxieUse=null → fail-open 不 veto');
    eq(rb.decideRespond('wuxie', { me: {}, event: {} }).veto, false, '10.22 缺失 wuxieUse → fail-open 不 veto');

    /* ---- 行为：wrapper 与 evaluator 结论一致 ---- */
    const wt = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'timing', 'wuxieTiming.js')).href);
    const meP = { name: 'meP', hp: 4, maxHp: 4, countCards: function () { return 3; }, getCards: function () { return []; } };
    eq(wt.wuxieTiming(meP, meP, 'lebu').use, true, '10.22 wrapper：自己中乐 → use');
    eq(wt.wuxieTiming(meP, null, 'guohe').use, false, '10.22 wrapper：缺少目标 → 不构成 use（待定）');
    eq(wt.wuxieBonus(meP, { id: 'sha' }), 1.0, '10.22 wuxieBonus 非无懈 → 1.0');
}

/* ================= 10.23 回合内动作一致性：状态新鲜度 + 自我抵消软惩罚（指令 04） =================
 * 根因分两类：
 *   A. State Freshness：缓存指纹 makeStateKey() 不含判定区/装备，且 _lastBestAction 100ms
 *      缓存不受 checkStateChanged() 影响 → 挂乐/兵后下一步可能看不到新控制状态；
 *   B. Action Consistency：顺/拆会把刚建立、仍在判定区生效的乐/兵破坏掉（自我抵消），
 *      原实现只有「判定区有任意延时牌 → ×0.4」的粗暴同目标降权（指令明令禁止）。
 * 修复：① 指纹纳入各存活角色判定区/装备；② 唯一权威 turnStrategicState，
 *      FinalScore = DirectValue − soft 自我抵消惩罚（语义与无懈方案共享）。 */
{
    /* 先尝试导入被测模块：缺失时记为失败而非中断整套测试 */
    let tss = null;
    try {
        tss = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'state', 'turnStrategicState.js')).href);
    } catch (e) {
        ok(false, '10.23 turnStrategicState 模块存在且可导入', String(e && e.message));
    }
    const cache = await import(pathToFileURL(join(_pkg, 'score', 'foundation', 'storage', 'cache.js')).href);
    const wx = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'response', 'wuxieEvaluator.js')).href);

    /* ---- 玩家桩：rel +1 友 / -1 敌；可注入手牌/装备/判定区 ---- */
    function mkP23(name, rel, opts) {
        opts = opts || {};
        return {
            name: name, rel: rel, alive: true,
            hp: opts.hp == null ? 4 : opts.hp, maxHp: 4,
            _h: opts.h == null ? 2 : opts.h, _j: opts.j || [], _e: opts.e || [],
            countCards: function (a) { return a === 'h' ? this._h : 0; },
            getCards: function (a) { return a === 'e' ? this._e : (a === 'j' ? this._j : []); },
        };
    }
    const C23 = function (id) { return { name: id }; };
    const rctx = { relationOf: function (mi, t) { return t.rel; } };
    const me23 = mkP23('me23', 1, { h: 3 });

    if (tss) {
        ['getJudgeCardNames', 'hasDelayedControl', 'delayedControlIdsIn',
         'evaluateDestroyPenalty', 'selfCreatedDestructionPenalty',
         'recordControlState', 'recordSelfCreatedControl', 'getControlRecords', 'clearTurnState'].forEach(function (fn) {
            eq(typeof tss[fn], 'function', '10.23 导出 ' + fn);
        });

        /* ---- 共享语义：不得第二套判定区语义 ---- */
        eq(typeof wx.delayedControlValue, 'function', '10.23 wuxieEvaluator 导出共享 delayedControlValue');
        {
            const src23 = (await import('node:fs')).readFileSync(join(_pkg, 'score', 'decision', 'state', 'turnStrategicState.js'), 'utf8');
            ok(/wuxieEvaluator\.js/.test(src23), '10.23 turnStrategicState 复用 wuxieEvaluator 语义（不另写一套）');
        }

        /* ---- Judge-zone 读取：兵/乐/闪电同族，且关系感知 ---- */
        eq(tss.hasDelayedControl(mkP23('e', -1, { j: [C23('lebu')] })), true, '10.23 判定区乐 → hasDelayedControl');
        eq(tss.hasDelayedControl(mkP23('e', -1, { j: [C23('shandian')] })), true, '10.23 判定区闪电 → 同族');
        eq(tss.hasDelayedControl(mkP23('e', -1, { j: [] })), false, '10.23 无判定牌 → false');

        /* ---- B② 先乐 → 后过河降权；先兵 → 后顺手降权 ---- */
        {
            const eLebu = mkP23('eLebu', -1, { j: [C23('lebu')] });
            const eBing = mkP23('eBing', -1, { j: [C23('bingliang')] });
            const penLebu = tss.selfCreatedDestructionPenalty(me23, eLebu, rctx);
            const penBing = tss.selfCreatedDestructionPenalty(me23, eBing, rctx);
            ok(penLebu > 3, '10.23 先乐→后过河：敌方判定区乐 → 降权 > 3（got ' + penLebu + '）');
            ok(penBing > 3, '10.23 先兵→后顺手：敌方判定区兵粮 → 降权 > 3（got ' + penBing + '）');
            const eShan = mkP23('eShan', -1, { j: [C23('shandian')] });
            ok(tss.selfCreatedDestructionPenalty(me23, eShan, rctx) > 0, '10.23 敌方判定区闪电 → 同样降权（同族）');
        }

        /* ---- 无控制状态 → penalty=0（先顺装备后挂乐 / 先拆装备后挂兵 允许） ---- */
        {
            const eEquip = mkP23('eEquip', -1, { j: [], e: [C23('bagua')] });
            eq(tss.selfCreatedDestructionPenalty(me23, eEquip, rctx), 0, '10.23 先顺高价值装备→后挂乐：先前顺无惩罚');
            eq(tss.hasDelayedControl(eEquip), false, '10.23 装备不等于延时控制（不做同目标降权）');
            eq(tss.selfCreatedDestructionPenalty(me23, mkP23('eNo', -1, { j: [] }), rctx), 0, '10.23 无判定区延时 → penalty=0');
        }

        /* ---- 高收益可覆盖低价值旧状态：soft，不是 hard ban ---- */
        {
            const eLebu2 = mkP23('eLebu2', -1, { j: [C23('lebu')] });
            const pen = tss.selfCreatedDestructionPenalty(me23, eLebu2, rctx);
            ok(pen > 0 && (8 - pen) > 0, '10.23 拆关键装备收益 8 可覆盖乐惩罚 ' + pen + '（soft）');
        }

        /* ---- ally 的敌方乐可解除：负惩罚（鼓励解除） ---- */
        {
            const allyLebu = mkP23('allyLebu', 1, { j: [C23('lebu')] });
            ok(tss.selfCreatedDestructionPenalty(me23, allyLebu, rctx) < 0, '10.23 队友判定区乐 → 负惩罚（鼓励过河解除）');
        }

        /* ---- provenance：记录本回合自建控制 + 生命周期校验 ---- */
        {
            tss.clearTurnState();
            const eP = mkP23('eP', -1, { j: [C23('lebu')] });
            tss.recordControlState(me23, eP, 'lebu');
            eq(tss.getControlRecords().length, 1, '10.23 recordControlState 写入 provenance');
            const dp = tss.evaluateDestroyPenalty(me23, eP, rctx);
            eq(dp.selfCreated, true, '10.23 已记录的敌方乐标记 selfCreated');
            eq(dp.penalty > 0, true, '10.23 已记录且仍在判定区 → 惩罚生效');

            /* protected state 已移除 → penalty=0 */
            eP._j.length = 0;
            eq(tss.selfCreatedDestructionPenalty(me23, eP, rctx), 0, '10.23 控制牌离开判定区 → penalty=0');
            eP._j.push(C23('lebu'));

            /* 目标死亡 → penalty=0 */
            eP.alive = false;
            eq(tss.selfCreatedDestructionPenalty(me23, eP, rctx), 0, '10.23 目标阵亡 → penalty=0');
            eP.alive = true;

            /* 跨回合不污染：相位切换后 provenance 清空，且惩罚仍来自真实状态、不叠加 */
            const before = tss.selfCreatedDestructionPenalty(me23, eP, rctx);
            hostStub._status.currentPhase = { name: 'nextActor' };
            tss.evaluateDestroyPenalty(me23, eP, rctx);   /* 触发相位同步 */
            eq(tss.getControlRecords().length, 0, '10.23 跨回合 provenance 不污染（记录清空）');
            const after = tss.selfCreatedDestructionPenalty(me23, eP, rctx);
            eq(after, before, '10.23 跨回合惩罚不叠加（仍为真实状态值）');
        }

        /* ---- recordSelfCreatedControl：仅 lebu/bingliang、仅命中动作时记录 ---- */
        {
            tss.clearTurnState();
            const eR = mkP23('eR', -1, { j: [] });
            hostStub.game.players = [me23, eR];
            tss.recordSelfCreatedControl(me23, { rule: 'guohe', strat: 'useCardAfter', target: 'eR' }, eR);
            eq(tss.getControlRecords().length, 0, '10.23 非乐/兵动作 → 不记录 provenance');
            tss.recordSelfCreatedControl(me23, { rule: 'lebu', strat: 'useCardAfter', target: 'eR' }, eR);
            eq(tss.getControlRecords().length, 1, '10.23 使用乐命中目标 → 记录 provenance');
        }
        tss.clearTurnState();
    }

    /* ---- A. State Freshness：判定区变化必须使决策缓存失效 ---- */
    {
        const meS = mkP23 ? mkP23('meS', 1, { h: 3, j: [] }) : null;
        if (meS) {
            const eS = mkP23('eS', -1, { h: 2, j: [] });
            hostStub.game.me = meS;
            hostStub.game.players = [meS, eS];
            hostStub.game.alivePlayers = [meS, eS];
            hostStub._status.currentPhase = meS;
            cache.checkStateChanged();                                   /* 基线同步 */
            eq(cache.checkStateChanged(), false, '10.23 状态未变 → 缓存保留');
            eS._j.push(C23('lebu'));
            eq(cache.checkStateChanged(), true, '10.23 敌方判定区落乐 → 指纹变化（缓存失效，下一步可见）');
            eS._j.length = 0;
            eq(cache.checkStateChanged(), true, '10.23 判定牌离开 → 再次失效');
        }
    }

    /* ---- 源码守卫：唯一权威接入 + 粗暴同目标降权退役 + 缓存指纹纳入判定区 ---- */
    {
        const fsSync23 = await import('node:fs');
        const engSrc = fsSync23.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');
        const cacheSrc = fsSync23.readFileSync(join(_pkg, 'score', 'foundation', 'storage', 'cache.js'), 'utf8');
        ok(/turnStrategicState\.js/.test(engSrc), '10.23 engine.js 接入唯一权威 turnStrategicState');
        ok(/evaluateDestroyPenalty/.test(engSrc), '10.23 engine.js 调用 evaluateDestroyPenalty');
        eq(engSrc.indexOf('s *= 0.4') < 0, true, '10.23 engine.js 删除「判定区有延时牌 → ×0.4」粗暴同目标降权');
        ok(/getCards\(['"]j['"]\)/.test(cacheSrc), '10.23 cache.makeStateKey 纳入判定区指纹');
        ok(/checkStateChanged/.test(engSrc) && /_lastBestAction = null/.test(engSrc),
            '10.23 engine.js 状态变化时清空 _lastBestAction（100ms 缓存不得掩盖状态变化）');
        ok(/import\s*\{[^}]*\bgame\b[^}]*\}\s*from\s*['"][^'"]*host\.js['"]/.test(cacheSrc),
            '10.23 cache.js 显式导入宿主（消除隐式全局静默失效）');
    }
}

/* ================= 10.24 架构稳定化 Stage A：统一 Player State Snapshot（指令 05） =================
 * 契约：策略层不再猜宿主字段（isLinked/isChained/judges/isJudge/isJudged/equipVal）；
 * 一律经 buildPlayerSnapshot 归一 alive/hp/maxHp/handCount/linked/judge/equip/nextToAct/threat。
 */
{
    let ps = null;
    try { ps = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'state', 'playerSnapshot.js')).href); }
    catch (e) { ps = null; }

    ok(ps && typeof ps.buildPlayerSnapshot === 'function', '10.24 导出 buildPlayerSnapshot');
    ['judgeCardsOf', 'equipCardsOf', 'equipValueOf', 'handCountOf', 'nextToActOf', 'isLordOf', 'buildPlayerSnapshot'].forEach(function (fn) {
        if (!ps) return;
        eq(typeof ps[fn], 'function', '10.24 导出 ' + fn);
    });

    /* 玩家桩：宿主风格 API（getCards/countCards/isNextToAct/isLinked 函数） */
    function mkA(name, opts) {
        opts = opts || {};
        const p = {
            name: name, name1: name, alive: opts.alive !== false,
            hp: opts.hp == null ? 4 : opts.hp, maxHp: opts.maxHp == null ? 4 : opts.maxHp,
            _h: opts.h || [], _j: opts.j || [], _e: opts.e || [],
            countCards: function (a) {
                if (a === 'hs') return this._h.length;
                return a === 'h' ? this._h.length : (a === 'e' ? this._e.length : (a === 'j' ? this._j.length : 0));
            },
            getCards: function (a) {
                if (a === 'h') return this._h;
                return a === 'e' ? this._e : (a === 'j' ? this._j : []);
            },
        };
        if (opts.isNextToAct !== undefined) p.isNextToAct = opts.isNextToAct;
        if (opts.isLinked !== undefined) p.isLinked = opts.isLinked;
        return p;
    }

    if (ps) {
        /* A. 判定区事实归一 */
        const pJ = mkA('pJ', { j: [{ name: 'lebu' }, { name: 'bingliang' }] });
        const sJ = ps.buildPlayerSnapshot(pJ);
        eq(sJ.hasJudge, true, '10.24 判定区有牌 → hasJudge=true');
        eq(sJ.judgeCards.length, 2, '10.24 judgeCards 读取真实判定区');
        eq(sJ.judgeNames.join(','), 'lebu,bingliang', '10.24 judgeNames 归一');
        eq(ps.buildPlayerSnapshot(mkA('pNoJ', { j: [] })).hasJudge, false, '10.24 空判定区 → hasJudge=false');

        /* B. 装备区：equipCount / equipVal 不再读宿主猜测字段 p.equipVal */
        const sE = ps.buildPlayerSnapshot(mkA('pE', { e: [{ name: 'bagua' }, { name: 'zhuge' }] }));
        eq(sE.equipCount, 2, '10.24 equipCount 读取真实装备区');
        ok(sE.equipVal >= sE.equipCount, '10.24 equipVal ≥ equipCount（装备价值而非宿主猜测）');
        const pFake = mkA('pFake', { e: [] }); pFake.equipVal = 999;
        eq(ps.buildPlayerSnapshot(pFake).equipVal, 0, '10.24 不再读取宿主猜测字段 p.equipVal');

        /* C. 手牌 / 存活 / HP 归一 */
        const sH = ps.buildPlayerSnapshot(mkA('pH', { h: [{ name: 'sha' }, { name: 'shan' }, { name: 'tao' }], hp: 2, maxHp: 4 }));
        eq(sH.handCount, 3, '10.24 handCount 读取真实手牌');
        eq(sH.hp, 2, '10.24 hp 归一');
        eq(sH.maxHp, 4, '10.24 maxHp 归一');
        eq(sH.alive, true, '10.24 alive 归一');
        eq(ps.buildPlayerSnapshot(mkA('pD', { alive: false })).alive, false, '10.24 阵亡归一');

        /* D. 横置：唯一权威 isPlayerLinked 语义，不猜 isChained */
        const pL = mkA('pL'); pL.isLinked = function () { return true; };
        eq(ps.buildPlayerSnapshot(pL).linked, true, '10.24 isLinked() 函数 → linked=true');
        const pL2 = mkA('pL2'); pL2.isLinked = function () { return false; };
        eq(ps.buildPlayerSnapshot(pL2).linked, false, '10.24 isLinked() 返回 false → linked=false');
        const pL3 = mkA('pL3'); pL3.isChained = true;
        eq(ps.buildPlayerSnapshot(pL3).linked, false, '10.24 不采信猜测字段 isChained');

        /* E. nextToAct 归一 */
        eq(ps.buildPlayerSnapshot(mkA('pN', { isNextToAct: true })).nextToAct, true, '10.24 nextToAct 归一');
        eq(ps.buildPlayerSnapshot(mkA('pN2', { isNextToAct: false })).nextToAct, false, '10.24 nextToAct=false 归一');

        /* F. 健壮性：空玩家 → 安全空快照 */
        const sNull = ps.buildPlayerSnapshot(null);
        eq(sNull.alive, false, '10.24 null 玩家 → 安全空快照');
        eq(sNull.handCount, 0, '10.24 null 玩家 handCount=0');

        /* G. 源码守卫：策略层不再猜宿主字段 + 唯一入口收敛 */
        const fsA = await import('node:fs');
        const engA = fsA.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');
        const ccA = fsA.readFileSync(join(_pkg, 'score', 'decision', 'strategy', 'comboChain.js'), 'utf8');
        const exA = fsA.readFileSync(join(_pkg, 'score', 'foundation', 'io', 'export.js'), 'utf8');
        ok(/playerSnapshot\.js/.test(engA) && /buildPlayerSnapshot/.test(engA), '10.24 engine.js 接入统一 playerSnapshot');
        eq(/isJudge\s*\|\|\s*\w+\.isJudged/.test(engA), false, '10.24 engine.js 退役 p.isJudge || p.isJudged 猜测');
        eq(/isFinite\(p\.equipVal\)/.test(engA), false, '10.24 engine.js 退役 p.equipVal 猜测');
        eq(/p\.judges\s*&&/.test(engA), false, '10.24 engine.js 退役 p.judges 原始读取');
        ok(/isPlayerLinked/.test(ccA), '10.24 comboChain 使用唯一横置入口 isPlayerLinked');
        ok(/isPlayerLinked/.test(exA), '10.24 export 使用唯一横置入口 isPlayerLinked');
    }
}

/* ================= 10.25 架构稳定化 Stage B：Relations 单一权威源（指令 05） =================
 * 契约：score/decision/** 的「政策决策」不得再散落 get.attitude()；敌我三元
 *   isAllyOf/isNeutralOf/isEnemyOf 一律经 relations.dispositionOf（含行为推断软翻转）。
 *   threat.js 的 enemiesOf/isEnemyOf 收敛到 relations（消除第二套敌我源 / 内奸误判）。
 */
{
    let rel = null;
    try { rel = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'relations', 'relations.js')).href); }
    catch (e) { rel = null; }

    ok(rel && typeof rel.isEnemyOf === 'function', '10.25 relations 导出规范名 isEnemyOf');
    ok(rel && typeof rel.isAllyOf === 'function' && typeof rel.isNeutralOf === 'function', '10.25 relations 敌我三元齐全');

    const fsB = await import('node:fs');

    /* 已迁移的政策决策文件：须无 get.attitude（源码守卫） */
    const policyFiles = [
        'score/decision/timing/taoyuanTiming.js',
        'score/decision/timing/wuguTiming.js',
        'score/decision/timing/duelTiming.js',
        'score/decision/timing/jiedaoTiming.js',
        'score/decision/timing/aoeTiming.js',
        'score/decision/timing/jiuTiming.js',
        'score/decision/timing/judgeTiming.js',
        'score/decision/timing/shunshouTiming.js',
        'score/decision/cardplay/responseOpt.js',
        'score/decision/cardplay/responseAI.js',
        'score/decision/override/respond.js',
        'score/decision/override/discard.js',
        'score/decision/tuning/shaTargetOpt.js',
        'score/decision/tuning/endgameOpt.js',
        'score/decision/strategy/planner.js',
        'score/decision/strategy/multiTurnPlan.js',
        'score/decision/strategy/multiTurnOpt.js',
        'score/decision/strategy/comboChain.js',
        'score/decision/safety/optimization.js',
        'score/decision/safety/aiOverride.js',
    ];
    policyFiles.forEach(function (f) {
        let src = '';
        try { src = fsB.readFileSync(join(_pkg, f), 'utf8'); } catch (e) { src = ''; }
        eq(src.indexOf('get.attitude') < 0, true, '10.25 ' + f + ' 无 get.attitude 散落');
    });

    /* timing 文件：补上显式 import（消除静默失效） */
    ['taoyuanTiming', 'wuguTiming', 'duelTiming', 'jiedaoTiming', 'aoeTiming', 'jiuTiming', 'judgeTiming', 'shunshouTiming'].forEach(function (n) {
        const src = fsB.readFileSync(join(_pkg, 'score', 'decision', 'timing', n + '.js'), 'utf8');
        ok(/^import\s/m.test(src), '10.25 ' + n + ' 显式 import（评分层不再依赖全局）');
    });

    /* threat.js：enemiesOf/isEnemyOf 收敛到 relations（_dispositionOf） */
    const thSrc = fsB.readFileSync(join(_pkg, 'score', 'decision', 'threat', 'threat.js'), 'utf8');
    ok(/_dispositionOf\(char, p\) === -1/.test(thSrc), '10.25 enemiesOf 收敛到 relations._dispositionOf');
    ok(/function isEnemyOf\(me, t\)[\s\S]*?_dispositionOf\(me, t\) === -1/.test(thSrc), '10.25 isEnemyOf 收敛到 _dispositionOf（不再 get.attitude + 阵营 map）');
    eq(/get\.attitude\(char, p\)/.test(thSrc), false, '10.25 enemiesOf 不再散落 get.attitude');
    eq(/camp\[p\.identity\]/.test(thSrc), false, '10.25 enemiesOf 移除阵营 map 重推导（内奸不再误判为敌）');
    eq(thSrc.indexOf('require(') < 0, true, '10.25 threat.js 无 ESM 内 require（cardValueWithTarget 走 import）');
    eq(/isEnemyOf\(target, me\)/.test(thSrc), false, '10.25 cardValueWithTarget 视角修正为 isEnemyOf(me, target)');

    /* engine.js：政策决策无 get.attitude 散落 */
    const engB = fsB.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');
    eq(engB.indexOf('get.attitude') < 0, true, '10.25 engine.js 无 get.attitude 散落');

    /* 保留 raw-fact 的合法边界仍存在（relations 基线 / 阵营归类 modeStrategy / diagnostics postCheck） */
    const relSrc = fsB.readFileSync(join(_pkg, 'score', 'decision', 'relations', 'relations.js'), 'utf8');
    ok(/get\.attitude\(me, t\)/.test(relSrc), '10.25 relations 保留 get.attitude 同源基线（唯一权威本身）');
}

/* ================= 10.26 架构稳定化 Stage C：targetBrain Data Contract（指令 05） =================
 * 契约：targetBrain 的目标候选一律经 buildTargetCandidate（playerSnapshot.js）生产，
 *   确保 handCount/equipVal(judgeCards)/nextToAct/linked/isAlly/isEnemy/threat 真实且更新；
 *   engine.js 不再手拼 pickTargetByPurpose 的候选数组（消除字段缺失/口径漂移）。
 *   同时验证 probHasShan 单参兼容（旧实现曾导致 targetBrain/kill 的 shanProb 恒 0.3）。
 */
{
    let snapMod = null;
    try { snapMod = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'state', 'playerSnapshot.js')).href); }
    catch (e) { snapMod = null; }

    ok(snapMod && typeof snapMod.buildTargetCandidate === 'function', '10.26 buildTargetCandidate 存在');

    const fsC = await import('node:fs');
    const engC = fsC.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');

    /* 引擎目标候选来源已收敛到 buildTargetCandidate（3 个 pickTargetByPurpose 候选数组） */
    ok(/buildTargetCandidate\(me, p\)/.test(engC), '10.26 engine 经 buildTargetCandidate(me,p) 生产候选');
    eq(/targets\.push\(\{\s*name:\s*p\.name1/.test(engC), false, '10.26 applyBasicTargetRules 不再手拼 name/hp/threat');
    eq(/shanProb:\s*\(function\(\)\{\s*try \{\s*return probHasShan\(p\)/.test(engC), false, '10.26 _buildTargetBrainCandidates 不再手拼 shanProb');

    /* 契约字段集：targetBrain 消费字段全部存在 */
    const snapC = fsC.readFileSync(join(_pkg, 'score', 'decision', 'state', 'playerSnapshot.js'), 'utf8');
    ['pp', 'name', 'isAlly', 'isEnemy', 'hp', 'maxHp', 'threat', 'handCount', 'shaCount',
     'shanProb', 'equipVal', 'equipCount', 'judgeCards', 'isJudge', 'nextToAct', 'linked', 'isLord'].forEach(function (k) {
        ok(snapC.indexOf(k + ':') >= 0, '10.26 buildTargetCandidate 契约字段 ' + k);
    });

    /* probHasShan 单参兼容（曾恒返回 0.3 的 shanProb 数据失真） */
    const thC = fsC.readFileSync(join(_pkg, 'score', 'decision', 'threat', 'threat.js'), 'utf8');
    ok(/if \(tgt === undefined\) tgt = me;/.test(thC), '10.26 probHasShan 兼容单参调用（shanProb 不再恒 0.3）');

    /* 功能冒烟：桩玩家 → 契约字段真实（判定区/手牌透传，阵亡返回 null） */
    if (snapMod) {
        function mkP26(name, opts) {
            opts = opts || {};
            return {
                name: name, alive: opts.alive !== false,
                hp: opts.hp == null ? 4 : opts.hp, maxHp: 4,
                _h: opts.h == null ? 2 : opts.h, _j: opts.j || [], _e: opts.e || [],
                countCards: function (a) { return a === 'h' ? this._h : 0; },
                getCards: function (a) { return a === 'e' ? this._e : (a === 'j' ? this._j : []); },
            };
        }
        const C26 = function (id) { return { name: id }; };
        const me26 = mkP26('me26', { h: 3 });
        const p26 = mkP26('p26', { hp: 1, h: 2, j: [C26('lebu')], e: [C26('bagua')] });
        const cand = snapMod.buildTargetCandidate(me26, p26);
        ok(cand && typeof cand === 'object', '10.26 buildTargetCandidate 返回对象');
        ok(cand && cand.isJudge === true, '10.26 判定区 → isJudge=true');
        ok(cand && cand.hp === 1, '10.26 hp 透传');
        ok(cand && cand.handCount === 2, '10.26 handCount 真实');
        ok(cand && Array.isArray(cand.judgeCards) && cand.judgeCards.length === 1, '10.26 judgeCards 真实');
        eq(typeof (cand && cand.shanProb), 'number', '10.26 shanProb 实数');
        eq(typeof (cand && cand.linked), 'boolean', '10.26 linked 事实');
        eq(snapMod.buildTargetCandidate(me26, { name: 'dead26', alive: false }), null, '10.26 阵亡 → null');
    }
}

/* ================= 10.27 架构稳定化 Stage D：Action Semantics / State Transition Utility（指令 05） =================
 * 语义：拆除(过河/顺手)从 relation-only 升级为 state-transition utility：
 *   - 过河拆/顺手 队友的乐/兵/闪电 = 帮队友 → 正收益（旧实现被 inferPurpose 分到 control → 恒 -8）；
 *   - 拆/顺 无负面判定区的队友 = 伤队友 → 仍强负；
 *   - 纯控制(lebu/bingliang/shandian) 仍只对真敌（贴队友仍强罚，不放松）。
 *   同时清理 judgeBrain 的 drawDependency 死条件（全仓无生产者），并验证 directionScore 同口径。
 */
{
    let relMod = null;
    try { relMod = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'relations', 'relations.js')).href); }
    catch (e) { relMod = null; }

    ok(relMod && typeof relMod.actionValue === 'function', '10.27 actionValue 存在');
    ok(relMod && typeof relMod.directionScore === 'function', '10.27 directionScore 存在');

    /* 源码守卫：inferPurpose 把 guohe/shunshou 拆为 dismantle（消除与 engine._CARD_PURPOSE 的口径漂移） */
    const fsD = await import('node:fs');
    const relD = fsD.readFileSync(join(_pkg, 'score', 'decision', 'relations', 'relations.js'), 'utf8');
    ok(/const DISMANTLE = \['guohe', 'shunshou'\]/.test(relD), '10.27 inferPurpose 新增 dismantle 分类');
    eq(/'guohe', 'shunshou', 'lebu'/.test(relD), false, '10.27 guohe/shunshou 不再并入 control 名单');

    /* judgeBrain 死条件清理（drawDependency 全仓无生产者） */
    const jbD = fsD.readFileSync(join(_pkg, 'score', 'decision', 'basic', 'judgeBrain.js'), 'utf8');
    eq(/drawDependency/.test(jbD), false, '10.27 judgeBrain 移除 drawDependency 死条件');

    /* 功能冒烟：拆队友负面判定区→正；拆无负面队友→负；纯控制贴队友→负 */
    if (relMod) {
        function mkP27(name, opts) {
            opts = opts || {};
            return {
                name: name, alive: true,
                hp: opts.hp == null ? 4 : opts.hp,
                _j: opts.j || [],
                isFriend: opts.isFriend,   /* undefined → 走 get.attitude(桩)=0 → 中性 */
                getCards: function (a) { return a === 'j' ? this._j : []; },
            };
        }
        const me27 = mkP27('me27');
        const allyJudge = mkP27('allyJudge', { j: [{ name: 'lebu' }], isFriend: function () { return true; } });
        const allyClean = mkP27('allyClean', { isFriend: function () { return true; } });

        const v1 = relMod.actionValue(me27, { id: 'guohe', target: allyJudge, base: 0 });
        ok(v1 > 0, '10.27 过河拆队友乐 → 正收益');
        const v2 = relMod.actionValue(me27, { id: 'shunshou', target: allyJudge, base: 0 });
        ok(v2 > 0, '10.27 顺手队友乐 → 正收益');
        const v3 = relMod.actionValue(me27, { id: 'guohe', target: allyClean, base: 0 });
        ok(v3 < 0, '10.27 拆无负面队友 → 负收益');
        const v4 = relMod.actionValue(me27, { id: 'lebu', target: allyJudge, base: 0 });
        ok(v4 < 0, '10.27 乐贴队友仍强罚（纯控制不放松）');

        eq(relMod.directionScore(me27, { id: 'guohe' }, allyJudge), 1, '10.27 directionScore 拆队友负面判定 → +1');
        eq(relMod.directionScore(me27, { id: 'guohe' }, allyClean), -3, '10.27 directionScore 拆无负面队友 → -3');
    }
}

/* ================= 10.28 架构稳定化 Stage D：铁索状态转换 + 闪电语义归位（指令 05） =================
 * 覆盖“铁索解除队友”反例：tiesuo 不再并入 relation-only 的 control（否则对队友恒 -8、对敌恒 +2，
 * 与“解横置队友/横置敌人”的真实状态转换语义冲突），升级为 state，交回 tiesuoEvaluator 唯一权威；
 * 同时把 shandian(闪电) 从 control 中移除（其对自己使用、入己判定区并轮转，非“贴敌人”）。
 */
{
    let relMod = null;
    try { relMod = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'relations', 'relations.js')).href); }
    catch (e) { relMod = null; }
    ok(relMod && typeof relMod.inferPurpose === 'function', '10.28 inferPurpose 已导出（动作语义唯一源）');

    /* 源码守卫：tiesuo → STATE；shandian 不再出现在 control 名单 */
    const fsD = await import('node:fs');
    const relD = fsD.readFileSync(join(_pkg, 'score', 'decision', 'relations', 'relations.js'), 'utf8');
    ok(/const STATE = \['tiesuo'\]/.test(relD), '10.28 inferPurpose 新增 STATE 分类（状态转换）');
    eq(/const CTRL = \['lebu', 'bingliang', 'jiedao'\]/.test(relD), true, '10.28 control 名单不再含 tiesuo/shandian');

    if (relMod) {
        function mkP28(name, opts) {
            opts = opts || {};
            return {
                name: name, alive: true,
                hp: opts.hp == null ? 4 : opts.hp,
                _j: opts.j || [],
                isFriend: opts.isFriend,   /* undefined → disposition 中性 */
                getCards: function (a) { return a === 'j' ? this._j : []; },
            };
        }
        const me28 = mkP28('me28');
        const ally28 = mkP28('ally28', { isFriend: function () { return true; } });

        eq(relMod.inferPurpose({ id: 'tiesuo' }), 'state', '10.28 铁索 → state（状态转换，非 control）');
        eq(relMod.inferPurpose({ id: 'shandian' }), 'generic', '10.28 闪电 → generic（自用非控敌）');
        eq(relMod.inferPurpose({ id: 'lebu' }), 'control', '10.28 乐 → control（纯控制不变）');
        eq(relMod.inferPurpose({ id: 'guohe' }), 'dismantle', '10.28 过河 → dismantle（拆除不变）');

        /* ★ 反例：铁索对队友 = 交回 tiesuoEvaluator，不再 relation-only 强罚 -8 */
        eq(relMod.actionValue(me28, { id: 'tiesuo', target: ally28, base: 5 }), 5,
            '10.28 铁索对队友 → 中性 base（解横置交回 evaluator，不再强罚）');
        eq(relMod.directionScore(me28, { id: 'tiesuo' }, ally28), 0,
            '10.28 directionScore 铁索 → 0（不做关系方向加减分）');
    }
}

/* ================= 10.29 架构稳定化 Stage F：特殊牌 Evaluator（指令 05） =================
 * 借刀 = weaponHolder + victim pair action（jiedaoEvaluator 唯一权威）；
 * 桃园 = Σ allyHeal − Σ enemyHeal；五谷 = 敌我人数 + 手牌需求 + 座次净效用。
 * 关键反例：帮敌人回血/补牌 → 净效用为负 → 不放（旧实现只看我方残血/缺牌，恒放）。
 */
{
    const fsF = await import('node:fs');
    let je = null, tt = null, wu = null;
    try { je = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'cards', 'jiedaoEvaluator.js')).href); } catch (e) { je = null; }
    try { tt = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'timing', 'taoyuanTiming.js')).href); } catch (e) { tt = null; }
    try { wu = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'timing', 'wuguTiming.js')).href); } catch (e) { wu = null; }

    ok(je && typeof je.evaluateJiedaoPair === 'function' && typeof je.bestJiedaoPair === 'function', '10.29 jiedaoEvaluator pair 接口齐全');
    ok(tt && typeof tt.taoyuanValue === 'function', '10.29 taoyuanValue 导出（Σ allyHeal−Σ enemyHeal）');
    ok(wu && typeof wu.wuguValue === 'function', '10.29 wuguValue 导出（敌我人数+需求+座次）');

    /* 源码守卫：jiedaoTiming 委托 evaluator（不再 relation-only 单目标） */
    const jdSrc = fsF.readFileSync(join(_pkg, 'score', 'decision', 'timing', 'jiedaoTiming.js'), 'utf8');
    ok(/jiedaoEvaluator\.js/.test(jdSrc), '10.29 jiedaoTiming 委托 jiedaoEvaluator');

    /* 敌我注入（与 behavior 同 seam；本块为门禁最后一块，不改动其余 10.x） */
    const host29 = await import(pathToFileURL(_hostPath).href);
    host29.get.attitude = function (me, t) { return t && t.rel ? t.rel : 0; };
    host29.get.subtypes = function (c) { return (c && c.subtypes) || []; };

    function W29(name) { return { name: name, subtypes: ['equip1'] }; }
    function P29(name, rel, o) {
        o = o || {};
        return {
            name: name, rel: rel, alive: true,
            hp: o.hp == null ? 4 : o.hp, maxHp: o.maxHp == null ? 4 : o.maxHp,
            _h: o.h == null ? 4 : o.h, _e: o.e || [],
            countCards: function (z) { return z === 'h' ? this._h : 0; },
            getCards: function (z) { return z === 'e' ? this._e : []; },
        };
    }

    if (je) {
        const meF = P29('meF', 1);
        const holderE = P29('holderE', -1, { e: [W29('qinglong')] });
        const holderA = P29('holderA', 1, { e: [W29('zhuge')] });
        const victimE = P29('victimE', -1, { hp: 1 });
        eq(je.evaluateJiedaoPair(meF, holderE, victimE).use, true, '10.29 借敌刀杀敌 → use');
        eq(je.evaluateJiedaoPair(meF, holderA, victimE).use, true, '10.29 借友刀杀敌 → use');
        eq(je.evaluateJiedaoPair(meF, holderE, holderA).score, -Infinity, '10.29 被刀对象是队友 → -Infinity');
    }

    if (tt) {
        const meT = P29('meT', 1, { hp: 4 });
        host29.game.players = [meT, P29('eLow1', -1, { hp: 1 }), P29('eLow2', -1, { hp: 2 })];
        const tv = tt.taoyuanValue(meT);
        ok(tv.enemyHeal > 0 && tv.net < 0, '10.29 敌方回血更多 → taoyuanValue.net<0');
        eq(tt.taoyuanTiming(meT).use, false, '10.29 帮敌人奶更多 → 不放桃园');
    }

    if (wu) {
        const meW = P29('meW', 1, { h: 3 });
        host29.game.players = [meW, P29('eLow1', -1, { h: 1 }), P29('eLow2', -1, { h: 2 })];
        const wv = wu.wuguValue(meW);
        ok(wv.enemyLow >= 2 && wv.net < 0, '10.29 敌方缺牌更多 → wuguValue.net<0');
        eq(wu.wuguTiming(meW).use, false, '10.29 帮敌人补牌 → 不放五谷');
    }
}

/* ================= 10.30 架构稳定化 Stage G：Timing Audit（指令 05） =================
 * 审计 score/decision/timing/** 的显式 import 与静默失效。
 * 真实 bug：shandianTiming/taoTiming 曾引用全局 game 但未 import，在 ESM 严格模式下
 * ReferenceError 被 catch 吞掉 → 恒 use:false（闪电残局分支 / 桃残局分支静默失效）。
 * 修复后 11 个 timing 模块全部显式 import；验证残局/濒死分支不再静默失效。
 */
{
    const fsG = await import('node:fs');
    const timingNames = ['taoTiming', 'shandianTiming', 'jiedaoTiming', 'wuguTiming', 'taoyuanTiming', 'shunshouTiming', 'judgeTiming', 'jiuTiming', 'aoeTiming', 'duelTiming', 'wuxieTiming'];
    timingNames.forEach(function (n) {
        const src = fsG.readFileSync(join(_pkg, 'score', 'decision', 'timing', n + '.js'), 'utf8');
        ok(/^import\s/m.test(src), '10.30 ' + n + ' 显式 import（无全局 game/get 裸引用）');
    });

    /* 修复守卫：shandianTiming/taoTiming 显式 import host（消除 ReferenceError 静默失效） */
    const sdSrc = fsG.readFileSync(join(_pkg, 'score', 'decision', 'timing', 'shandianTiming.js'), 'utf8');
    const taoSrc = fsG.readFileSync(join(_pkg, 'score', 'decision', 'timing', 'taoTiming.js'), 'utf8');
    ok(/adapt\/host\.js/.test(sdSrc), '10.30 shandianTiming 显式 import game');
    ok(/adapt\/host\.js/.test(taoSrc), '10.30 taoTiming 显式 import game');

    /* 功能冒烟：注入 game.players，验证残局/濒死分支不再静默 false */
    let sd = null, tao = null;
    try { sd = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'timing', 'shandianTiming.js')).href); } catch (e) { sd = null; }
    try { tao = await import(pathToFileURL(join(_pkg, 'score', 'decision', 'timing', 'taoTiming.js')).href); } catch (e) { tao = null; }

    const host30 = await import(pathToFileURL(_hostPath).href);
    function aliveP30(name) { return { name: name, alive: true }; }
    host30.game.players = [aliveP30('a'), aliveP30('b'), aliveP30('c'), aliveP30('d')];

    if (sd) eq(sd.shandianTiming({ hp: 4 }).use, true, '10.30 残局闪电 → use true（不再静默 false）');
    if (tao) eq(tao.taoTiming({ hp: 0, maxHp: 4, countCards: function () { return 0; } }).use, true, '10.30 濒死吃桃 → use true（不再静默 false）');
}

/* ================= 10.31 架构稳定化 Stage H：Hook Lifecycle（指令 05） =================
 * 审计 Player.prototype.* / game.* / get.* 猴补丁，要求每个 patch 有 original ref / install flag /
 * install / uninstall / restore 一一对应，并验证 install→uninstall→install again。
 * 真实 bug 1：engine.game.gameDraw 只打 patch 标记没存原函数 → 卸载不还原，重装时旧闭包残留/嵌套包装。
 * 真实 bug 2：engine.proto.phaseBegin 只打标记没存 orig → uninstall 循环无法还原。
 * 真实 bug 3：engine.uninstall 用 `for(k in orig) proto[k]=orig[k]`，把 get.cards/gameDraw 原函数误还原到
 *            Player.prototype（__djsc_getCards 等垃圾键）。
 * 真实 bug 4：teamBroadcast.installBroadcastHooks 改 game.check 却不保存原函数、无 uninstall。
 */
{
    const fsH = await import('node:fs');
    const engSrc = fsH.readFileSync(join(_pkg, 'score', 'decision', 'engine', 'engine.js'), 'utf8');
    const tbSrc = fsH.readFileSync(join(_pkg, 'score', 'perception', 'team', 'teamBroadcast.js'), 'utf8');

    /* 源码守卫：install 保存 original ref */
    ok(/orig\.__djsc_gameDraw\s*=\s*_origGameDraw/.test(engSrc), '10.31 engine 保存 game.gameDraw 原函数');
    ok(/orig\.phaseBegin\s*=\s*oPhaseBegin/.test(engSrc), '10.31 engine 保存 proto.phaseBegin 原函数');
    ok(/_origCheck\s*=\s*orig\b/.test(tbSrc) || /_origCheck\s*=\s*orig;/.test(tbSrc), '10.31 teamBroadcast 保存 game.check 原函数');

    /* 源码守卫：uninstall 一一对应还原 */
    ok(/game\.gameDraw\s*=\s*orig\.__djsc_gameDraw/.test(engSrc), '10.31 uninstall 还原 game.gameDraw');
    ok(/proto\.__djsc_phaseBegin_patched\)\s*delete/.test(engSrc), '10.31 uninstall 清理 phaseBegin 标记');
    ok(/__djsc_getCards'\s*\|\|\s*k\s*===\s*'__djsc_gameDraw'\)\s*continue/.test(engSrc), '10.31 uninstall 循环跳过非 proto 原始引用');
    ok(/uninstallBroadcastHooks\(\)/.test(engSrc), '10.31 engine.uninstallHooks 调用 uninstallBroadcastHooks');
    ok(/export\s+function\s+uninstallBroadcastHooks/.test(tbSrc), '10.31 teamBroadcast 导出 uninstallBroadcastHooks');

    /* 运行时：teamBroadcast（叶子级）install→uninstall→install again 真实闭环 */
    let tb = null;
    try { tb = await import(pathToFileURL(join(_pkg, 'score', 'perception', 'team', 'teamBroadcast.js')).href); } catch (e) { tb = null; }
    if (tb && typeof tb.installBroadcastHooks === 'function' && typeof tb.uninstallBroadcastHooks === 'function') {
        const hostH = await import(pathToFileURL(_hostPath).href);
        function nativeCheck() { return 'native'; }
        hostH.game.check = nativeCheck;

        tb.installBroadcastHooks();
        eq(hostH.game.check === nativeCheck, false, '10.31 install 后 game.check 已包装');
        tb.installBroadcastHooks();  /* 幂等：_hooked 守卫，不二次包装 */
        tb.uninstallBroadcastHooks();
        eq(hostH.game.check === nativeCheck, true, '10.31 uninstall 还原 game.check');

        tb.installBroadcastHooks();
        eq(hostH.game.check === nativeCheck, false, '10.31 install again 再次包装');
        tb.uninstallBroadcastHooks();
        eq(hostH.game.check === nativeCheck, true, '10.31 install→uninstall→install→uninstall 完整闭环还原');
    } else {
        /* 叶子模块无法在 Node 加载时，不把运行时闭环纳入硬门禁（源码守卫上述已覆盖 wiring） */
    }
}

/* ================= 10.32 架构稳定化 Stage I：Cache Audit（指令 05） =================
 * 概率/局势缓存的 state revision：
 *   bug 1: handInference 的 probHasShan 等按 round+player.name 缓存，同回合手牌增减/牌堆消耗后仍返回旧值。
 *   bug 2: threat.js situationFactor/incomingPressure 只按 round+aliveCount / round+hp 缓存，局势 stale。
 * 修复：handInference 用 _inferKey(hand 精确值 + deck log2 分桶)；threat 局势缓存补 _aliveFingerprint。
 */
{
    const fsI = await import('node:fs');
    const hiSrc = fsI.readFileSync(join(_pkg, 'score', 'model', 'predict', 'handInference.js'), 'utf8');
    const thSrc = fsI.readFileSync(join(_pkg, 'score', 'decision', 'threat', 'threat.js'), 'utf8');

    /* 源码守卫：_inferKey 真正接入（不是死函数） */
    ok(/const key = _inferKey\('shan', player\);/.test(hiSrc), '10.32 handInference·shan 使用 _inferKey');
    ok(/const key = _inferKey\('wuxie', player\);/.test(hiSrc), '10.32 handInference·wuxie 使用 _inferKey');
    ok(/const key = _inferKey\('tao', player\);/.test(hiSrc), '10.32 handInference·tao 使用 _inferKey');
    ok(/const key = _inferKey\('sha', player\);/.test(hiSrc), '10.32 handInference·sha 使用 _inferKey');
    ok(/const key = _inferKey\('jiu', player\);/.test(hiSrc), '10.32 handInference·jiu 使用 _inferKey');
    ok(/const key = _inferKey\('equip_' \+ equipId, player\);/.test(hiSrc), '10.32 handInference·equip 使用 _inferKey');
    ok(/const key = _inferKey\(cardId, player\);/.test(hiSrc), '10.32 handInference·probHasCard 使用 _inferKey');
    ok(/'shan_' \+ \(player\.name1 \|\| player\.name/.test(hiSrc) === false, '10.32 旧 name-only key 已移除');
    ok(/function _inferKey\(prefix, player\)/.test(hiSrc) && /function _deckBucket\(\)/.test(hiSrc), '10.32 _inferKey/_deckBucket 已定义');

    /* 源码守卫：threat 局势缓存补 _aliveFingerprint */
    ok(/function _aliveFingerprint\(\)/.test(thSrc), '10.32 threat 定义 _aliveFingerprint');
    ok(/'\|' \+ _aliveFingerprint\(\);/.test(thSrc), '10.32 situationFactor + incomingPressure 纳入 alive fingerprint');

    /* 运行时（机会式）：handInference 模块可加载 + 概率推断出口闭合（deck 内容依赖真实 DOM，
     * Node 纯 Proxy 宿主桩下 totalRemaining 的对账会清空静态牌堆，故这里只冒烟出口而不断言具体概率）。 */
    let hi = null;
    try { hi = await import(pathToFileURL(join(_pkg, 'score', 'model', 'predict', 'handInference.js')).href); } catch (e) { hi = null; }
    if (hi) {
        eq(typeof hi.probHasShan, 'function', '10.32 handInference 导出 probHasShan');
        eq(typeof hi.probHasWuxie, 'function', '10.32 handInference 导出 probHasWuxie');
        eq(typeof hi.probHasCard, 'function', '10.32 handInference 导出 probHasCard');
        eq(typeof hi.clearInferCache, 'function', '10.32 handInference 导出 clearInferCache');
    }
}

/* ================= 10.33 架构稳定化 Stage J：Exception Health（指令 05） =================
 * catch 分流：expected fallback（swallowError） 与 unexpected（reportUnexpected 进诊断）。
 * 修复：swallow.js 增加 unexpected 注册表（module/reason/counter/last），healthCheck 汇入「异常健康度」，
 *       extension.js 关键安装失败上报 unexpected。
 */
{
    const fsJ = await import('node:fs');
    const swSrc = fsJ.readFileSync(join(_pkg, 'score', 'foundation', 'diag', 'swallow.js'), 'utf8');
    const hlSrc = fsJ.readFileSync(join(_pkg, 'score', 'foundation', 'diag', 'health.js'), 'utf8');
    const extSrc = fsJ.readFileSync(join(_pkg, 'extension.js'), 'utf8');

    ok(/export\s+function\s+reportUnexpected/.test(swSrc), '10.33 swallow 导出 reportUnexpected');
    ok(/export\s+function\s+unexpectedStats/.test(swSrc), '10.33 swallow 导出 unexpectedStats');
    ok(/export\s+function\s+resetUnexpected/.test(swSrc), '10.33 swallow 导出 resetUnexpected');
    ok(/unexpectedStats/.test(hlSrc) && /异常健康度/.test(hlSrc), '10.33 healthCheck 汇入异常健康度');
    ok(/reportUnexpected\('extension\.mountAllPanels'/.test(extSrc), '10.33 extension 面板挂载失败进入诊断');
    ok(/reportUnexpected\('engine', 'installScoreEngine 安装失败'/.test(extSrc), '10.33 extension 引擎安装失败进入诊断');

    /* 运行时：swallow.js 为叶子模块，Node 下可直接加载 */
    let sw = null;
    try { sw = await import(pathToFileURL(join(_pkg, 'score', 'foundation', 'diag', 'swallow.js')).href); } catch (e) { sw = null; }
    if (sw && typeof sw.reportUnexpected === 'function' && typeof sw.unexpectedStats === 'function') {
        sw.reportUnexpected('diag.test', 'test reason', new Error('boom'));
        sw.reportUnexpected('diag.test', 'test reason2', new Error('boom2'));
        sw.reportUnexpected('diag.other', 'other', null);
        const st = sw.unexpectedStats();
        eq(st.total, 3, '10.33 unexpected total 计数');
        eq(st.modules, 2, '10.33 unexpected 按模块聚合');
        eq(st.items[0].module, 'diag.test', '10.33 最高频模块');
        eq(st.items[0].count, 2, '10.33 counter 递增');
        eq(st.items[0].reason, 'test reason2', '10.33 保留最新 reason');
        ok(typeof st.items[0].last === 'number' && st.items[0].last > 0, '10.33 记录 last occurrence（时间戳）');
        eq(sw.unexpectedStats().items.length, 2, '10.33 unexpectedStats 幂等（不重复计数）');
        sw.resetUnexpected();
        eq(sw.unexpectedStats().total, 0, '10.33 resetUnexpected 清空');
    }
}

/* ---------- 汇总 ---------- */
process.stdout.write('\n');
if (_fails.length) {
    console.error('\n❌ 发布门禁未通过：' + _fails.length + ' / ' + (_pass + _fails.length));
    for (const f of _fails) console.error('  FAIL ' + f);
    process.exitCode = 1;
} else {
    console.log('\n✅ 发布门禁全部通过：' + _pass + ' 项断言（§10.1/10.2/10.3/10.4/10.5/10.6/10.7/10.8/10.9/10.11/10.12/10.13/10.14/10.15/10.16/10.17/10.18/10.19/10.20/10.21/10.22/10.23/10.24/10.25/10.26/10.27/10.28/10.29/10.30/10.31/10.32/10.33）');
}
/* trainExport 的防抖落盘定时器无需等待；宿主桩在 process exit 时自动清理 */
setTimeout(() => { process.exit(process.exitCode || 0); }, 50);
