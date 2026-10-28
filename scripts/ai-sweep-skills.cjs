'use strict';

/*
 * 平衡性调整（第 2 轮）的参数扫描：把「实战里一次都没被选中过」的那八个技能抬起来，
 * 看胜率是涨还是跌。
 *
 * 用法：node scripts/ai-sweep-skills.cjs [每方案局数] [人数] [方案名过滤]
 *
 * 所有方案共用同一批种子，方案之间的差异不会被运气干扰。
 * 每个方案额外统计难度 2 的技能使用分布——光看胜率看不出「技能到底打出来没有」。
 *
 * 说明：脚本只改 AI 的评分参数（HARD_TUNE / HARD_SCORE），不碰引擎与规则。
 */

const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 400);
const PLAYERS = Number(process.argv[3] || 2);
const FILTER = process.argv[4] || '';
/**
 * 对手画像：默认是难度 1 的默认打法（优先清替身）；
 * SBWAR_BODY_ATTACKER=1 时把难度 1 改成「永远攻击对方本体」（更聪明的打法），
 * 用来检查难度 2 的策略是不是只对笨对手有效。
 */
const BODY_ATTACKER = process.env.SBWAR_BODY_ATTACKER === '1';

const EASY = AI.DIFFICULTY.EASY;
const HARD = AI.DIFFICULTY.HARD;
const SKILL_IDS = 11;

/** 八 个「实战从没被选中」的技能：判定失败会把技能白送给对方，所以基线压得很低 */
const RISKY_IDS = [1, 3, 4, 5, 6, 7, 8, 10];

function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

async function simulate(levels, seed, usage) {
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
        if (BODY_ATTACKER && levels[payload.playerIdx] !== HARD) {
          const bodies = payload.options.find((option) => option.kind === 'body');
          if (bodies) return bodies.id;
        }
        return AI.chooseTarget(payload.options, { level: levels[payload.playerIdx] });
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
      if (levels[idx] === HARD) usage[action.skillId] += 1;
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
  let decided = 0;
  let turns = 0;
  const usage = new Array(SKILL_IDS).fill(0);
  for (let slot = 0; slot < PLAYERS; slot += 1) {
    for (let i = 0; i < ROUNDS; i += 1) {
      const levels = new Array(PLAYERS).fill(EASY);
      levels[slot] = HARD;
      const result = await simulate(levels, (slot * 1000003 + i + 1) * 7919, usage);
      total += 1;
      turns += result.turns;
      if (result.winner === slot) hardWins += 1;
      if (result.winner !== null && result.winner !== undefined) decided += 1;
    }
  }
  return {
    hardWins,
    total,
    decided,
    rate: (hardWins / total) * 100,
    // 和 scripts/ai-arena.cjs 同一个口径：把和局从分母里剔掉
    rateDecided: decided ? (hardWins / decided) * 100 : 0,
    avgTurns: turns / total,
    usage
  };
}

const BASELINE = Object.assign({}, AI.HARD_TUNE);
const BASELINE_SCORE = Object.assign({}, AI.HARD_SCORE);

const VARIANTS = [
  // —— 对照组：把这一轮改动逐项关掉，就能看出每一步各贡献了多少
  { name: 'S0 已发布基线', tune: { onlyAvailableSkills: 0, safeGiftScore: 0, safeGiftStandinScore: 0, sharpenBlockedTarget: 44 } },
  { name: 'A 只修可用性', tune: { onlyAvailableSkills: 1, safeGiftScore: 0, safeGiftStandinScore: 0, sharpenBlockedTarget: 44 } },
  // —— 安全分前沿：失败也送不到对方时，这批技能能拿到多少分
  { name: 'P92', tune: { onlyAvailableSkills: 1, safeGiftScore: 92, safeGiftStandinScore: 0, sharpenBlockedTarget: 80 } },
  { name: 'P94', tune: { onlyAvailableSkills: 1, safeGiftScore: 94, safeGiftStandinScore: 0, sharpenBlockedTarget: 80 } },
  { name: 'P96', tune: { onlyAvailableSkills: 1, safeGiftScore: 96, safeGiftStandinScore: 0, sharpenBlockedTarget: 80 } },
  { name: 'P98 定稿', tune: { onlyAvailableSkills: 1, safeGiftScore: 98, safeGiftStandinScore: 0, sharpenBlockedTarget: 80 } },
  { name: 'P100', tune: { onlyAvailableSkills: 1, safeGiftScore: 100, safeGiftStandinScore: 0, sharpenBlockedTarget: 80 } },
  // —— 对照：把「白送到对方替身」也算安全 —— 冒险技能冲到 40%，胜率明显掉
  { name: 'F 安全100+替身100', tune: { onlyAvailableSkills: 1, safeGiftScore: 100, safeGiftStandinScore: 100, sharpenBlockedTarget: 80 } }
];

const SKILL_NAMES = ['普攻', '磨刀', '护盾', '拆分', '韧性', '反甲', '幸运', '诅咒', '小偷', '召唤', '异质'];

(async () => {
  const base = 100 / PLAYERS;
  console.log(`${PLAYERS} 人局，每方案 ${ROUNDS * PLAYERS} 局（同质基线 ${base.toFixed(1)}%）`);
  console.log('技能分布只统计难度 2 的出手\n');

  const results = [];
  for (const variant of VARIANTS) {
    if (FILTER && !variant.name.includes(FILTER)) continue;
    Object.assign(AI.HARD_TUNE, BASELINE, variant.tune);
    Object.assign(AI.HARD_SCORE, BASELINE_SCORE);
    const result = await evaluate();
    const totalUsage = result.usage.reduce((a, b) => a + b, 0);
    const riskyUsage = RISKY_IDS.reduce((acc, id) => acc + result.usage[id], 0);
    const riskyShare = totalUsage ? (riskyUsage / totalUsage) * 100 : 0;
    const used = result.usage
      .map((count, id) => ({ count, id }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((item) => `${SKILL_NAMES[item.id]} ${((item.count / totalUsage) * 100).toFixed(1)}%`)
      .join(' ');
    const zeroRisky = RISKY_IDS.filter((id) => result.usage[id] === 0).map((id) => SKILL_NAMES[id]);
    results.push({
      name: variant.name,
      rate: result.rate,
      rateDecided: result.rateDecided,
      riskyShare,
      zeroRisky,
      usage: result.usage.slice()
    });
    console.log(
      `${variant.name.padEnd(22, '　')} 胜率 ${result.rate.toFixed(1)}%` +
        `（剔和局 ${result.rateDecided.toFixed(1)}%）  ` +
        `平均回合 ${result.avgTurns.toFixed(1)}  冒险技能 ${riskyShare.toFixed(1)}%  ` +
        `${zeroRisky.length ? `[没打出来: ${zeroRisky.join('/')}] ` : ''}[${used}]`
    );
  }
  Object.assign(AI.HARD_TUNE, BASELINE);
  Object.assign(AI.HARD_SCORE, BASELINE_SCORE);

  console.log('\n按胜率排序：');
  results
    .slice()
    .sort((a, b) => b.rate - a.rate)
    .forEach((item, index) => {
      console.log(
        `  ${index + 1}. ${item.name.padEnd(22, '　')} ${item.rate.toFixed(1)}%` +
          `（剔和局 ${item.rateDecided.toFixed(1)}%）  ` +
          `冒险技能 ${item.riskyShare.toFixed(1)}%` +
          `${item.zeroRisky.length ? `  没打出来: ${item.zeroRisky.join('/')}` : ''}`
      );
    });
})();
