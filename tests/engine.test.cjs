'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, makeEntity } = require('../js/engine.js');

function makeGame(options = {}) {
  const {
    firstPlayer = 0,
    values = [],
    io = {},
    names = ['甲', '乙']
  } = options;

  let cursor = 0;
  const rng = () => {
    if (cursor < values.length) return values[cursor++];
    return 0.9;
  };

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

test('初始状态：3 点生命、空技能槽、随机先手可指定', () => {
  const game = makeGame({ firstPlayer: 1 });
  assert.equal(body(game, 0).hp, 3);
  assert.equal(body(game, 0).maxHp, 3);
  assert.equal(body(game, 1).hp, 3);
  assert.equal(body(game, 0).slotCap, 4);
  assert.deepEqual(body(game, 0).slots, []);
  assert.equal(game.current, 1);
  assert.equal(game.turn, 1);
});

test('普通攻击判定成功：造成 1 点伤害，不占技能槽', async () => {
  const game = makeGame({ values: [0.9] });
  await game.act(0, 'p0', 0);
  assert.equal(body(game, 1).hp, 2);
  assert.deepEqual(body(game, 0).slots, []);
  assert.equal(game.current, 1);
  assert.equal(game.turn, 2);
});

test('普通攻击判定失败：反噬自身 1 点伤害', async () => {
  const game = makeGame({ values: [0.1] });
  await game.act(0, 'p0', 0);
  assert.equal(body(game, 0).hp, 2);
  assert.equal(body(game, 1).hp, 3);
  assert.deepEqual(body(game, 0).slots, []);
  assert.deepEqual(body(game, 1).slots, []);
  assert.match(game.logs.map((l) => l.text).join('\n'), /反噬自身/);
});

test('技能判定失败：对方获得效果并占用对方技能槽', async () => {
  const game = makeGame({ values: [0.1] });
  await game.act(0, 'p0', 1);
  assert.equal(body(game, 0).sharpen, 0);
  assert.equal(body(game, 1).sharpen, 1);
  assert.deepEqual(body(game, 0).slots, []);
  assert.deepEqual(body(game, 1).slots, [1]);
});

test('四个技能槽：槽满后不能学习新技能，但可复用已记录技能与普攻', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9, 0.9] });

  await game.act(0, 'p0', 1);
  await game.pass(1);
  await game.act(0, 'p0', 2);
  await game.pass(1);
  await game.act(0, 'p0', 5);
  await game.pass(1);
  await game.act(0, 'p0', 6);

  assert.deepEqual(body(game, 0).slots, [1, 2, 5, 6]);

  const statuses = game.getSkillsFor(body(game, 0));
  assert.equal(statuses.find((s) => s.id === 7).available, false);
  assert.equal(statuses.find((s) => s.id === 7).reason, '技能槽已满');
  assert.equal(statuses.find((s) => s.id === 1).available, true);
  assert.equal(statuses.find((s) => s.id === 0).available, true);

  assert.equal(game.canUseSkill(body(game, 0), 7), false);
  assert.equal(game.canUseSkill(body(game, 0), 1), true);
  assert.equal(game.canUseSkill(body(game, 0), 0), true);
});

test('磨刀可叠加，并在下一次伤害中一并消耗', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9, 0.9] });
  const victim = body(game, 1);
  victim.hp = 10;
  victim.maxHp = 10;

  await game.act(0, 'p0', 1);
  await game.pass(1);
  await game.act(0, 'p0', 1);
  await game.pass(1);
  assert.equal(body(game, 0).sharpen, 2);

  await game.act(0, 'p0', 0);
  assert.equal(victim.hp, 7);
  assert.equal(body(game, 0).sharpen, 0);
});

test('护盾抵挡 1 点伤害，但仍会触发反甲', async () => {
  const game = makeGame({ values: [0.9] });
  const attacker = body(game, 0);
  const defender = body(game, 1);
  defender.shield = 1;
  defender.thorns = 1;

  await game.act(0, 'p0', 0);

  assert.equal(defender.hp, 3);
  assert.equal(defender.shield, 0);
  assert.equal(defender.thorns, 0);
  assert.equal(attacker.hp, 2);
});

