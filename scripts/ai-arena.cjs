'use strict';

/*
 * 对局模拟：让不同难度的 AI 互相对打，统计胜率。
 * 用法：node scripts/ai-arena.cjs [局数] [人数]
 * 注意：引擎有大量随机判定，这里只看整体趋势，单次结果不作数。
 * 胜率噪声约 ±3.5%（400 局时），要判断“真更强”建议至少跑 400 局。
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 200);
const PLAYERS = Number(process.argv[3] || 2);

function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

/**
 * @param {number[]} levels 每个玩家的难度
 */
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
      chooseTarget: async (payload) => {
        const level = levels[payload.playerIdx];
        return AI.chooseTarget(payload.options, { level });
      },
      pause: async () => {},
      animateRoll: async () => {}
    }
  });

  const names = Array.from({ length: count }, (_, i) => `P${i + 1}`);
  game.start(names, { firstPlayer: rng() < 0.5 ? 0 : 1 });

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
  return { winner: game.winner, turns: game.turn, hp: game.players.map((p) => p.body.hp) };
}

async function run(levels) {
  const wins = new Array(levels.length).fill(0);
  let draws = 0;
  let turns = 0;
  for (let i = 0; i < ROUNDS; i += 1) {
    const result = await simulate(levels, (i + 1) * 7919);
    turns += result.turns;
    if (result.winner == null) draws += 1;
    else wins[result.winner] += 1;
  }
  return { wins, draws, turns };
}

const EASY = AI.DIFFICULTY.EASY;
const HARD = AI.DIFFICULTY.HARD;

// 对照开关：SBWAR_BASELINE=1 → 把「第 2 轮平衡」的改动关掉，同种子对比旧版本
require('./arena-baseline.cjs')();

(async () => {
  console.log(`每组 ${ROUNDS} 局，${PLAYERS} 人局`);

  if (PLAYERS === 2) {
    const mirror = await run([EASY, EASY]);
    const hardFirst = await run([HARD, EASY]);
    const easyFirst = await run([EASY, HARD]);

    const hardWins = hardFirst.wins[0] + easyFirst.wins[1];
    const easyWins = hardFirst.wins[1] + easyFirst.wins[0];
    const total = ROUNDS * 2;

    console.log(`难度 1 vs 难度 1（基准）：${mirror.wins[0]} : ${mirror.wins[1]}（应接近 1:1）`);
    console.log(`难度 2 执先手：${hardFirst.wins[0]} 胜 / ${hardFirst.wins[1]} 负（先手胜率 ${((hardFirst.wins[0] / ROUNDS) * 100).toFixed(1)}%）`);
    console.log(`难度 2 执后手：${easyFirst.wins[1]} 胜 / ${easyFirst.wins[0]} 负（后手胜率 ${((easyFirst.wins[1] / ROUNDS) * 100).toFixed(1)}%）`);
    console.log(`难度 2 vs 难度 1：${hardWins} : ${easyWins} → 难度 2 胜率 ${((hardWins / total) * 100).toFixed(1)}%`);
    console.log(`平均回合数：难度 2 先手 ${(hardFirst.turns / ROUNDS).toFixed(1)}，后手 ${(easyFirst.turns / ROUNDS).toFixed(1)}`);
  } else {
    // 多人局：难度 2 占一个位置，其余都是难度 1
    const setups = [];
    for (let slot = 0; slot < PLAYERS; slot += 1) {
      const levels = new Array(PLAYERS).fill(EASY);
      levels[slot] = HARD;
      setups.push(levels);
    }

    let hardWins = 0;
    let totalWins = 0;
    let draws = 0;
    let turns = 0;
    for (const levels of setups) {
      const result = await run(levels);
      turns += result.turns;
      draws += result.draws;
      for (let i = 0; i < PLAYERS; i += 1) {
        totalWins += result.wins[i];
        if (levels[i] === HARD) hardWins += result.wins[i];
      }
    }
    const total = ROUNDS * PLAYERS;
    console.log(`难度 2 胜 ${hardWins} / 全场胜 ${totalWins}（平局 ${draws}）→ 难度 2 胜率 ${((hardWins / total) * 100).toFixed(1)}%`);
    console.log(`平均回合数 ${(turns / (ROUNDS * PLAYERS)).toFixed(1)}`);
  }
})();
