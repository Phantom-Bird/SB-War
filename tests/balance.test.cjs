'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../js/engine.js');

/**
 * 平衡性调整后的规则回归：
 *   1. 替身不再复活（被打空直接消失）
 *   2. 本体退场 / 复活时，替身一并消散
 *   3. 群体攻击中前一个目标复活失败后，后面的目标仍要如实结算
 *   4. 有人退场时，剩余玩家的生命值上限下调
 *   5. 战报统计：最终排名、存活回合、退场顺序
 */

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

test('替身被打空后直接消失，不再进行复活判定', async () => {
  const game = makeGame({
    values: [0.9],
    io: {
      chooseTarget: async ({ options }) => {
        const standins = options.find((option) => option.kind === 'standin');
        return standins ? standins.id : options[0].id;
      }
    }
  });
  game.summonStandin(body(game, 1));

  await game.act(0, 'p0', 0);

  assert.equal(game.players[1].standin, null, '替身被打掉');
  assert.equal(body(game, 1).alive, true, '本体不受影响');
  assert.doesNotMatch(texts(game), /复活判定/, '替身不再有复活判定');
  assert.match(texts(game), /乙的替身 被消灭/);
});

test('本体退场时替身一并消散（已退场的玩家不再留在目标组里）', async () => {
  const game = makeGame({ values: [0.9, 0.1] });
  game.summonStandin(body(game, 1));
  body(game, 1).hp = 1;

  await game.act(0, 'p0', 0); // 打本体组：乙被打空 → 复活判定失败 → 退场

  assert.equal(body(game, 1).alive, false, '乙退场');
  assert.equal(game.players[1].standin, null, '乙的替身随之消散');
  assert.deepEqual(game.enemiesOf(0).map((e) => e.id), ['p2'], '乙不再出现在对手列表里');
  assert.match(texts(game), /随本体退场一同消散/);
});

test('本体复活时替身一并消散', async () => {
  const game = makeGame({ values: [0.9, 0.9] });
  game.summonStandin(body(game, 1));
  body(game, 1).hp = 1;

  await game.act(0, 'p0', 0); // 乙被打空，复活判定成功

  assert.equal(body(game, 1).alive, true, '乙复活');
  assert.equal(game.players[1].standin, null, '乙的替身随复活消散');
  assert.match(texts(game), /随本体复活一同消散/);
});

test('回归：群体攻击里第一个目标复活失败，后面的目标依然如实结算', async () => {
  const game = makeGame({ values: [0.9, 0.1] });
  const [a, b, c] = game.players;
  b.body.hp = 1; // 乙这一下会被打空，且复活判定失败
  c.body.hp = 3;
  game.summonStandin(b.body);

  await game.act(0, a.body.id, 0);

  assert.equal(b.body.alive, false, '乙退场');
  assert.equal(game.players[1].standin, null, '乙的替身不会残留');
  assert.equal(c.body.hp, 2, '丙如实掉了 1 点血');
  assert.equal(game.over, false, '战斗继续');
  assert.equal(game.current, 2, '回合正常交给丙');
  assert.equal(game.players[0].body.alive, true, '甲自己没受影响');
});

test('回归：群体攻击里第一个目标复活失败，后续目标不会少结算或多结算', async () => {
  const game = makeGame({ names: ['甲', '乙', '丙', '丁'], values: [0.9, 0.1] });
  const [a, b, c, d] = game.players;
  b.body.hp = 1;
  c.body.hp = 3;
  d.body.hp = 3;

  await game.act(0, a.body.id, 0);

  assert.equal(c.body.hp, 2, '丙掉 1 点');
  assert.equal(d.body.hp, 2, '丁掉 1 点');
  assert.equal(game.over, false);
});

test('有人退场时，剩余玩家的生命值上限下调，超出的血被削掉', async () => {
  const game = makeGame({ names: ['甲', '乙', '丙', '丁'] });
  assert.equal(game.bodyMaxHp(), 5);
  assert.equal(body(game, 0).maxHp, 5);

  await game.eliminate(body(game, 3));

  assert.equal(game.bodyMaxHp(), 4, '剩 3 人 → 上限 4');
  assert.equal(body(game, 0).maxHp, 4);
  assert.equal(body(game, 0).hp, 4, '超出上限的血被削掉');
  assert.equal(body(game, 1).maxHp, 4);

  await game.eliminate(body(game, 2));

  assert.equal(game.bodyMaxHp(), 3, '剩 2 人 → 上限 3');
  assert.equal(body(game, 0).maxHp, 3);
});

test('退场不会把还活着的人直接打死，血量只会削到新上限', async () => {
  const game = makeGame({ names: ['甲', '乙', '丙'] });
  body(game, 0).hp = 2; // 甲只剩 2 点，低于任何上限

  await game.eliminate(body(game, 2));

  assert.equal(body(game, 0).hp, 2, '血量不会被压到上限以下');
  assert.equal(body(game, 0).alive, true);
  assert.equal(body(game, 0).maxHp, 3);
});

test('拆分中的实体不因为人数变化被改写生命值上限', async () => {
  const game = makeGame({ names: ['甲', '乙', '丙'] });
  game.toggleSplit(body(game, 0));
  assert.equal(body(game, 0).maxHp, 1);

  await game.eliminate(body(game, 2));

  assert.equal(body(game, 0).maxHp, 1, '拆分期间每个阶段仍然是 1 点');
  assert.equal(body(game, 0).split.remaining, 4, '原本 4 点血，拆成 4 个阶段');

  // 解除拆分时用回当前的上限；剩余阶段数超出上限时削到上限
  game.toggleSplit(body(game, 0));
  assert.equal(body(game, 0).maxHp, 3);
  assert.equal(body(game, 0).hp, 3);
});

test('双人局的生命值上限仍然是 3，不受退场规则影响', async () => {
  const game = makeGame({ names: ['甲', '乙'] });
  assert.equal(game.bodyMaxHp(), 3);
  await game.eliminate(body(game, 1));
  assert.equal(game.over, true);
  assert.equal(body(game, 0).maxHp, 3);
});

test('战报统计：退场顺序、最终排名、存活回合', async () => {
  const game = makeGame({ names: ['甲', '乙', '丙'] });
  await game.eliminate(body(game, 1)); // 乙先退场
  await game.pass(0);
  await game.eliminate(body(game, 2)); // 丙后退场 → 甲获胜

  assert.equal(game.over, true);
  assert.equal(game.winner, 0);

  assert.deepEqual(
    game.eliminationOrder.map((item) => item.name),
    ['乙', '丙'],
    '退场顺序按时间排'
  );
  assert.equal(game.stats[1].eliminatedTurn, 1);
  assert.equal(game.stats[1].survivedTurns, 1);
  assert.equal(game.stats[2].eliminatedTurn, 2);

  const ranking = game.finalRanking();
  assert.deepEqual(ranking.map((row) => row.name), ['甲', '丙', '乙'], '胜者第一，其次是最后退场的');
  assert.deepEqual(ranking.map((row) => row.rank), [1, 2, 3]);
  assert.equal(ranking[0].survivedTurns, game.turn, '胜者活到最终');
});

test('战报统计：平局时不排名', async () => {
  const game = makeGame({ names: ['甲', '乙', '丙'] });
  await game.eliminate(body(game, 2));
  await game.eliminate(body(game, 1));
  await game.eliminate(body(game, 0));

  assert.equal(game.over, true);
  assert.equal(game.winner, null);
  assert.ok(game.finalRanking().every((row) => row.rank === null), '平局不排名');
});