test('反甲可被反甲触发，但每层只触发一次', async () => {
  const game = makeGame({ values: [0.9] });
  const attacker = body(game, 0);
  const defender = body(game, 1);
  attacker.thorns = 1;
  defender.thorns = 1;

  await game.act(0, 'p0', 0);

  // 甲攻击乙：乙反甲 → 甲反甲 → 乙再受到 1 点；甲也受到乙反甲的 1 点
  assert.equal(attacker.hp, 2);
  assert.equal(defender.hp, 1);
  assert.equal(attacker.thorns, 0);
  assert.equal(defender.thorns, 0);
});

test('韧性记录伤害，并在自身回合结束时结算一半（四舍五入）', async () => {
  const game = makeGame({ values: [0.9, 0.9] });

  await game.act(0, 'p0', 4);
  assert.equal(body(game, 0).tenacity, true);

  await game.act(1, 'p1', 0);
  assert.equal(body(game, 0).hp, 3);
  assert.equal(body(game, 0).tenacityRecord, 1);

  await game.pass(0);
  assert.equal(body(game, 0).hp, 2);
  assert.equal(body(game, 0).tenacity, false);
  assert.equal(body(game, 0).tenacityRecord, 0);
});

test('再次获得韧性：取消效果并立即结算全部记录伤害', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9] });

  await game.act(0, 'p0', 4);
  body(game, 1).sharpen = 1;
  await game.act(1, 'p1', 0);

  assert.equal(body(game, 0).hp, 3);
  assert.equal(body(game, 0).tenacityRecord, 2);

  await game.act(0, 'p0', 4);
  assert.equal(body(game, 0).tenacity, false);
  assert.equal(body(game, 0).hp, 1);
});

test('韧性记录的是生命值减少值：被护盾完全抵挡的伤害不计入', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  const target = body(game, 0);

  await game.act(0, 'p0', 4);
  target.shield = 1;
  await game.act(1, 'p1', 0);

  assert.equal(target.hp, 3, '护盾挡住了，生命值没减少');
  assert.equal(target.tenacityRecord, 0, '生命值没减少 → 不记录');
});

test('真实伤害也会被韧性承接并记录，回合结束时按一半结算', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9] });
  const target = body(game, 0);

  await game.act(0, 'p0', 4); // 韧性
  await game.act(1, 'p1', 10); // 异质
  await game.pass(0); // 甲跳过
  await game.act(1, 'p1', 0); // 乙普攻 → 对甲是真实伤害

  assert.equal(target.tenacity, true);
  assert.equal(target.hp, 3, '真伤被韧性承接，生命值不立刻减少');
  assert.equal(target.tenacityRecord, 1, '真伤也要记录生命值减少值');

  await game.pass(0);
  assert.equal(target.hp, 2, '回合结束时结算一半（1 点的一半向上取整）');
  assert.equal(target.tenacity, false);
});

test('韧性延迟结算的伤害按自伤处理：护盾照挡（真实伤害才会无视护盾）', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  const target = body(game, 0);

  await game.act(0, 'p0', 4);
  body(game, 1).sharpen = 2;
  await game.act(1, 'p1', 0);
  assert.equal(target.tenacityRecord, 3);

  target.shield = 1; // 结算时护盾还在
  await game.pass(0);

  assert.equal(target.hp, 2, '结算 2 点被护盾挡掉 1 点 → 实际只扣 1 点');
  assert.equal(target.shield, 0);
});

test('复活判定成功：回满生命、清除效果、释放技能槽', async () => {
  const game = makeGame({ firstPlayer: 1, values: [0.9, 0.9] });
  const target = body(game, 0);
  target.hp = 1;
  target.sharpen = 2;
  target.lucky = 1;
  target.thorns = 0;
  target.slots = [1, 2, 5];

  await game.act(1, 'p1', 0);

  assert.equal(target.hp, 3);
  assert.equal(target.maxHp, 3);
  assert.equal(target.alive, true);
  assert.equal(target.sharpen, 0);
  assert.equal(target.shield, 0);
  assert.equal(target.lucky, 0);
  assert.equal(target.thorns, 0);
  assert.deepEqual(target.slots, []);
  assert.equal(game.over, false);
});

