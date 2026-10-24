'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

function makeGame(options = {}) {
  const { firstPlayer = 0, values = [], io = {}, names = ['甲', '乙', '丙'] } = options;
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
const texts = (game) => game.logs.map((l) => l.text).join('\n');

test('多人模式可以创建 3-4 名玩家，并进入 battle 模式', () => {
  const three = makeGame({ names: ['甲', '乙', '丙'] });
  assert.equal(three.players.length, 3);
  assert.equal(three.isMultiplayer(), true);
  assert.equal(three.stats.length, 3);

  const four = makeGame({ names: ['甲', '乙', '丙', '丁'] });
  assert.equal(four.players.length, 4);
  assert.equal(four.stats.length, 4);
  assert.deepEqual(
    four.players.map((p) => p.body.id),
    ['p0', 'p1', 'p2', 'p3']
  );
});

test('双人模式保持原样：2 名玩家、duel 模式', () => {
  const game = makeGame({ names: ['甲', '乙'] });
  assert.equal(game.players.length, 2);
  assert.equal(game.isMultiplayer(), false);
  assert.equal(game.mode, 'duel');
});

test('多人模式的先后手可以在任意玩家之间决定', () => {
  const game = makeGame({ names: ['甲', '乙', '丙', '丁'], firstPlayer: 3 });
  assert.equal(game.current, 3);

  const random = new Game({ rng: () => 0.9 });
  random.start(['甲', '乙', '丙']);
  assert.equal(random.current, 2); // floor(0.9 * 3)
});

test('“对方”＝其他所有玩家：普通攻击分为“全体对手本体”和“全体对手替身”两组', async () => {
  let options = null;
  const game = makeGame({
    values: [0.9],
    io: {
      chooseTarget: async (payload) => {
        options = payload.options;
        return payload.options[0].id;
      }
    }
  });
  game.summonStandin(body(game, 2));

  await game.act(0, 'p0', 0);

  assert.deepEqual(options.map((option) => option.id), ['bodies', 'standins']);
  assert.deepEqual(options[0].entities.map((entity) => entity.id), ['p1', 'p2']);
  assert.deepEqual(options[1].entities.map((entity) => entity.id), ['p2s']);
  assert.equal(options[0].label, '全体对手本体');
  assert.equal(options[1].label, '全体对手替身');

  // 默认选中的第一组是本体组：全体对手各掉 1 点
  assert.equal(body(game, 1).hp, game.bodyMaxHp() - 1);
  assert.equal(body(game, 2).hp, game.bodyMaxHp() - 1);
  assert.equal(game.players[2].standin.hp, 1, '替身组没有被选中');
  assert.deepEqual(game.enemiesOf(0).map((e) => e.id), ['p1', 'p2', 'p2s']);
  assert.deepEqual(game.enemiesOf(2).map((e) => e.id), ['p0', 'p1']);
});

test('选择“全体对手替身”时，组内每个替身都受到伤害（替身不再复活）', async () => {
  const game = makeGame({
    values: [0.9],
    io: {
      chooseTarget: async ({ options }) => {
        const standins = options.find((option) => option.kind === 'standin');
        return standins.id;
      }
    }
  });
  game.summonStandin(body(game, 1));
  game.summonStandin(body(game, 2));

  await game.act(0, 'p0', 0);

  // 两名替身都进入复活判定：乙的复活成功，丙的复活失败被击破
  assert.equal(game.players[1].standin, null, '乙的替身被打掉');
  assert.equal(game.players[2].standin, null, '丙的替身被打掉');
  assert.equal(game.players[1].body.hp, game.bodyMaxHp(), '本体不受替身组影响');
  assert.equal(game.players[2].body.hp, game.bodyMaxHp());
  assert.equal(game.over, false);
  assert.match(texts(game), /攻击全体对手替身/);
  assert.doesNotMatch(texts(game), /复活判定/);
});

test('没有替身时只提供本体组，不再弹目标选择', async () => {
  let called = 0;
  const game = makeGame({
    values: [0.9],
    io: {
      chooseTarget: async ({ options }) => {
        called += 1;
        return options[0].id;
      }
    }
  });

  await game.act(0, 'p0', 0);

  assert.equal(called, 0);
  assert.equal(body(game, 1).hp, game.bodyMaxHp() - 1);
  assert.match(texts(game), /攻击全体对手本体/);
});

test('本体判定失败：由其他所有玩家的本体代为使用技能', async () => {
  const game = makeGame({ firstPlayer: 0, values: [0.1] });

  await game.act(0, 'p0', 1); // 磨刀判定失败

  assert.equal(game.players[0].body.sharpen, 0, '自己不算使用');
  assert.equal(game.players[1].body.sharpen, 1, '乙的本体代为使用');
  assert.equal(game.players[2].body.sharpen, 1, '丙的本体代为使用');
  assert.deepEqual(game.players[1].body.slots, [1]);
  assert.deepEqual(game.players[2].body.slots, [1]);
  assert.match(texts(game), /由 乙 代为使用【磨刀】/);
  assert.match(texts(game), /由 丙 代为使用【磨刀】/);
});

test('替身判定失败：由其他所有玩家的替身代为使用技能', async () => {
  const game = makeGame({ firstPlayer: 0, values: [0.1] });
  game.summonStandin(body(game, 0));
  game.summonStandin(body(game, 1));
  game.summonStandin(body(game, 2));

  await game.act(0, 'p0s', 1); // 替身磨刀判定失败

  assert.equal(game.players[0].standin.sharpen, 0, '自己的替身不算使用');
  assert.equal(game.players[1].standin.sharpen, 1, '乙的替身代为使用');
  assert.equal(game.players[2].standin.sharpen, 1, '丙的替身代为使用');
  assert.equal(game.players[1].body.sharpen, 0, '对方本体不承接替身的反用');
  assert.equal(game.players[2].body.sharpen, 0);
  assert.deepEqual(game.players[1].standin.slots, [1]);
  assert.deepEqual(game.players[2].standin.slots, [1]);
});

test('多人模式反用：技能槽容纳不下的玩家不会使用，其余照常', async () => {
  const game = makeGame({ firstPlayer: 0, values: [0.1] });
  body(game, 1).slots = [2, 5, 7, 9]; // 4 槽已满
  body(game, 2).slots = [1]; // 已记录磨刀，可以直接使用

  await game.act(0, 'p0', 1);

  assert.equal(game.players[1].body.sharpen, 0, '槽满的玩家无法承接');
  assert.equal(game.players[2].body.sharpen, 1, '已记录该技能的槽可以直接使用');
  assert.deepEqual(game.players[2].body.slots, [1]);
  assert.match(texts(game), /无法承接【磨刀】/);
});

test('只有自己带替身时，反噬会落空而不是转给对手本体', async () => {
  const game = makeGame({ firstPlayer: 0, values: [0.1] });
  game.summonStandin(body(game, 0));

  await game.act(0, 'p0s', 1);

  assert.equal(game.players[0].standin.sharpen, 0);
  assert.equal(game.players[1].body.sharpen, 0);
  assert.equal(game.players[2].body.sharpen, 0);
  assert.match(texts(game), /其他玩家都没有替身/);
});

test('诅咒币：其他所有玩家的诅咒币都可以干预这次随机数', async () => {
  let offered = null;
  const game = makeGame({
    values: [0.9],
    io: {
      chooseCoinIntervention: async ({ coins }) => {
        offered = coins.map((coin) => coin.id);
        return { done: true };
      }
    }
  });
  body(game, 1).curse = 1;
  body(game, 2).curse = 1;
  body(game, 0).curse = 1; // 自己的诅咒币对自己无效

  await game.act(0, 'p0', 2);

  assert.deepEqual(offered.sort(), ['p1:curse', 'p2:curse']);
});

test('自伤触发反甲时，打向其他所有玩家的本体', async () => {
  const game = makeGame({ firstPlayer: 0, values: [0.1] });
  const attacker = body(game, 0);
  attacker.shield = 1;
  attacker.thorns = 1;

  await game.act(0, 'p0', 0); // 普攻失败 → 反噬自身，护盾挡下并触发反甲

  assert.equal(attacker.hp, game.bodyMaxHp(), '护盾挡下自伤');
  assert.equal(body(game, 1).hp, game.bodyMaxHp() - 1);
  assert.equal(body(game, 2).hp, game.bodyMaxHp() - 1);
  assert.match(texts(game), /【反甲】反击 乙、丙/);
});

test('回合按玩家顺序轮转，并跳过已出局的玩家', async () => {
  const game = makeGame({ firstPlayer: 1, values: [0.9] });

  await game.pass(1);
  assert.equal(game.current, 2);
  await game.pass(2);
  assert.equal(game.current, 0);

  await game.eliminate(body(game, 0));
  assert.equal(game.over, false, '多人模式下还有两人在场，战斗继续');

  await game.pass(0);
  assert.equal(game.current, 1, '已出局的玩家不会再行动，回合交给乙');
  await game.pass(1);
  assert.equal(game.current, 2);
  await game.pass(2);
  assert.equal(game.current, 1, '轮转时跳过已出局的甲');
});

test('多人模式：只剩一名玩家时战斗才结束', async () => {
  const game = makeGame({ firstPlayer: 0, values: [0.9] });

  await game.eliminate(body(game, 1));
  assert.equal(game.over, false);
  assert.equal(game.players[1].body.alive, false);

  await game.eliminate(body(game, 2));
  assert.equal(game.over, true);
  assert.equal(game.winner, 0);
});

test('双人模式：一方出局立即结束，胜者为对手', async () => {
  const game = makeGame({ names: ['甲', '乙'], values: [0.9] });

  await game.eliminate(body(game, 1));

  assert.equal(game.over, true);
  assert.equal(game.winner, 0);
});

test('全员阵亡判平局，胜者为空', async () => {
  const game = makeGame({ values: [0.9] });

  await game.eliminate(body(game, 2));
  await game.eliminate(body(game, 1));
  assert.equal(game.winner, 0);
  await game.eliminate(body(game, 0));

  assert.equal(game.over, true);
  assert.equal(game.winner, null);
});

test('多人模式：替身被击破只损失该玩家的替身', async () => {
  const game = makeGame({
    firstPlayer: 0,
    values: [0.9, 0.1],
    io: {
      chooseTarget: async ({ options }) => {
        const standins = options.find((option) => option.kind === 'standin');
        return standins ? standins.id : options[0].id;
      }
    }
  });
  game.summonStandin(body(game, 1));

  await game.act(0, 'p0', 0);

  assert.equal(game.players[1].standin, null);
  assert.equal(body(game, 1).alive, true);
  assert.equal(game.over, false);
});

test('双人模式下反噬仍然只由唯一的对手承接', async () => {
  const game = makeGame({ names: ['甲', '乙'], firstPlayer: 0, values: [0.1] });

  await game.act(0, 'p0', 1);

  assert.equal(game.players[0].body.sharpen, 0);
  assert.equal(game.players[1].body.sharpen, 1);
});

test('AI 在多人模式下会把任意对手 1 血本体当作补刀目标', () => {
  const game = makeGame({ firstPlayer: 0 });
  body(game, 2).hp = 1;

  const action = AI.chooseAction(game, 0, () => 0.99);
  assert.deepEqual(action, { actorId: 'p0', skillId: 0 });
});

test('AI 目标组选择：有本体 1 血就集火本体，否则打掉所有替身', () => {
  const bodies = { id: 'bodies', kind: 'body', entities: [{ id: 'p1', hp: 3 }, { id: 'p2', hp: 1 }] };
  const standins = { id: 'standins', kind: 'standin', entities: [{ id: 'p2s', hp: 1 }] };

  assert.equal(AI.chooseTarget([bodies, standins]), 'bodies', '有 1 血本体时应集火本体');

  bodies.entities[1].hp = 3;
  assert.equal(AI.chooseTarget([bodies, standins]), 'standins', '没有 1 血本体时优先清替身');

  assert.equal(AI.chooseTarget([bodies]), 'bodies', '没有替身组时打本体');
  assert.equal(AI.chooseTarget([]), null);
});

test('本体生命值上限＝人数 + 1', () => {
  assert.equal(makeGame({ names: ['甲', '乙'] }).bodyMaxHp(), 3);
  assert.equal(makeGame({ names: ['甲', '乙', '丙'] }).bodyMaxHp(), 4);
  assert.equal(makeGame({ names: ['甲', '乙', '丙', '丁'] }).bodyMaxHp(), 5);

  const four = makeGame({ names: ['甲', '乙', '丙', '丁'] });
  assert.equal(four.players[0].body.maxHp, 5);
  assert.equal(four.players[0].body.hp, 5);
  assert.equal(four.players[0].standin, null);
});