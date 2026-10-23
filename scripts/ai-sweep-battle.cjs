'use strict';

/*
 * 多人局参数扫描：在 3 人 / 4 人局里比较不同方案。
 * 用法：node scripts/ai-sweep-battle.cjs [每方案局数] [人数]
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 120);
const PLAYERS = Number(process.argv[3] || 4);

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
  game.start(
    Array.from({ length: count }, (_, i) => `P${i + 1}`),
    { firstPlayer: rng() < 0.5 ? 0 : 1 }
  );

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

/** 难度 2 轮流坐在每个位置，统计它的胜场占比 */
async function evaluate() {
  let hardWins = 0;
  let total = 0;
  for (let slot = 0; slot < PLAYERS; slot += 1) {
    for (let i = 0; i < ROUNDS; i += 1) {
      const levels = new Array(PLAYERS).fill(EASY);
      levels[slot] = HARD;
      const winner = await simulate(levels, (slot * 1000003 + i + 1) * 7919);
      total += 1;
      if (winner === slot) hardWins += 1;
    }
  }
  return { hardWins, total, rate: (hardWins / total) * 100 };
}

const BASELINE = Object.assign({}, AI.HARD_TUNE);

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
  { name: 'A 基准（已调优）', tune: {} },
  { name: 'B 替身总是顶前面', tune: { standinActorHp: 3 } },
  { name: 'C 护盾+韧性保命', tune: { shieldBase: 70, shieldAt1Hp: 55, shieldAt2Hp: 25, tenacityBase: 34, tenacityLowHp: 30 } },
  { name: 'D 不召唤', tune: { summonBase: -100, summonEnemyNoStandin: 0 } }
];

(async () => {
  const base = 100 / PLAYERS;
  console.log(`${PLAYERS} 人局，每方案 ${ROUNDS * PLAYERS} 局（同质基线 ${base.toFixed(1)}%）\n`);
  const results = [];
  for (const variant of VARIANTS) {
    Object.assign(AI.HARD_TUNE, BASELINE, variant.tune);
    const result = await evaluate();
    results.push({ name: variant.name, rate: result.rate });
    console.log(`${variant.name.padEnd(24, '　')} 胜率 ${result.rate.toFixed(1)}%  (${result.hardWins}/${result.total})`);
  }
  Object.assign(AI.HARD_TUNE, BASELINE);
  results.sort((a, b) => b.rate - a.rate);
  console.log(`\n最好：${results[0].name} ${results[0].rate.toFixed(1)}%`);
})();
