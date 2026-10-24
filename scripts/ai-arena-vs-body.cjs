'use strict';

/*
 * 对手画像对照：难度 2 面对两种不同的难度 1 打法，谁更强？
 *   A「打替身」：难度 1 的默认偏好——没有 1 血本体时优先清替身
 *   B「打本体」：把难度 1 改成永远攻击对方本体（更聪明的打法）
 * 用法：node scripts/ai-arena-vs-body.cjs [局数] [人数]
 *
 * 目的：判断难度 2 的策略是不是只在对“笨对手”过拟合。
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

async function simulate(levels, seed, hardSlot, bodyAttacker) {
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
      chooseTarget: async (payload) => {
        const slot = payload.playerIdx;
        if (slot !== hardSlot && bodyAttacker) {
          const bodies = payload.options.find((option) => option.kind === 'body');
          if (bodies) return bodies.id;
        }
        return AI.chooseTarget(payload.options, { level: levels[slot] });
      },
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
  return game.winner;
}

async function evaluate(bodyAttacker) {
  let hardWins = 0;
  let total = 0;
  for (let slot = 0; slot < PLAYERS; slot += 1) {
    for (let i = 0; i < ROUNDS; i += 1) {
      const levels = new Array(PLAYERS).fill(EASY);
      levels[slot] = HARD;
      const winner = await simulate(levels, (slot * 1000003 + i + 1) * 7919, slot, bodyAttacker);
      total += 1;
      if (winner === slot) hardWins += 1;
    }
  }
  return { hardWins, total, rate: (hardWins / total) * 100 };
}

const BASE = Object.assign({}, AI.HARD_TUNE);

const VARIANTS = [
  { name: '绝对阈值 3（本体满血也让替身上）', tune: { standinActorRelative: 0, standinActorHp: 3 } },
  { name: '相对阈值（本体满血时自己出手）', tune: { standinActorRelative: 1 } }
];

(async () => {
  const base = (100 / PLAYERS).toFixed(1);
  console.log(`${PLAYERS} 人局，每方案 ${ROUNDS * PLAYERS} 局（同质基线 ${base}%）\n`);
  for (const variant of VARIANTS) {
    Object.assign(AI.HARD_TUNE, BASE, variant.tune);
    const againstStandin = await evaluate(false);
    const againstBody = await evaluate(true);
    console.log(
      `${variant.name.padEnd(28, '　')} 对手打替身 ${againstStandin.rate.toFixed(1)}%   对手打本体 ${againstBody.rate.toFixed(1)}%`
    );
  }
  Object.assign(AI.HARD_TUNE, BASE);
})();
