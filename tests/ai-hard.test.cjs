'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const HARD = { level: AI.DIFFICULTY.HARD };
const EASY = { level: AI.DIFFICULTY.EASY };

function makeGame(options = {}) {
  const { firstPlayer = 0, values = [], io = {}, names = ['甲', '乙'] } = options;
  let cursor = 0;
  const rng = () => (cursor < values.length ? values[cursor++] : 0.9);
  const game = new Game({
    rng,
    io: Object.assign(
      {
        chooseCoinIntervention: async () => ({ done: true }),
        chooseTarget: async ({ options }) => options[0].id
      },
      io
    )
  });
  game.start(names, { firstPlayer });
  return game;
}

const body = (game, index) => game.players[index].body;

// ------------------------------------------------------------ 核心原则

test('难度 2：开局不会把回合浪费在磨刀 / 护盾这类技能上', () => {
  const game = makeGame();
  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.ok(
    action.skillId === 0 || action.skillId === 9,
    `开局只应该普攻或先召唤替身，实际用了技能 ${action.skillId}`
  );
});

test('难度 2：会优先集火对方本体组（本体才是胜负条件）', () => {
  const game = makeGame({ names: ['甲', '乙', '丙'] });
  body(game, 1).hp = 1;
  body(game, 2).hp = 3;
  game.summonStandin(body(game, 2));

  const options = [
    { id: 'bodies', kind: 'body', entities: [{ id: 'p1', isStandin: false, hp: 1 }, { id: 'p2', isStandin: false, hp: 3 }] },
    { id: 'standins', kind: 'standin', entities: [{ id: 'p2s', isStandin: true, hp: 1 }] }
  ];
  assert.equal(AI.chooseTarget(options, HARD), 'bodies', '应该集火本体组');
});

test('难度 2：没有 1 血目标时，本体组依然比替身组划算', () => {
  const options = [
    { id: 'bodies', kind: 'body', entities: [{ id: 'p1', isStandin: false, hp: 3 }] },
    { id: 'standins', kind: 'standin', entities: [{ id: 'p1s', isStandin: true, hp: 1 }] }
  ];
  assert.equal(AI.chooseTarget(options, HARD), 'bodies');
});

test('难度 2：对方本体只剩 1 血时直接普攻收割，不防御', () => {
  const game = makeGame();
  const actor = body(game, 0);
  actor.hp = 3;
  body(game, 1).hp = 1;
  game.summonStandin(body(game, 0)); // 已有替身 → 召唤不可用，只能赌这一刀

  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.equal(action.skillId, 0, '1 血本体是胜负手，应该赌这一刀');
});

test('难度 2：没有替身时先召唤，让替身去赌那一刀，本体不冒险', () => {
  const game = makeGame();
  body(game, 0).hp = 3;
  body(game, 1).hp = 1;

  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.equal(action.skillId, 9, '先召唤替身当缓冲，下一手由替身去收割');
});

test('难度 2：本体只剩 1 点时优先保命，不会硬打', () => {
  const game = makeGame();
  const actor = body(game, 0);
  actor.hp = 1;
  body(game, 1).hp = 3;

  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.equal(action.skillId, 2, '1 血时应该先上护盾');
});

test('难度 2：本体 2 点时改由替身出手，避免自伤把本体打死', () => {
  const game = makeGame();
  game.summonStandin(body(game, 0));
  body(game, 0).hp = 2;

  const actor = AI.chooseActor(game, 0, HARD);
  assert.equal(actor.id, 'p0s', '本体 2 血时应该让替身顶在前面');
});

test('难度 2：本体只剩 1 点时依然让替身行动', () => {
  const game = makeGame();
  game.summonStandin(body(game, 0));
  body(game, 0).hp = 1;

  const actor = AI.chooseActor(game, 0, HARD);
  assert.equal(actor.id, 'p0s');
});

test('难度 2：没有替身时会先召唤一个替身当缓冲', () => {
  const game = makeGame();
  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.equal(action.skillId, 9, '替身能替本体扛自伤，也能挡掉对手的群体攻击');
});

test('难度 2：对手护盾 / 韧性成堆时会用异质破防', () => {
  const game = makeGame({ names: ['甲', '乙', '丙', '丁'] });
  const actor = body(game, 0);
  actor.sharpen = 1;
  body(game, 1).shield = 1;
  body(game, 2).tenacity = true;
  body(game, 3).shield = 1;
  body(game, 1).tenacity = true;

  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.equal(action.skillId, 10, '应该用异质破防');
});

