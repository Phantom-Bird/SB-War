'use strict';

/*
 * 探针：统计难度 2 的 AI 在对局中给各技能的权重。
 *
 * 用法：node scripts/probe-skill-weights.cjs [局数] [人数] [采样决策数]
 *
 * 三部分：
 *   1) 静态权重：直接从 js/ai.js 导出的 HARD_SCORE / HARD_TUNE 读，不复制逻辑，
 *      永远和实际生效的数值一致。
 *   2) 实战使用率：跑真对局，统计每个技能被选中的次数 / 可用次数。
 *   3) 实战有效权重：用二分法反推每个技能在真实局面下的「实际得分」与
 *      「距当时最佳选择的分差」。
 *
 * 第 3 部分的原理：AI 的评分是「基线 + 条件加成」的线性结构，
 * 所以把某个技能的基线调到某个值 b，它在局面中的得分就是 b + K（K 为条件加成）。
 * 用恒定 rng（返回 0.5）消掉 ±3 的随机扰动后，二分出「刚好能赢过其他选项」的 b*，
 * 就得到分差 = b* − 基线 = 当时最佳选项的得分 − 该技能的得分。
 * 全程只改 AI.HARD_TUNE 的数值并立即还原，不动引擎与 AI 的源码。
 */

const { Game, SKILLS } = require('../js/engine.js');
const AI = require('../js/ai.js');

const ROUNDS = Number(process.argv[2] || 200);
const PLAYERS = Number(process.argv[3] || 2);
const SAMPLE = Number(process.argv[4] || 200); // 参与精确测量的决策数
const HARD = AI.DIFFICULTY.HARD;

/** 每个技能的基线权重在 HARD_TUNE 里的字段名 */
const BASE_KEYS = {
  0: null, // 普通攻击：基准分不走 HARD_TUNE
  1: 'sharpenBase',
  2: 'shieldBase',
  3: 'splitBase',
  4: 'tenacityBase',
  5: 'thornsBase',
  6: 'luckyBase',
  7: 'curseBase',
  8: 'thiefBase',
  9: 'summonBase',
  10: 'heteroBase'
};

const SKILL_NAME = {};
for (const skill of SKILLS) SKILL_NAME[skill.id] = skill.name;

/** 恒定 rng：扰动项 (r - 0.5) * 6 恒为 0，测量没有随机噪声 */
const CONST_RNG = () => 0.5;

function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

function width(text) {
  let len = 0;
  for (const ch of String(text)) len += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1;
  return len;
}

function pad(text, size) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, size - width(value)));
}

/**
 * 二分出「刚好能赢过其他选项」的基线值。
 * 返回 null 表示这个技能在当前局面里压根不会被选中（例如没进 options）。
 */
function findThreshold(game, playerIdx, skillId, baseKey, baseValue) {
  const original = AI.HARD_TUNE[baseKey];
  const chosenWith = (base) => {
    AI.HARD_TUNE[baseKey] = base;
    const action = AI.chooseAction(game, playerIdx, CONST_RNG, { level: HARD });
    return Boolean(action && action.skillId === skillId);
  };

  // 下界要落在「一定选不到它」的位置（基线拉到很低 → 得分 ≤ 0 → 压根不进 options），
  // 上界落在「一定选得到」的位置。这样二分出来的就是「刚好赢过其他选项」的分界点。
  let lo = baseValue - 1000;
  let hi = baseValue + 1000;
  if (!chosenWith(hi)) {
    AI.HARD_TUNE[baseKey] = original;
    return null; // 调到这个分数还选不到它 → 该技能当前不可用
  }
  if (chosenWith(lo)) {
    AI.HARD_TUNE[baseKey] = original;
    return null; // 拉这么低还能赢 → 它本来就是无条件最优（正常不会出现）
  }
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (chosenWith(mid)) hi = mid;
    else lo = mid;
  }
  AI.HARD_TUNE[baseKey] = original;
  return hi;
}

async function simulate(levels, seed, state) {
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
  // 顶掉「回合上限」和局：否则长局会被截断，采样只来自短局，权重统计会失真
  game.drawTurnLimit = () => Number.MAX_SAFE_INTEGER;

  let guard = 0;
  while (!game.over && guard < 400) {
    guard += 1;
    const idx = game.current;
    const isHard = levels[idx] === HARD;

    let available = [];
    if (isHard) {
      const actor = AI.chooseActor(game, idx, { level: HARD });
      if (actor) {
        available = game.getSkillsFor(actor).filter((skill) => skill.available);
        for (const skill of available) state.available[skill.id] += 1;
      }
    }

    const action = AI.chooseAction(game, idx, rng, { level: levels[idx] });

    // 精确测量：只在采样到的局面上做，且不改变真实对局的行为
    if (isHard && action && state.sampled < SAMPLE) {
      state.sampled += 1;
      const measured = { chosen: action.skillId, gaps: {}, margins: [] };
      for (const skill of available) {
        const key = BASE_KEYS[skill.id];
        if (!key) continue; // 普通攻击没有基线字段
        const baseValue = AI.HARD_TUNE[key];
        const threshold = findThreshold(game, idx, skill.id, key, baseValue);
        if (threshold == null) continue;
        measured.gaps[skill.id] = threshold - baseValue;
      }
      state.gaps.push(measured);
    }

    if (!action) {
      await game.pass(idx);
    } else {
      if (isHard) state.picked[action.skillId] += 1;
      const ok = await game.act(idx, action.actorId, action.skillId);
      if (!ok && !game.over) await game.pass(idx);
    }
  }
}

