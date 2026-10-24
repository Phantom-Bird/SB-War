'use strict';

/*
 * 平衡性调整后的参数扫描：在同一批随机种子上比较不同调参方案。
 * 用法：node scripts/ai-sweep-tune.cjs [每方案局数] [人数]
 *
 * 所有方案共用同一批种子，方案之间的差异不会被运气干扰。
 * 局数建议 ≥ 400，噪声约 ±2.3%（2 人局）。
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 400);
const PLAYERS = Number(process.argv[3] || 2);

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
  while (!game.over && guard < 500) {
    guard += 1;
    const idx = game.current;
    const action = AI.chooseAction(game, idx, rng, { level: levels[idx] });
    if (!action) await game.pass(idx);
    else {
      const ok = await game.act(idx, action.actorId, action.skillId);
      if (!ok && !game.over) await game.pass(idx);
    }
  }
  return { winner: game.winner, turns: game.turn };
}

/** 难度 2 轮流坐在每个位置，统计它的胜场占比 */
async function evaluate() {
  let hardWins = 0;
  let total = 0;
  let turns = 0;
  for (let slot = 0; slot < PLAYERS; slot += 1) {
    for (let i = 0; i < ROUNDS; i += 1) {
      const levels = new Array(PLAYERS).fill(EASY);
      levels[slot] = HARD;
      const result = await simulate(levels, (slot * 1000003 + i + 1) * 7919);
      total += 1;
      turns += result.turns;
      if (result.winner === slot) hardWins += 1;
    }
  }
  return { hardWins, total, rate: (hardWins / total) * 100, avgTurns: turns / total };
}

const BASELINE = Object.assign({}, AI.HARD_TUNE);
const BASELINE_SCORE = Object.assign({}, AI.HARD_SCORE);

const VARIANTS = [
  { name: 'A 当前参数', tune: {}, score: {} },
  { name: 'B 召唤120+顶3', tune: { summonBase: 120, standinActorHp: 3 }, score: {} },
  { name: 'C 召唤105+顶3', tune: { summonBase: 105, standinActorHp: 3 }, score: {} },
  { name: 'D 召唤130+顶3', tune: { summonBase: 130, standinActorHp: 3 }, score: {} },
  { name: 'E 召唤145+顶2', tune: { summonBase: 145, standinActorHp: 2 }, score: {} },
  { name: 'F 收割权重80', tune: {}, score: { KILL_BODY: 80 } },
  { name: 'G 收割权重80+召唤120', tune: { summonBase: 120 }, score: { KILL_BODY: 80 } },
  { name: 'H 异质100', tune: { heteroEnemyShielded: 100 }, score: {} },
  { name: 'I 护盾80/65', tune: { shieldBase: 80, shieldAt1Hp: 65 }, score: {} },
  { name: 'J 幸运62', tune: { luckyBase: 62 }, score: {} }
];

(async () => {
  const base = 100 / PLAYERS;
  console.log(`${PLAYERS} 人局，每方案 ${ROUNDS * PLAYERS} 局（同质基线 ${base.toFixed(1)}%）\n`);
  const results = [];
  for (const variant of VARIANTS) {
    Object.assign(AI.HARD_TUNE, BASELINE, variant.tune);
    Object.assign(AI.HARD_SCORE, BASELINE_SCORE, variant.score || {});
    const result = await evaluate();
    results.push({ name: variant.name, rate: result.rate });
    console.log(`${variant.name.padEnd(22, '　')} 胜率 ${result.rate.toFixed(1)}%  (${result.hardWins}/${result.total})  平均回合 ${result.avgTurns.toFixed(1)}`);
  }
  Object.assign(AI.HARD_TUNE, BASELINE);
  Object.assign(AI.HARD_SCORE, BASELINE_SCORE);
  results.sort((a, b) => b.rate - a.rate);
  console.log(`\n最好：${results[0].name} ${results[0].rate.toFixed(1)}%`);
})();