test('难度 2：不会为了磨刀浪费回合（磨刀会放大自伤）', () => {
  const game = makeGame();
  const actor = body(game, 0);
  actor.sharpen = 0;
  body(game, 1).hp = 3;

  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.notEqual(action.skillId, 1, '对面没有护盾可破，磨刀回本太慢');
});

test('难度 2：目标身上没有效果时不会开小偷', () => {
  const game = makeGame();
  const actor = body(game, 0);
  body(game, 1).hp = 3; // 干净目标

  const action = AI.chooseAction(game, 0, () => 0.99, HARD);
  assert.notEqual(action.skillId, 8, '不该浪费小偷');
});

// ------------------------------------------------------------ 硬币

test('难度 2 的硬币：复活判定失败必定用幸运币', () => {
  const lucky = { id: 'p0:lucky', playerIdx: 0, coin: 'lucky' };
  const payload = {
    kind: 'check',
    roller: { owner: 0, hp: 1 },
    label: '复活判定',
    value: 0,
    coins: [lucky]
  };
  assert.equal(AI.chooseCoin(payload, 0, HARD).id, lucky.id);
});

test('难度 2 的硬币：技能判定失败也要用幸运币（否则技能白送给对方）', () => {
  const lucky = { id: 'p0:lucky', playerIdx: 0, coin: 'lucky' };
  const payload = {
    kind: 'check',
    roller: { owner: 0, hp: 3 },
    label: '护盾判定',
    value: 0,
    coins: [lucky]
  };
  assert.equal(AI.chooseCoin(payload, 0, HARD).id, lucky.id);
});

test('难度 2 的硬币：普通攻击失败且自伤不致死时保留幸运币', () => {
  const lucky = { id: 'p0:lucky', playerIdx: 0, coin: 'lucky' };
  const payload = {
    kind: 'check',
    roller: { owner: 0, hp: 3 },
    label: '普通攻击判定',
    value: 0,
    coins: [lucky]
  };
  assert.equal(AI.chooseCoin(payload, 0, HARD), null, '不该把幸运币花在自伤 1 点上');
});

test('难度 2 的硬币：普通攻击失败且会致死时用幸运币', () => {
  const lucky = { id: 'p0:lucky', playerIdx: 0, coin: 'lucky' };
  const payload = {
    kind: 'check',
    roller: { owner: 0, hp: 1 },
    label: '普通攻击判定',
    value: 0,
    coins: [lucky]
  };
  assert.equal(AI.chooseCoin(payload, 0, HARD).id, lucky.id);
});

test('难度 2 的硬币：对手掷出成功用诅咒币压掉，对手失败则保留', () => {
  const curse = { id: 'p1:curse', playerIdx: 0, coin: 'curse' };
  const success = { kind: 'check', roller: { owner: 1, hp: 3 }, label: '复活判定', value: 1, coins: [curse] };
  const fail = { kind: 'check', roller: { owner: 1, hp: 3 }, label: '复活判定', value: 0, coins: [curse] };
  assert.equal(AI.chooseCoin(success, 0, HARD).id, curse.id);
  assert.equal(AI.chooseCoin(fail, 0, HARD), null);
});

test('难度 2 的硬币：不干预随机选择（偷取骰子）', () => {
  const curse = { id: 'p1:curse', playerIdx: 0, coin: 'curse' };
  const payload = {
    kind: 'die',
    roller: { owner: 1, hp: 3 },
    label: '乙 的小偷随机选择',
    value: 2,
    coins: [curse]
  };
  assert.equal(AI.chooseCoin(payload, 0, HARD), null);
});

test('难度 1 行为保持不变：对手成功才用诅咒币', () => {
  const curse = { id: 'p1:curse', playerIdx: 0, coin: 'curse' };
  const fail = { kind: 'check', roller: { owner: 1, hp: 3 }, label: '复活判定', value: 0, coins: [curse] };
  assert.equal(AI.chooseCoin(fail, 0, EASY), null);

  const success = { kind: 'check', roller: { owner: 1, hp: 3 }, label: '复活判定', value: 1, coins: [curse] };
  assert.equal(AI.chooseCoin(success, 0, EASY).id, curse.id);
});

