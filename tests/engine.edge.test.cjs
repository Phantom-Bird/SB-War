'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../js/engine.js');

function makeGame(options = {}) {
  const { firstPlayer = 0, values = [], io = {}, names = ['甲', '乙'] } = options;
  let cursor = 0;
  const rng = () => (cursor < values.length ? values[cursor++] : 0.9);
  const game = new Game({
    rng,
    io: Object.assign(
      {
        chooseCoinIntervention: async () => ({ done: true }),
        chooseTarget: async ({ candidates }) => candidates[0].id
      },
      io
    )
  });
  game.start(names, { firstPlayer });
  return game;
}

const body = (game, index) => game.players[index].body;

test('幸运币可以干预复活判定：失败重掷为成功', async () => {
  let used = false;
  const game = makeGame({
    firstPlayer: 1,
    values: [0.9, 0.1, 0.9],
    io: {
      chooseCoinIntervention: async ({ coins }) => {
        const coin = coins.find((item) => item.coin === 'lucky');
        if (!used && coin) {
          used = true;
          return { coinId: coin.id };
        }
        return { done: true };
      }
    }
  });
  const target = body(game, 0);
  target.hp = 1;
  target.lucky = 1;

  await game.act(1, 'p1', 0);

  assert.equal(target.alive, true);
  assert.equal(target.hp, 3);
  assert.equal(target.lucky, 0);
  assert.equal(game.over, false);
});

test('诅咒币可以干预复活判定：成功重掷为失败', async () => {
  let used = false;
  const game = makeGame({
    firstPlayer: 1,
    values: [0.9, 0.9, 0.1],
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
  const target = body(game, 0);
  target.hp = 1;
  body(game, 1).curse = 1;

  await game.act(1, 'p1', 0);

  assert.equal(target.alive, false);
  assert.equal(game.over, true);
  assert.equal(game.winner, 1);
});

test('硬币干预一次性展示所有可用硬币，并以最后掷出的结果为准', async () => {
  const offered = [];
  let step = 0;
  const game = makeGame({
    values: [0.1, 0.9, 0.1],
    io: {
      chooseCoinIntervention: async ({ coins }) => {
        offered.push(coins.map((coin) => coin.coin));
        if (step === 0) {
          step += 1;
          return { coinId: coins.find((coin) => coin.coin === 'curse').id };
        }
        if (step === 1) {
          step += 1;
          return { coinId: coins.find((coin) => coin.coin === 'lucky').id };
        }
        return { done: true };
      }
    }
  });
  const attacker = body(game, 0);
  const defender = body(game, 1);
  attacker.lucky = 1;
  defender.curse = 1;

  await game.act(0, 'p0', 0);

  assert.deepEqual(offered[0].sort(), ['curse', 'lucky']);
  assert.deepEqual(offered[1], ['lucky']);
  assert.equal(offered.length, 2); // 硬币用尽后不再弹出空确认面板
  assert.equal(attacker.lucky, 0);
  assert.equal(defender.curse, 0);
  assert.equal(attacker.hp, 2);
  assert.equal(defender.hp, 3);
});

test('小偷转移异质时，若自身已有异质则按“再次获得”解除', async () => {
  const game = makeGame({ values: [0.9] });
  const thief = body(game, 0);
  const victim = body(game, 1);
  thief.hetero = true;
  victim.hetero = true;
  thief.thief = true;
  thief.slots = [8, 10];

  await game.act(0, 'p0', 0);

  assert.equal(victim.hetero, false);
  assert.equal(thief.hetero, false);
  assert.equal(victim.hp, 2);
});

test('替身判定失败时由对方替身承接，而不是对方本体', async () => {
  const game = makeGame({ values: [0.9, 0.1] });

  await game.act(0, 'p0', 9);
  await game.pass(1);
  game.summonStandin(body(game, 1));

  await game.act(0, 'p0s', 1);

  const own = game.players[0].standin;
  const enemy = game.players[1].standin;
  assert.equal(own.sharpen, 0);
  assert.equal(enemy.sharpen, 1);
  assert.deepEqual(enemy.slots, [1]);
  assert.deepEqual(own.slots, []);
  assert.equal(body(game, 1).sharpen, 0);
});

test('替身只有两个技能槽，槽满后不能学习第三个新技能', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9] });

  await game.act(0, 'p0', 9);
  await game.pass(1);
  await game.act(0, 'p0s', 1);
  await game.pass(1);
  await game.act(0, 'p0s', 2);

  const standin = game.players[0].standin;
  assert.deepEqual(standin.slots, [1, 2]);
  assert.equal(game.canUseSkill(standin, 5), false);
  assert.equal(game.canUseSkill(standin, 1), true);
});

test('小偷在多个效果中随机选取，并按点数决定偷取目标', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9] });
  const thief = body(game, 0);
  const victim = body(game, 1);
  victim.sharpen = 1;
  victim.curse = 1;

  await game.act(0, 'p0', 8);
  await game.pass(1);
  await game.act(0, 'p0', 0);

  // 伤害结算后随机点数为 2，偷取列表中的第二个效果：诅咒币
  assert.equal(victim.hp, 2);
  assert.equal(victim.sharpen, 1);
  assert.equal(victim.curse, 0);
  assert.equal(thief.curse, 1);
  assert.equal(thief.hp, 3);
});

test('替身普通攻击判定失败会反噬自身，不再无风险', async () => {
  const game = makeGame({ values: [0.9, 0.1, 0.1] });

  await game.act(0, 'p0', 9);
  await game.pass(1);
  const standin = game.players[0].standin;
  assert.ok(standin);

  await game.act(0, 'p0s', 0);

  assert.equal(standin.alive, false);
  assert.equal(game.players[0].standin, null);
  assert.equal(body(game, 0).hp, 3);
  assert.match(game.logs.map((l) => l.text).join('\n'), /反噬自身/);
});

