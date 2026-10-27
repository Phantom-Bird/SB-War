'use strict';

/*
 * 探针：不限回合数地跑纯 AI 对局，看一局最长能打多少回合。
 *
 * 用法：node scripts/probe-max-turns.cjs [每种配置的局数]
 *
 * 做法：不改引擎，只在实例上把 drawTurnLimit() 顶掉（和局的「回合上限」分支不再触发），
 * 「全场跳过」和局仍照旧——那本来就是玩家主动收手的机制，不属于「拖太长」。
 * 另跑一组把两种和局都顶掉的，用来确认有没有永远打不完的僵局。
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 200);
const HARD = AI.DIFFICULTY.HARD;
const EASY = AI.DIFFICULTY.EASY;

/** 安全阀：超过这个行动数就认为这局卡死了 */
const SAFETY = 4000;

function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function simulate(levels, seed, options) {
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

  const names = Array.from({ length: count }, (_, i) => `P${i + 1}`);
  game.start(names, { firstPlayer: rng() < 0.5 ? 0 : 1 });

  // 顶掉「回合上限」和局；把两种和局都顶掉时连「全场跳过」也不生效
  game.drawTurnLimit = () => Number.MAX_SAFE_INTEGER;
  if (options.noDrawAtAll) {
    game.declareDraw = async () => {};
  }

  let guard = 0;
  while (!game.over && guard < SAFETY) {
    guard += 1;
    const idx = game.current;
    const action = AI.chooseAction(game, idx, rng, { level: levels[idx] });
    if (!action) await game.pass(idx);
    else {
      const ok = await game.act(idx, action.actorId, action.skillId);
      if (!ok && !game.over) await game.pass(idx);
    }
  }

  return {
    turns: game.turn,
    winner: game.winner,
    drawReason: game.drawReason,
    stuck: !game.over, // 打到安全阀还没结束 = 僵局
    levels
  };
}

async function run(levels, rounds, options) {
  const rows = [];
  for (let i = 0; i < rounds; i += 1) {
    rows.push(await simulate(levels, (i + 1) * 7919 + levels.length * 104729, options));
  }
  return rows;
}

function summarize(rows, players) {
  const turns = rows.map((r) => r.turns).sort((a, b) => a - b);
  const sum = turns.reduce((acc, n) => acc + n, 0);
  const stuck = rows.filter((r) => r.stuck).length;
  const draws = rows.filter((r) => r.winner == null && !r.stuck).length;
  const perPlayer = (n) => (n / players).toFixed(1);
  return {
    games: rows.length,
    stuck,
    draws,
    avg: (sum / rows.length).toFixed(1),
    avgPerPlayer: perPlayer(sum / rows.length),
    p50: percentile(turns, 50),
    p90: percentile(turns, 90),
    p99: percentile(turns, 99),
    max: turns[turns.length - 1],
    maxPerPlayer: perPlayer(turns[turns.length - 1]),
    top5: turns.slice(-5).reverse()
  };
}

function show(title, summary) {
  console.log(`\n【${title}】`);
  console.log(
    `  局数 ${summary.games}｜平均 ${summary.avg} 回合（人均 ${summary.avgPerPlayer}）｜` +
      `p50 ${summary.p50}｜p90 ${summary.p90}｜p99 ${summary.p99}｜最大 ${summary.max}（人均 ${summary.maxPerPlayer}）`
  );
  console.log(
    `  最长的 5 局：${summary.top5.join(' / ')}｜和局 ${summary.draws} 局｜卡死 ${summary.stuck} 局`
  );
}

(async () => {
  console.log(`每种配置 ${ROUNDS} 局（不限回合上限）`);

  const configs = [
    { title: '2 人 · 全难度 2', levels: [HARD, HARD] },
    { title: '2 人 · 全难度 1', levels: [EASY, EASY] },
    { title: '3 人 · 全难度 2', levels: [HARD, HARD, HARD] },
    { title: '4 人 · 全难度 2', levels: [HARD, HARD, HARD, HARD] }
  ];

  const unlimited = {};
  for (const config of configs) {
    const rows = await run(config.levels, ROUNDS, { noDrawAtAll: false });
    unlimited[config.title] = summarize(rows, config.levels.length);
    show(config.title, unlimited[config.title]);
  }

  // 额外确认：连「全场跳过」和局也顶掉，会不会出现永远打不完的僵局
  console.log('\n--- 连「全场跳过」和局也顶掉（检查僵局）---');
  for (const config of configs) {
    const rows = await run(config.levels, Math.max(40, Math.round(ROUNDS / 4)), { noDrawAtAll: true });
    const summary = summarize(rows, config.levels.length);
    show(`${config.title} · 无任何和局`, summary);
  }

  console.log('\n--- 汇总：各配置的最大回合数 ---');
  for (const config of configs) {
    const s = unlimited[config.title];
    console.log(
      `  ${config.title}：最大 ${s.max} 回合（人均 ${s.maxPerPlayer}），p99 ${s.p99}（人均 ${(s.p99 / config.levels.length).toFixed(1)}）`
    );
  }
})();