(async () => {
  const levels = new Array(PLAYERS).fill(HARD);
  const state = {
    picked: new Array(11).fill(0),
    available: new Array(11).fill(0),
    gaps: [],
    sampled: 0
  };

  for (let i = 0; i < ROUNDS; i += 1) {
    await simulate(levels, (i + 1) * 7919, state);
  }

  const baseline = AI.HARD_SCORE.ATTACK_BASE;
  const decisions = state.picked.reduce((a, b) => a + b, 0);

  // —— 汇总精确测量的分差 ——
  const gapSum = new Array(11).fill(0);
  const gapCount = new Array(11).fill(0);
  const chosenMargin = [];
  for (const sample of state.gaps) {
    for (const [id, gap] of Object.entries(sample.gaps)) gapSum[id] += gap;
    for (const id of Object.keys(sample.gaps)) gapCount[id] += 1;
    // 被选中的那个技能：它的分差应当 ≤ 0（它是当时最好的）
    const own = sample.gaps[sample.chosen];
    if (own != null) chosenMargin.push(-own);
  }
  for (let id = 0; id < 11; id += 1) {
    if (gapCount[id]) gapSum[id] /= gapCount[id];
  }
  chosenMargin.sort((a, b) => a - b);

  console.log(`难度 2 纯 AI 对局：${ROUNDS} 局 × ${PLAYERS} 人（全部难度 2），共 ${decisions} 次决策`);
  console.log(`精确测量采样 ${state.gaps.length} 个决策\n`);

  console.log(
    pad('技能', 12) +
      pad('基线权重', 10) +
      pad('对普攻基准', 10) +
      pad('选中次数', 9) +
      pad('可用次数', 9) +
      pad('选择率', 9) +
      pad('每局次数', 9) +
      pad('平均分差', 10) +
      '距最佳'
  );
  console.log('-'.repeat(88));

  const rows = [];
  for (let id = 0; id < 11; id += 1) {
    const key = BASE_KEYS[id];
    const base = id === 0 ? baseline : AI.HARD_TUNE[key];
    rows.push({
      id,
      base,
      picked: state.picked[id],
      avail: state.available[id],
      gap: gapCount[id] ? gapSum[id] : null,
      share: decisions ? (state.picked[id] / decisions) * 100 : 0
    });
  }
  rows.sort((a, b) => b.picked - a.picked);

  for (const row of rows) {
    const diff = row.base - baseline;
    const gapText = row.gap == null ? '—' : (row.gap >= 0 ? `+${row.gap.toFixed(1)}` : row.gap.toFixed(1));
    console.log(
      pad(`${row.id} ${SKILL_NAME[row.id] || '?'}`, 12) +
        pad(row.base, 10) +
        pad(`${diff >= 0 ? '+' : ''}${diff}`, 10) +
        pad(row.picked, 9) +
        pad(row.avail, 9) +
        pad(`${row.avail ? ((row.picked / row.avail) * 100).toFixed(1) : '0.0'}%`, 9) +
        pad((row.picked / ROUNDS).toFixed(2), 9) +
        pad(gapText, 10) +
        '距当时最好的选择'
    );
  }

  console.log('\n【读法】');
  console.log('  基线权重：AI 评分表里该技能的起评分（普攻基准 = 100）。');
  console.log('  对普攻基准：基线权重 − 100。负得越多，默认局面下越不可能被选中。');
  console.log('  选择率：选中次数 ÷ 可用次数（真实可选面上的胜出率）。');
  console.log('  平均分差：该技能在真实局面里的得分，比「当时最好的选择」低多少分（正数=更低）。');
  console.log('            也就是把基线抬高多少分，它才能在那个局面里赢。');
  if (chosenMargin.length) {
    console.log(
      `  被选中时的领先幅度：中位 ${chosenMargin[Math.floor(chosenMargin.length / 2)].toFixed(1)} 分，` +
        `最小 ${chosenMargin[0].toFixed(1)}，最大 ${chosenMargin[chosenMargin.length - 1].toFixed(1)}。`
    );
  }
  console.log('  条件加成（对手带护盾 / 本体残血 / 对方技能槽满等）不体现在基线里，');
  console.log('  它们的作用会体现在「平均分差」和「选择率」上。');
})();
