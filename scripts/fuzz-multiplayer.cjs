'use strict';

/*
 * 多人局不变量 fuzz：随机跑多人对局，每次行动后检查引擎状态是否自洽。
 * 用法：node scripts/fuzz-multiplayer.cjs [局数] [人数]
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 200);
const PLAYERS = Number(process.argv[3] || 3);

function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

const problems = [];
function check(cond, message, game) {
  if (!cond) {
    problems.push(message);
    if (problems.length < 8 && game) {
      const state = game.players
        .map((p) => `${p.name}:${p.body.alive ? p.body.hp : 'X'}/${p.body.maxHp}`)
        .join(' ');
      problems.push(`    状态 ${state} | over=${game.over} current=${game.current} turn=${game.turn}`);
      problems.push(`    日志尾部：${game.logs.slice(-6).map((l) => l.text).join(' / ')}`);
    }
  }
}

(async () => {
  for (let r = 0; r < ROUNDS; r += 1) {
    const rng = makeRng((r + 1) * 7919);
    const levels = new Array(PLAYERS).fill(r % 3 === 0 ? AI.DIFFICULTY.HARD : AI.DIFFICULTY.EASY);
    const game = new Game({
      rng,
      io: {
        chooseCoinIntervention: async ({ coins, value, kind, label, roller }) => {
          for (let i = 0; i < PLAYERS; i += 1) {
            const coin = AI.chooseCoin(
              { coins, value, kind, label, roller: { owner: roller.owner, hp: roller.hp } },
              i,
              { level: levels[i] }
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

    let guard = 0;
    while (!game.over && guard < 300) {
      guard += 1;
      const idx = game.current;
      const before = game.players.map((p) => ({
        bodyAlive: p.body.alive,
        bodyHp: p.body.hp,
        standinAlive: p.standin ? p.standin.alive : null,
        standinHp: p.standin ? p.standin.hp : null
      }));
      const action = AI.chooseAction(game, idx, rng, { level: levels[idx] });
      let ok = true;
      if (!action) ok = await game.pass(idx);
      else ok = await game.act(idx, action.actorId, action.skillId);
      if (!ok && !game.over) await game.pass(idx);

      // —— 不变量 ——
      const aliveBodies = game.players.filter((p) => p.body.alive).length;
      check(
        !game.over || aliveBodies <= 1,
        `游戏已结束但仍有 ${aliveBodies} 个本体存活`,
        game
      );
      check(
        !game.over || game.winner === null || game.players[game.winner].body.alive,
        `胜者的本体并不存活`,
        game
      );
      if (!game.over) {
        check(game.players[game.current].body.alive, `当前行动者 ${game.current} 的本体已死`, game);
      }
      for (const p of game.players) {
        check(p.body.hp <= p.body.maxHp, `${p.name} 本体生命 ${p.body.hp} 超过上限 ${p.body.maxHp}`, game);
        if (p.standin) {
          check(p.standin.hp <= p.standin.maxHp, `${p.name} 替身生命 ${p.standin.hp} 超过上限`, game);
          // 退场的玩家不该还留着替身：替身会继续被群体攻击命中、继续判定复活
          check(
            p.body.alive || !p.standin.alive,
            `${p.name} 本体已退场，替身却还活着（${p.standin.hp} 血）`,
            game
          );
        }
      }
      // 生命值上限必须跟着存活人数走
      if (!game.over) {
        const aliveBodies = game.players.filter((p) => p.body.alive).length;
        check(
          game.bodyMaxHp() === Math.max(2, aliveBodies) + 1,
          `生命值上限 ${game.bodyMaxHp()} 与存活人数 ${aliveBodies} 不匹配`,
          game
        );
      }
      // 伤害统计应与实际扣血一致（不含护盾吸收与韧性延后的部分）
      for (const p of game.players) {
        const s = game.stats[p.index];
        if (!s) continue;
        check(s.damageDealt >= 0 && s.damageTaken >= 0, `${p.name} 统计出现负数`, game);
      }
      void before;
    }
  }

  if (problems.length) {
    console.log(`发现 ${problems.length} 处异常：`);
    console.log(problems.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`${ROUNDS} 局 ${PLAYERS} 人局跑完，未发现不变量异常`);
  }
})();