test('负生命：先进行等量惩罚判定，全部通过后再复活', async () => {
  const game = makeGame({ firstPlayer: 1, values: [0.9, 0.9, 0.9, 0.9] });
  const target = body(game, 0);
  target.hp = 1;
  body(game, 1).sharpen = 2;

  await game.act(1, 'p1', 0);

  assert.equal(target.hp, 3);
  assert.equal(game.over, false);
  const texts = game.logs.map((l) => l.text).join('\n');
  assert.match(texts, /负生命惩罚判定 1\/2/);
  assert.match(texts, /负生命惩罚判定 2\/2/);
  assert.match(texts, /复活判定/);
});

test('负生命惩罚判定失败：游戏结束', async () => {
  const game = makeGame({ firstPlayer: 1, values: [0.9, 0.9, 0.1] });
  const target = body(game, 0);
  target.hp = 1;
  body(game, 1).sharpen = 2;

  await game.act(1, 'p1', 0);

  assert.equal(target.hp, 0);
  assert.equal(game.over, true);
  assert.equal(game.winner, 1);
});

test('拆分：阶段复活成功保住当前阶段，再次使用解除拆分', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9, 0.9] });
  const target = body(game, 0);

  await game.act(0, 'p0', 3);
  assert.equal(target.hp, 1);
  assert.equal(target.maxHp, 1);
  assert.deepEqual(target.split, { total: 3, remaining: 3 });

  await game.act(1, 'p1', 0);
  assert.equal(target.alive, true);
  assert.equal(target.hp, 1);
  assert.deepEqual(target.split, { total: 3, remaining: 3 });

  await game.act(0, 'p0', 3);
  assert.equal(target.split, null);
  assert.equal(target.maxHp, 3);
  assert.equal(target.hp, 3);
});

test('拆分：非最后阶段复活失败只失去当前阶段，不会直接失败', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.1] });
  const target = body(game, 0);

  await game.act(0, 'p0', 3);
  await game.act(1, 'p1', 0);

  assert.equal(target.alive, true);
  assert.equal(target.hp, 1);
  assert.equal(target.maxHp, 1);
  assert.deepEqual(target.split, { total: 3, remaining: 2 });
  assert.equal(game.over, false);
  assert.match(game.logs.map((l) => l.text).join('\n'), /阶段复活失败/);
});

test('拆分：连续失去所有阶段后，最后阶段失败才出局', async () => {
  const game = makeGame({ firstPlayer: 1, values: [0.9, 0.1, 0.9, 0.1, 0.9, 0.1] });
  const target = body(game, 0);
  target.hp = 1;
  target.maxHp = 1;
  target.split = { total: 3, remaining: 3 };

  await game.act(1, 'p1', 0);
  assert.deepEqual(target.split, { total: 3, remaining: 2 });
  assert.equal(game.over, false);

  await game.pass(0);
  await game.act(1, 'p1', 0);
  assert.deepEqual(target.split, { total: 3, remaining: 1 });
  assert.equal(game.over, false);

  await game.pass(0);
  await game.act(1, 'p1', 0);
  assert.equal(game.over, true);
  assert.equal(game.winner, 1);
});

test('拆分：最后阶段复活后拆分解除，生命值为 1/3', async () => {
  const game = makeGame({ firstPlayer: 1, values: [0.9, 0.9, 0.9] });
  const target = body(game, 0);
  target.hp = 1;
  target.maxHp = 1;
  target.split = { total: 1, remaining: 1 };
  target.lucky = 1;

  await game.act(1, 'p1', 0);

  assert.equal(target.hp, 1);
  assert.equal(target.maxHp, 3);
  assert.equal(target.split, null);
  assert.equal(target.lucky, 0);
  assert.match(game.logs.map((l) => l.text).join('\n'), /拆分解除/);
});

test('小偷：伤害结算后偷取并转移效果，占用技能槽', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  const thief = body(game, 0);
  const victim = body(game, 1);
  victim.lucky = 1;

  await game.act(0, 'p0', 8);
  assert.equal(thief.thief, true);
  await game.pass(1);

  await game.act(0, 'p0', 0);

  assert.equal(victim.hp, 2);
  assert.equal(victim.lucky, 0);
  assert.equal(thief.lucky, 1);
  assert.deepEqual(thief.slots, [8, 6]);
});

