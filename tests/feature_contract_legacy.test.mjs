import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// B1-F01..04: ABI guard for pre-existing v7 feature slots 112..119.
// This is intentionally NOT a new producer implementation or a semantics migration.
// Any change to these slots requires an explicit feature/schema epoch and weight compatibility review.
const featureText = readFileSync(new URL('../score/model/features/features.js', import.meta.url), 'utf8');
const weightsText = readFileSync(new URL('../score/model/weights/weights.js', import.meta.url), 'utf8');
const start = featureText.indexOf('/* 112-113:');
const end = featureText.indexOf('/* ================= 120-124:', start);
assert.ok(start >= 0 && end > start, 'feature slots section present');
const legacyBlock = featureText.slice(start, end);
const quantize = v => v <= 0 ? 0 : v >= 1 ? 127 : (v * 127) | 0;
const run = new Function('f', 'q', 'window', 'me', legacyBlock);

function evaluate(modules) {
  const result = new Int8Array(130);
  run(result, quantize, { __DJSC: modules }, { name: 'test-player' });
  return Array.from(result.slice(112,120));
}

test('B1-F01..04 existing weight ABI and indices remain stable', () => {
  assert.match(featureText, /export const FEATURE_DIM = 130;/);
  assert.match(weightsText, /const IN_DIM = 130, HID1_DIM = 128/);
  assert.match(weightsText, /const VERSION = 7;/);
  assert.match(weightsText, /const DATA_EPOCH = 2;/);
  const expected = [
    /team\.focusCount/, /team\.protectCount/,
    /mt\.r1/, /mt\.r3/, /econ\.handValue/,
    /econ\.equipValue/, /cog\.confidence/, /cog\.conflicts/,
  ];
  for(let i=0;i<8;i++) {
    assert.match(legacyBlock, new RegExp('f\\['+(112+i)+'\\]\\s*='));
    assert.match(legacyBlock, expected[i]);
  }
});

test('B1-F01..04 historical producer shapes leave slots zero: baseline, not correctness', () => {
  const legacyProviders={
    teamBroadcast: {getStatus:()=>({messageCount:4,hasFocus:true,hasNeedPeach:true})},
    multiturn: {plan:()=>({turns:3,firstTurn:'attack',aggression:0.7})},
    economy: {evaluate:()=>({cardBalance:3,damageBalance:2,efficiency:7})},
    cognitiveLog: {stats:()=>({total:4,byLevel:{high:2},byIntervention:{rule:2}})},
  };
  assert.deepEqual(evaluate(legacyProviders),Array(8).fill(0));
});

test('B1-F01..04 expected numeric fields use legacy scaling when explicitly supplied', () => {
  const matchingFields={
    teamBroadcast:{getStatus:()=>({focusCount:3,protectCount:1})},
    multiturn:{plan:()=>({r1:5,r3:5})},
    economy:{evaluate:()=>({handValue:20,equipValue:5})},
    cognitiveLog:{stats:()=>({confidence:0.5,conflicts:20})},
  };
  assert.deepEqual(evaluate(matchingFields),[127,42,127,63,127,63,63,127]);
});
