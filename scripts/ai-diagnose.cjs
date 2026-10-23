'use strict';

/*
 * AI 行为诊断：统计各难度在模拟对局中的技能使用、伤害与胜负。
 * 用法：node scripts/ai-diagnose.cjs [局数] [人数]
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 200);
const PLAYERS = Number(process.argv[3] || 2);
const SKILL_NAMES = ['普攻', '磨刀', '护盾', '拆分', '韧性', '反甲', '幸运', '诅咒', '小偷', '召唤', '异质'];

function makeStats() {
  return {
    skills: new Array(11).fill(0),
    damageDealt: 0,
    damageTaken: 0,
    revives: 0,
    coins: 0,
    wins: 0,
    turns: 0,
    hpLeft: 0
  };
}

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

  const stats = [];
  for (let i = 0; i < count; i += 1) stats.push(makeStats());

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
          if (coin) {
            stats[index].coins += 1;
            return { coinId: coin.id };
          }
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

  game.start(
    Array.from({ length: count }, (_, i) => `P${i + 1}`),
    { firstPlayer: rng() < 0.5 ? 0 : 1 }
  );

  let guard = 0;
  while (!game.over && guard < 400) {
    guard += 1;
    const idx = game.current;
    const action = AI.chooseAction(game, idx, rng, { level: levels[idx] });
    stats[idx].turns += 1;
    if (!action) await game.pass(idx);
    else {
      stats[idx].skills[action.skillId] += 1;
      const ok = await game.act(idx, action.actorId, action.skillId);
      if (!ok && !game.over) await game.pass(idx);
    }
  }

  if (game.winner != null) stats[game.winner].wins += 1;
  for (let i = 0; i < count; i += 1) {
    const g = game.stats[i] || {};
    stats[i].damageDealt += g.damageDealt || 0;
    stats[i].damageTaken += g.damageTaken || 0;
    stats[i].revives += g.revives || 0;
    const body = game.players[i].body;
    stats[i].hpLeft += body && body.alive ? body.hp : 0;
  }
  return stats;
}

function describe(name, s) {
  const turns = s.turns || 1;
  const skillText = s.skills
    .map((count, id) => (count ? `${SKILL_NAMES[id]}×${count}` : null))
    .filter(Boolean)
    .join('  ');
  return (
    `${name}: 胜 ${s.wins}  回合 ${s.turns}  造成伤害 ${s.damageDealt}  受到伤害 ${s.damageTaken}  ` +
    `复活 ${s.revives}  用币 ${s.coins}  伤害/回合 ${(s.damageDealt / turns).toFixed(2)}  ` +
    `存活血量 ${(s.hpLeft / turns).toFixed(2)}\n    技能: ${skillText || '（无）'}`
  );
}

(async () => {
  const EASY = AI.DIFFICULTY.EASY;
  const HARD = AI.DIFFICULTY.HARD;

  const totals = [];
  for (let i = 0; i < PLAYERS; i += 1) totals.push(makeStats());

  for (let i = 0; i < ROUNDS; i += 1) {
    // 难度 2 固定在 0 号位，其余都是难度 1
    const levels = new Array(PLAYERS).fill(EASY);
    levels[0] = HARD;
    const result = await simulate(levels, (i + 1) * 7919);
    for (let p = 0; p < PLAYERS; p += 1) {
      for (let k = 0; k < 11; k += 1) totals[p].skills[k] += result[p].skills[k];
      totals[p].damageDealt += result[p].damageDealt;
      totals[p].damageTaken += result[p].damageTaken;
      totals[p].revives += result[p].revives;
      totals[p].coins += result[p].coins;
      totals[p].wins += result[p].wins;
      totals[p].turns += result[p].turns;
      totals[p].hpLeft += result[p].hpLeft;
    }
  }

  console.log(`\n=== ${PLAYERS} 人局，难度 2 在 0 号位（各 ${ROUNDS} 局）===`);
  for (let p = 0; p < PLAYERS; p += 1) {
    console.log(describe(p === 0 ? '难度 2' : `难度 1 #${p}`, totals[p]));
  }
  const share = ((totals[0].wins / (ROUNDS * PLAYERS)) * 100).toFixed(1);
  console.log(`\n难度 2 胜率（多人局按存活占比折算）：${share}%（完全同质时为 ${(100 / PLAYERS).toFixed(1)}%）`);
})();
