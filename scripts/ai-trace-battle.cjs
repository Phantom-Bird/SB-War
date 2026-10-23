'use strict';

/*
 * 多人局追踪：打印每一步之后各玩家的血量与存活情况，用来定位策略问题。
 * 用法：node scripts/ai-trace-battle.cjs [局数] [人数]
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 1);
const PLAYERS = Number(process.argv[3] || 4);

function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

(async () => {
  for (let r = 0; r < ROUNDS; r += 1) {
    const rng = makeRng((r + 1) * 7919);
    const levels = new Array(PLAYERS).fill(AI.DIFFICULTY.EASY);
    levels[0] = AI.DIFFICULTY.HARD;

    const game = new Game({
      rng,
      io: {
        chooseCoinIntervention: async ({ coins, value, kind, label, roller }) => {
          for (let index = 0; index < PLAYERS; index += 1) {
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
      Array.from({ length: PLAYERS }, (_, i) => `P${i + 1}`),
      { firstPlayer: rng() < 0.5 ? 0 : 1 }
    );

    const hpLine = () =>
      game.players
        .map((p, i) => {
          const tag = levels[i] === AI.DIFFICULTY.HARD ? '*' : ' ';
          const standin = p.standin && p.standin.alive ? `+替身` : '';
          const eff = [];
          if (p.body.shield) eff.push('盾');
          if (p.body.sharpen) eff.push('磨');
          if (p.body.thorns) eff.push('甲');
          if (p.body.tenacity) eff.push('韧');
          if (p.body.hetero) eff.push('异');
          return `${tag}P${i + 1}:${p.body.alive ? p.body.hp : 'X'}${standin}[${eff.join('')}]`;
        })
        .join('  ');

    let guard = 0;
    while (!game.over && guard < 200) {
      guard += 1;
      const idx = game.current;
      const action = AI.chooseAction(game, idx, rng, { level: levels[idx] });
      const label = action ? `技能${action.skillId}` : '跳过';
      if (!action) await game.pass(idx);
      else {
        const ok = await game.act(idx, action.actorId, action.skillId);
        if (!ok && !game.over) await game.pass(idx);
      }
      console.log(`T${String(game.turn).padStart(2)} P${idx}(${levels[idx] === AI.DIFFICULTY.HARD ? '难度2' : '难度1'}) ${label.padEnd(6)} ${hpLine()}`);
    }
    console.log(`\n结束：${game.winner == null ? '平局' : `P${game.winner + 1} 获胜`}\n`);
  }
})();
