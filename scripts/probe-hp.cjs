'use strict';

/*
 * 机制探针 II：验证“有效生命”相关的规则推算。
 * 用法：node scripts/probe-hp.cjs
 *
 * 推算：3 血本体不拆分 → 期望挨 6 次 1 点伤害才出局；
 *       3 血本体拆分（3 个 1 血阶段）→ 期望挨 8 次；
 *       2 血本体拆分（2 个阶段）→ 期望挨 5 次左右。
 * 如果成立，“满血先拆分”就是实打实的血量增益。
 */

const { Game } = require('../js/engine.js');

function makeRng(seed = 1) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

async function newGame(rng) {
  const game = new Game({
    rng,
    io: {
      chooseCoinIntervention: async () => ({ done: true }),
      chooseTarget: async ({ options }) => options[0].id,
      pause: async () => {},
      animateRoll: async () => {}
    }
  });
  game.start(['甲', '乙'], { firstPlayer: 0 });
  return game;
}

/**
 * 统计一个实体在“每次攻击都命中”的情况下，能挨多少下 1 点伤害才出局。
 * @param {object} setup 对实体的额外设置
 */
async function survival(setup, N = 4000) {
  let total = 0;
  let died = 0;
  for (let i = 0; i < N; i += 1) {
    const game = await newGame(makeRng(i + 1));
    const body = game.players[1].body; // 被打的那个
    const attacker = game.players[0].body;
    setup(body, game);

    let hits = 0;
    while (body.alive && hits < 60) {
      // 强制每次都命中：直接调 damage，绕过判定
      await game.damage(attacker, body, 1, {});
      hits += 1;
    }
    total += hits;
    if (!body.alive) died += 1;
  }
  return { avg: total / N, died };
}

(async () => {
  const plain = await survival(() => {});
  const split3 = await survival((body) => {
    body.split = { total: 3, remaining: 3 };
    body.maxHp = 1;
    body.hp = 1;
  });
  const split2 = await survival((body) => {
    body.split = { total: 2, remaining: 2 };
    body.maxHp = 1;
    body.hp = 1;
  });
  const shield = await survival((body) => {
    body.shield = 1;
  });

  console.log(`3 血本体（不拆分）      平均挨 ${plain.avg.toFixed(2)} 下才出局（出局率 ${((plain.died / 4000) * 100).toFixed(1)}%）`);
  console.log(`3 血本体（拆成 3 阶段） 平均挨 ${split3.avg.toFixed(2)} 下才出局（出局率 ${((split3.died / 4000) * 100).toFixed(1)}%）`);
  console.log(`2 血本体（拆成 2 阶段） 平均挨 ${split2.avg.toFixed(2)} 下才出局`);
  console.log(`3 血本体（带 1 点护盾） 平均挨 ${shield.avg.toFixed(2)} 下才出局`);

  // 韧性：把伤害记下来、回合末结算一半
  const game = await newGame(makeRng(5));
  const b = game.players[1].body;
  b.tenacity = true;
  await game.damage(game.players[0].body, b, 1, {});
  console.log(`\n韧性记录 1 点后立刻结算：${b.tenacityRecord} → 结算一半 = ${Math.ceil(b.tenacityRecord / 2)}`);
})();