test('普通攻击反噬会消耗磨刀并提高自伤', async () => {
  const game = makeGame({ values: [0.1] });
  const attacker = body(game, 0);
  attacker.sharpen = 1;

  await game.act(0, 'p0', 0);

  assert.equal(attacker.hp, 1);
  assert.equal(attacker.sharpen, 0);
});

test('普通攻击反噬会被护盾抵挡，并触发反甲打向对方', async () => {
  const game = makeGame({ values: [0.1] });
  const attacker = body(game, 0);
  attacker.shield = 1;
  attacker.thorns = 1;

  await game.act(0, 'p0', 0);

  assert.equal(attacker.hp, 3);
  assert.equal(attacker.shield, 0);
  assert.equal(attacker.thorns, 0);
  assert.equal(body(game, 1).hp, 2);
});

test('真实伤害不会消耗磨刀层数', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  const attacker = body(game, 0);
  const defender = body(game, 1);

  await game.act(0, 'p0', 10);
  await game.pass(1);
  attacker.sharpen = 1;
  await game.act(0, 'p0', 0);

  assert.equal(defender.hp, 2);
  assert.equal(attacker.sharpen, 1);
});

test('小偷在伤害结算后触发：护盾与反甲先结算', async () => {
  const game = makeGame({ values: [0.9] });
  const thief = body(game, 0);
  const victim = body(game, 1);
  thief.thief = true;
  victim.shield = 1;
  victim.thorns = 1;

  await game.act(0, 'p0', 0);

  assert.equal(victim.hp, 3);
  assert.equal(victim.shield, 0);
  assert.equal(victim.thorns, 0);
  assert.equal(thief.hp, 2);
  assert.equal(thief.thief, false);
});

test('先后手由随机数决定', () => {
  const first = new Game({ rng: () => 0.1 });
  first.start(['甲', '乙']);
  assert.equal(first.current, 0);

  const second = new Game({ rng: () => 0.9 });
  second.start(['甲', '乙']);
  assert.equal(second.current, 1);
});

test('偷取随机选择会把候选效果传给动画层', async () => {
  const stealAnimations = [];
  const game = makeGame({
    values: [0.9, 0.9, 0.9],
    io: {
      animateRoll: async (payload) => {
        if (payload.meta && payload.meta.type === 'steal') stealAnimations.push(payload);
      }
    }
  });
  const victim = body(game, 1);
  victim.sharpen = 1;
  victim.curse = 1;

  await game.act(0, 'p0', 8);
  await game.pass(1);
  await game.act(0, 'p0', 0);

  assert.equal(stealAnimations.length, 1);
  assert.deepEqual(stealAnimations[0].meta.choices, ['磨刀', '诅咒']);
  assert.equal(stealAnimations[0].value, 2);
});

test('拆分：负生命惩罚判定失败也只失去当前阶段', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.1] });
  const target = body(game, 0);

  await game.act(0, 'p0', 3);
  body(game, 1).sharpen = 2;
  await game.act(1, 'p1', 0);

  assert.equal(target.alive, true);
  assert.equal(target.hp, 1);
  assert.equal(target.maxHp, 1);
  assert.deepEqual(target.split, { total: 3, remaining: 2 });
  assert.equal(game.over, false);
  assert.match(game.logs.map((l) => l.text).join('\n'), /负生命惩罚判定失败/);
});

test('拆分：最后阶段的负生命惩罚判定失败才出局', async () => {
  const game = makeGame({ firstPlayer: 1, values: [0.9, 0.1] });
  const target = body(game, 0);
  target.hp = 1;
  target.maxHp = 1;
  target.split = { total: 3, remaining: 1 };
  body(game, 1).sharpen = 2;

  await game.act(1, 'p1', 0);

  assert.equal(game.over, true);
  assert.equal(game.winner, 1);
});

test('拆分状态下负生命：先做惩罚判定，再进入下一阶段', async () => {
  const game = makeGame({ values: [0.9, 0.9, 0.9, 0.9, 0.9] });
  const target = body(game, 0);

  await game.act(0, 'p0', 3);
  body(game, 1).sharpen = 2;
  await game.act(1, 'p1', 0);

  assert.equal(target.alive, true);
  assert.equal(target.hp, 1);
  assert.deepEqual(target.split, { total: 3, remaining: 3 });
  const texts = game.logs.map((l) => l.text).join('\n');
  assert.match(texts, /负生命惩罚判定 1\/2/);
  assert.match(texts, /负生命惩罚判定 2\/2/);
  assert.match(texts, /阶段复活成功/);
});

test('韧性记录 3 点伤害时，回合结束结算 2 点（四舍五入）', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  const target = body(game, 0);

  await game.act(0, 'p0', 4);
  body(game, 1).sharpen = 2;
  await game.act(1, 'p1', 0);
  assert.equal(target.tenacityRecord, 3);

  await game.pass(0);
  assert.equal(target.hp, 1);
  assert.equal(target.tenacity, false);
});

test('替身独立复活失败后被移除，本体继续游戏', async () => {
  const game = makeGame({
    values: [0.9, 0.9, 0.1],
    io: {
      chooseTarget: async ({ candidates }) => {
        const standin = candidates.find((c) => c.isStandin);
        return standin ? standin.id : candidates[0].id;
      }
    }
  });

  await game.act(0, 'p0', 9);
  const standin = game.players[0].standin;
  assert.ok(standin);

  await game.act(1, 'p1', 0);

  assert.equal(standin.alive, false);
  assert.equal(game.players[0].standin, null);
  assert.equal(body(game, 0).alive, true);
  assert.equal(game.over, false);
});
