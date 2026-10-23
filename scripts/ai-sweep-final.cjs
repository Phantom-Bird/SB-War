'use strict';

/*
 * 终选对比：同一批方案在双人局和三人局里各跑一遍。
 * 用法：node scripts/ai-sweep-final.cjs [双人局数] [三人局数]
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const DUEL_ROUNDS = Number(process.argv[2] || 300);
const BATTLE_ROUNDS = Number(process.argv[3] || 120);

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

async function duel() {
  let wins = 0;
  let total = 0;
  for (let i = 0; i < DUEL_ROUNDS; i += 1) {
    const seed = (i + 1) * 7919;
    let winner = await simulate([HARD, EASY], seed);
    if (winner === 0) wins += 1;
    total += 1;
    winner = await simulate([EASY, HARD], seed);
    if (winner === 1) wins += 1;
    total += 1;
  }
  return (wins / total) * 100;
}

async function battle(players) {
  let hardWins = 0;
  let total = 0;
  for (let slot = 0; slot < players; slot += 1) {
    for (let i = 0; i < BATTLE_ROUNDS; i += 1) {
      const levels = new Array(players).fill(EASY);
      levels[slot] = HARD;
      const winner = await simulate(levels, (slot * 1000003 + i + 1) * 7919);
      total += 1;
      if (winner === slot) hardWins += 1;
    }
  }
  return (hardWins / total) * 100;
}

const BASELINE = Object.assign({}, AI.HARD_TUNE);

const VARIANTS = [
  { name: 'A 基准（已调优）', tune: {} },
  { name: 'B 总是开异质', tune: { heteroBase: 110 } },
  { name: 'C 总是异质+替身顶前', tune: { heteroBase: 110, standinActorHp: 3 } },
  { name: 'D 总是异质+异质加成', tune: { heteroBase: 110, heteroEnemyShielded: 130, heteroEnemyTenacity: 70 } }
];

(async () => {
  console.log(`双人局每方案 ${DUEL_ROUNDS * 2} 局，三人局每方案 ${BATTLE_ROUNDS * 3} 局\n`);
  console.log('方案'.padEnd(26, '　') + '双人局      三人局(基线33.3%)');
  for (const variant of VARIANTS) {
    Object.assign(AI.HARD_TUNE, BASELINE, variant.tune);
    const d = await duel();
    const b = await battle(3);
    console.log(`${variant.name.padEnd(24, '　')} ${d.toFixed(1)}%`.padEnd(34) + `${b.toFixed(1)}%`);
  }
  Object.assign(AI.HARD_TUNE, BASELINE);
})();