test('小偷：自身技能槽无法容纳时只消除效果，不转移', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  const thief = body(game, 0);
  const victim = body(game, 1);
  thief.slots = [1, 2, 5, 6];
  victim.curse = 1;

  // 小偷通过其他方式获得，避免占用槽位的前置限制
  thief.thief = true;
  thief.slots = [1, 2, 5, 6];
  await game.act(0, 'p0', 0);

  assert.equal(victim.curse, 0);
  assert.equal(thief.curse, 0);
  assert.equal(thief.hp, 3);
  assert.equal(victim.hp, 2);
});

test('召唤替身：替身独立拥有 1 HP 与 2 个技能槽，并可被攻击', async () => {
  const game = makeGame({
    values: [0.9, 0.9, 0.9, 0.1],
    io: {
      chooseTarget: async ({ options }) => {
        const standins = options.find((option) => option.kind === 'standin');
        return standins ? standins.id : options[0].id;
      }
    }
  });

  await game.act(0, 'p0', 9);
  const standin = game.players[0].standin;
  assert.ok(standin);
  assert.equal(standin.hp, 1);
  assert.equal(standin.slotCap, 2);

  await game.pass(1);
  await game.act(0, 'p0s', 1);
  assert.equal(standin.sharpen, 1);
  assert.deepEqual(standin.slots, [1]);

  await game.act(1, 'p1', 0);
  assert.equal(game.players[0].standin, null);
  assert.equal(standin.alive, false);
  assert.equal(body(game, 0).alive, true);
});

test('异质：与无异质者互相造成真实伤害，无视护盾与反甲', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  const defender = body(game, 1);
  defender.shield = 1;
  defender.thorns = 1;

  await game.act(0, 'p0', 10);
  await game.pass(1);
  await game.act(0, 'p0', 0);

  assert.equal(defender.hp, 2);
  assert.equal(defender.shield, 1);
  assert.equal(defender.thorns, 1);
  assert.equal(body(game, 0).hp, 3);
});

test('幸运币：自己的判定失败后可以重掷并覆盖结果', async () => {
  let used = false;
  let calls = 0;
  const game = makeGame({
    values: [0.1, 0.9, 0.9],
    io: {
      chooseCoinIntervention: async ({ coins }) => {
        calls += 1;
        const coin = coins.find((item) => item.coin === 'lucky');
        if (!used && coin) {
          used = true;
          return { coinId: coin.id };
        }
        return { done: true };
      }
    }
  });
  body(game, 0).lucky = 1;

  await game.act(0, 'p0', 0);

  assert.equal(calls, 1);
  assert.equal(body(game, 0).lucky, 0);
  assert.equal(body(game, 1).hp, 2);
});

test('诅咒币：对方判定成功后重掷为失败，普通攻击反噬自身', async () => {
  let used = false;
  const game = makeGame({
    firstPlayer: 1,
    values: [0.9, 0.1, 0.9],
    io: {
      chooseCoinIntervention: async ({ coins }) => {
        const coin = coins.find((item) => item.coin === 'curse');
        if (!used && coin) {
          used = true;
          return { coinId: coin.id };
        }
        return { done: true };
      }
    }
  });
  body(game, 0).curse = 1;

  await game.act(1, 'p1', 0);

  assert.equal(body(game, 0).curse, 0);
  assert.equal(body(game, 0).hp, 3);
  assert.equal(body(game, 1).hp, 2);
});

test('统计：记录造成/受到伤害、技能使用与判定结果', async () => {
  const game = makeGame({ values: [0.9] });

  await game.act(0, 'p0', 0);

  assert.equal(game.stats[0].damageDealt, 1);
  assert.equal(game.stats[1].damageTaken, 1);
  assert.equal(game.stats[0].skillsUsed, 1);
  assert.equal(game.stats[0].checks, 1);
  assert.equal(game.stats[0].successes, 1);
  assert.equal(game.stats[0].failures, 0);
});

test('技能判定失败但对方槽满：技能不生效，双方都不占槽', async () => {
  const game = makeGame({ values: [0.1] });
  body(game, 1).slots = [1, 2, 5, 6];

  await game.act(0, 'p0', 8);

  assert.equal(body(game, 0).thief, false);
  assert.deepEqual(body(game, 0).slots, []);
  assert.deepEqual(body(game, 1).slots, [1, 2, 5, 6]);
});
