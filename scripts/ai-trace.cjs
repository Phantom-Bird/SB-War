'use strict';

/*
 * 决策追踪：打印难度 2 每次出手时各选项的分数，用来定位评分异常。
 * 用法：node scripts/ai-trace.cjs [局数]
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 3);

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
    const game = new Game({
      rng,
      io: {
        chooseCoinIntervention: async () => ({ done: true }),
        chooseTarget: async ({ options }) => options[0].id,
        pause: async () => {},
        animateRoll: async () => {}
      }
    });
    game.start(['甲', '乙'], { firstPlayer: rng() < 0.5 ? 0 : 1 });

    let guard = 0;
    while (!game.over && guard < 40) {
      guard += 1;
      const idx = game.current;
      const level = idx === 0 ? AI.DIFFICULTY.HARD : AI.DIFFICULTY.EASY;
      if (idx === 0) {
        const action = AI.chooseAction(game, idx, rng, { level });
        const me = game.players[0].body;
        const foe = game.players[1].body;
        console.log(
          `T${game.turn} 我${me.hp}/${me.maxHp} 敌${foe.hp}/${foe.maxHp} ` +
            `敌替身${game.players[1].standin ? '有' : '无'} → ` +
            `技能${action ? action.skillId : 'null'}(${action && action.why ? action.why : ''})`
        );
      }
      const action = AI.chooseAction(game, idx, rng, { level });
      if (!action) await game.pass(idx);
      else {
        const ok = await game.act(idx, action.actorId, action.skillId);
        if (!ok && !game.over) await game.pass(idx);
      }
    }
    console.log('---');
  }
})();
