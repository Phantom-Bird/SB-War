'use strict';

/*
 * 参数扫描：对同一批随机种子，逐一验证不同调参方案的双人局胜率。
 * 用法：node scripts/ai-sweep.cjs [局数] [批次数]
 *
 * 所有方案共用同一批种子，所以方案之间的差异不会被运气干扰；
 * 局数建议 ≥ 400，噪声约 ±2.3%。
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 200);
const BATCHES = Number(process.argv[3] || 2);

const EASY = AI.DIFFICULTY.EASY;
const HARD = AI.DIFFICULTY.HARD;

function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

async function simulate(levels, seed) {
  const rng = makeRng(seed);
  const count = levels.length;
  const game = new Game({
    rng,
    io: {
      chooseCoinIntervention: async ({ coins, value, kind, label, roller }) => {
        for (let index = 0; index < count; index += 1) {
          const coin = AI.chooseCoin(
            { coins, value, kind, label, roller: { owner: roller.owner, hp: roller.hp } },
            index,
            { level: levels[index] }
          );
          if (coin) return { coinId: coin.id };
        }
        return { done: true };
      },
      chooseTarget: async (payload) => AI.chooseTarget(payload.options, { level: levels[payload.playerIdx] }),
      pause: async () => {},
      animateRoll: async () => {}
    }
  });
  game.start(['甲', '乙'], { firstPlayer: rng() < 0.5 ? 0 : 1 });

  let guard = 0;
  while (!game.over && guard < 400) {
    guard += 1;
    const idx = game.current;
    const action = AI.chooseAction(game, idx, rng, { level: levels[idx] });
    if (!action) await game.pass(idx);
    else {
      const ok = await game.act(idx, action.actorId, action.skillId);
      if (!ok && !game.over) await game.pass(idx);
    }
  }
  return game.winner;
}

async function evaluate() {
  let wins = 0;
  let total = 0;
  for (let batch = 0; batch < BATCHES; batch += 1) {
    for (let i = 0; i < ROUNDS; i += 1) {
      const seed = (batch * 1000003 + i + 1) * 7919;
      let winner = await simulate([HARD, EASY], seed);
      if (winner === 0) wins += 1;
      total += 1;
      winner = await simulate([EASY, HARD], seed);
      if (winner === 1) wins += 1;
      total += 1;
    }
  }
  return { wins, total, rate: (wins / total) * 100 };
}

const BASELINE = Object.assign({}, AI.HARD_TUNE);

/** 关掉所有技能的写法 */
const NO_SKILL = {
  shieldBase: -100, shieldAt1Hp: 0, shieldAt2Hp: 0, shieldEnemyAt1Hp: 0, shieldEnemyAt2Hp: 0, shieldEnemyShielded: 0,
  sharpenBase: -100, sharpenBlockedTarget: 0, sharpenGiftFizzle: 0, sharpenLowHp: 0,
  tenacityBase: -100, tenacityLowHp: 0, tenacityEnemySharpen: 0, tenacityGiftFizzle: 0, tenacityEnemyAt1Hp: 0,
  thornsBase: -100, thornsWithAttack: 0, thornsEnemyShielded: 0, thornsGiftFizzle: 0, thornsEnemyLowHp: 0,
  thiefBase: -100, thiefTargetHasEffects: 0, thiefGiftFizzle: 0,
  heteroBase: -100, heteroEnemyShielded: 0, heteroEnemyTenacity: 0, heteroEnemyHasHetero: 0, heteroGiftFizzle: 0,
  luckyBase: -100, luckyLowHp: 0, luckyGiftFizzle: 0,
  curseBase: -100, curseEnemyStealable: 0, curseGiftFizzle: 0,
  splitBase: -100, splitFullHp: 0, splitEnemySharpen: 0, splitGiftFizzle: 0,
  summonBase: -100, summonEnemyNoStandin: 0
};

const VARIANTS = [
  { name: '基准（当前参数）', tune: {} },
  { name: '纯普攻', tune: NO_SKILL },
  { name: '纯普攻+1血护盾', tune: Object.assign({}, NO_SKILL, { shieldBase: 62, shieldAt1Hp: 44 }) },
  { name: '纯普攻+囤幸运币', tune: Object.assign({}, NO_SKILL, { luckyBase: 95, luckyLowHp: 0 }) },
  { name: '纯普攻+囤诅咒币', tune: Object.assign({}, NO_SKILL, { curseBase: 95, curseEnemyStealable: 0 }) },
  { name: '纯普攻+幸运&诅咒', tune: Object.assign({}, NO_SKILL, { luckyBase: 95, curseBase: 95 }) },
  { name: '纯普攻+破盾异质', tune: Object.assign({}, NO_SKILL, { heteroBase: 24, heteroEnemyShielded: 58 }) },
  { name: '纯普攻+满血拆分', tune: Object.assign({}, NO_SKILL, { splitBase: 24, splitFullHp: 90 }) },
  { name: '纯普攻+反甲', tune: Object.assign({}, NO_SKILL, { thornsBase: 34, thornsWithAttack: 24 }) },
  { name: '纯普攻+小偷', tune: Object.assign({}, NO_SKILL, { thiefBase: 28, thiefTargetHasEffects: 48 }) },
  { name: '纯普攻+韧性', tune: Object.assign({}, NO_SKILL, { tenacityBase: 30, tenacityLowHp: 26 }) },
  { name: '纯普攻+磨刀', tune: Object.assign({}, NO_SKILL, { sharpenBase: 26, sharpenBlockedTarget: 44 }) },
  { name: '纯普攻+召唤', tune: Object.assign({}, NO_SKILL, { summonBase: 22, summonEnemyNoStandin: 20 }) },
  { name: '普攻失败也用幸运币', tune: { luckyOnAttackFailure: 1 } },
  { name: '诅咒压对手普攻', tune: { curseOnEnemyAttack: 1 } },
  { name: '不压对手技能', tune: { curseOnEnemySkill: 0 } },
  { name: '不压对手复活', tune: { curseOnEnemyRevive: 0 } },
  { name: '纯普攻+攻击失败用幸运币', tune: Object.assign({}, NO_SKILL, { luckyOnAttackFailure: 1 }) },
  { name: '纯普攻+幸运&诅咒+破盾', tune: Object.assign({}, NO_SKILL, {
      luckyBase: 95, curseBase: 95, heteroBase: 24, heteroEnemyShielded: 58
    }) }
];

(async () => {
  console.log(`每方案 ${ROUNDS * BATCHES * 2} 局（${BATCHES} 批种子 × 先手/后手）\n`);
  const results = [];
  for (const variant of VARIANTS) {
    Object.assign(AI.HARD_TUNE, BASELINE, variant.tune);
    const result = await evaluate();
    results.push({ name: variant.name, rate: result.rate });
    console.log(`${variant.name.padEnd(24, '　')} 胜率 ${result.rate.toFixed(1)}%  (${result.wins}/${result.total})`);
  }
  Object.assign(AI.HARD_TUNE, BASELINE);
  results.sort((a, b) => b.rate - a.rate);
  console.log(`\n最好：${results[0].name} ${results[0].rate.toFixed(1)}%`);
})();