test('难度 1 行为保持不变：仍然靠概率触发技能', () => {
  // 难度 1 的技能是按概率触发的，同一局面换一批随机数就会做出不同选择
  const picks = new Set();
  for (let i = 0; i < 40; i += 1) {
    const fresh = makeGame();
    body(fresh, 0).hp = 3;
    body(fresh, 1).hp = 3;
    const step = (i % 10) / 10;
    picks.add(AI.chooseAction(fresh, 0, () => step, EASY).skillId);
  }
  assert.ok(picks.size > 1, `难度 1 应该在多个技能之间随机，当前只有 ${[...picks].join(',')}`);
});

// ------------------------------------------------------------ 评估辅助

test('难度 2：威胁评估能算出"这回合大概要挨多少打"', () => {
  const game = makeGame({ names: ['甲', '乙', '丙'] });
  const actor = body(game, 0);
  const enemies = [
    { isStandin: false, alive: true, sharpen: 0 },
    { isStandin: false, alive: true, sharpen: 1 }
  ];
  const incoming = AI.estimateIncoming(actor, enemies);
  assert.ok(incoming > 1, `两个对手应该带来超过 1 点期望伤害，实际 ${incoming}`);
  assert.ok(incoming < 4, `期望伤害不该超过对手数太多，实际 ${incoming}`);
});

test('难度 2：有效生命把护盾和韧性算进去', () => {
  const game = makeGame();
  const actor = body(game, 0);
  actor.hp = 2;
  assert.equal(AI.effectiveHp(actor), 2);
  actor.shield = 1;
  assert.equal(AI.effectiveHp(actor), 3, '护盾算 1 点有效生命');
  actor.tenacity = true;
  actor.tenacityRecord = 3;
  assert.equal(AI.effectiveHp(actor), 5, '韧性记录按结算后的一半计入');
});

// ------------------------------------------------------------ 统计回归

/**
 * 跑一批对局，统计难度 2 的出手分布。
 * 这条测试锁住难度 2 的核心特征：**回合要么用来输出，要么用来召唤替身当缓冲**，
 * 不会像早期版本那样把大半回合花在磨刀 / 韧性 / 小偷这类"失败就白送对方"的技能上。
 */
const WASTE_SKILLS = [1, 4, 8, 6, 7, 3]; // 磨刀 / 韧性 / 小偷 / 幸运 / 诅咒 / 拆分

async function collectUsage(games = 24) {
  const usage = new Array(11).fill(0);
  for (let g = 0; g < games; g += 1) {
    let cursor = (g + 1) * 7919;
    const rng = () => {
      cursor = (cursor * 1664525 + 1013904223) % 4294967296;
      return cursor / 4294967296;
    };
    const game = new Game({
      rng,
      io: {
        chooseCoinIntervention: async () => ({ done: true }),
        chooseTarget: async ({ options }) => AI.chooseTarget(options, HARD),
        pause: async () => {},
        animateRoll: async () => {}
      }
    });
    game.start(['甲', '乙'], { firstPlayer: rng() < 0.5 ? 0 : 1 });

    let guard = 0;
    while (!game.over && guard < 200) {
      guard += 1;
      const idx = game.current;
      const action = AI.chooseAction(game, idx, rng, { level: idx === 0 ? HARD.level : EASY.level });
      if (!action) {
        await game.pass(idx);
        continue;
      }
      if (idx === 0) usage[action.skillId] += 1;
      const ok = await game.act(idx, action.actorId, action.skillId);
      if (!ok && !game.over) await game.pass(idx);
    }
  }
  return usage;
}

test('难度 2：绝大多数回合在普攻或召唤替身', async () => {
  const usage = await collectUsage();
  const total = usage.reduce((sum, n) => sum + n, 0);
  assert.ok(total > 100, `样本太少，只有 ${total} 次出手`);
  const outputRate = (usage[0] + usage[9]) / total;
  assert.ok(
    outputRate >= 0.8,
    `普攻+召唤占比只有 ${(outputRate * 100).toFixed(1)}%（${usage[0]}+${usage[9]}/${total}），难度 2 应该以输出为主`
  );
});

test('难度 2：不会用磨刀 / 韧性 / 小偷这类"失败就白送对方"的技能', async () => {
  const usage = await collectUsage();
  const total = usage.reduce((sum, n) => sum + n, 0);
  const waste = WASTE_SKILLS.reduce((sum, id) => sum + usage[id], 0);
  const wasteRate = waste / total;
  assert.ok(
    wasteRate <= 0.05,
    `无把握技能占比 ${(wasteRate * 100).toFixed(1)}%（${waste}/${total}），这些技能失败会把效果白送给对方`
  );
});
