# B1-F01–F04: 130-dimensional model feature ABI review (2026-11-07)

## Baseline confirmed

Comparison of `main@cd3f23f` with PR #40 found **identical Git blob SHA** for both:
- `score/model/features/features.js` — `1b77d4de2beca03135a21555f6c3f93bb575aa15`
- `score/model/weights/weights.js` — `3f3d755501e4d2fae29919b1f00068f9cc35eb38`

Thus the F01–F04 reader mismatch is **pre-existing**, not a behavior introduced by the B1–B4 restructuring. The existing network is 130→128→64→6 with weight VERSION=7 and DATA_EPOCH=2. Those identifiers validate storage structure/epoch but do **not** prove that the meaning of each input coordinate has remained consistent.

| IDs | Slots | Expected feature fields | Legacy/provider fields currently found | Decision |
|---|---|---|---|---|
| F01 | 112–113 | team focusCount / protectCount | messageCount / hasFocus / hasNeedPeach | Do not reinterpret booleans as counts |
| F02 | 114–115 | numerical r1 / r3 gains | turns / firstTurn / aggression | Do not use aggression as projected gain |
| F03 | 116–117 | handValue / equipValue | legacy evaluate: cardBalance / damageBalance / efficiency | resourceBalance provides values, but is **not** the legacy evaluate contract |
| F04 | 118–119 | confidence / conflicts | cognitionStats: total / byLevel / byLevelRate / byIntervention | No validated conflict count; legacy `Math.floor(total*0.1)` is only a guess |

## Regression evidence and limits

`tests/feature_contract_legacy.test.mjs` checks current ABI identifiers, evaluates the **actual** 112–119 extractor source block in an isolated fixture, and demonstrates both:
1. Legacy-shaped provider responses leave the slots at zero.
2. Matched numerical fields use the existing Int8 quantization/scales.

This is an explicit **baseline characterization**, **not** a fix or evidence that the current feature semantics are correct. It does not replace realistic match tests.

## Required migration gate

Before changing any of these slots:
1. Define authoritative producer APIs, numerical meaning, scale, observer visibility, missing-data policy and match reset rules for all eight features.
2. Record paired old/new feature vectors on controlled games; quantify slot-level distribution changes and impact on prediction logits/actions.
3. Introduce an **explicit feature semantic version / model-data epoch**, enforce compatibility at model load/import, and preserve the legacy behavior for old weights until migrated or retrained.
4. Add producer→integration→extractor→model tests plus a documented rollback route. Never silently reinterpret v7 weights or mutate persisted player samples.

**Current status:** F01–F04 remain OPEN for semantic remediation. For PR #40, treat these as verified baseline technical debt unless new evidence establishes a restructuring regression.
