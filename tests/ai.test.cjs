'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

function makeGame() {
  const game = new Game({ rng: () => 0.9 });
  game.start(['电脑', '人类'], { firstPlayer: 0 });
  return game;
}

const body = (game, index) => game.players[index].body;

test('AI 本体危险时优先让替身行动', () => {
  const game = makeGame();
  game.summonStandin(body(game, 0));
  body(game, 0).hp = 1;

  const actor = AI.chooseActor(game, 0);
  assert.equal(actor.id, 'p0s');
});

test('AI 濒死时会优先使用护盾', () => {
  const game = makeGame();
  body(game, 0).hp = 1;

  const action = AI.chooseAction(game, 0, () => 0.99);
  assert.deepEqual(action, { actorId: 'p0', skillId: 2 });
});

test('AI 会在对方本体 1 血时使用普通攻击', () => {
  const game = makeGame();
  body(game, 1).hp = 1;

  const action = AI.chooseAction(game, 0, () => 0.99);
  assert.deepEqual(action, { actorId: 'p0', skillId: 0 });
});

test('AI 在无事可做时兜底普通攻击', () => {
  const game = makeGame();

  const action = AI.chooseAction(game, 0, () => 0.99);
  assert.deepEqual(action, { actorId: 'p0', skillId: 0 });
});

test('AI 会尽早召唤替身', () => {
  const game = makeGame();

  const action = AI.chooseAction(game, 0, () => 0);
  assert.deepEqual(action, { actorId: 'p0', skillId: 9 });
});

test('AI 目标组选择：优先集火 1 血本体，否则清掉所有替身', () => {
  const bodies = { id: 'bodies', kind: 'body', entities: [{ id: 'body', hp: 1 }] };
  const standins = { id: 'standins', kind: 'standin', entities: [{ id: 'standin', hp: 1 }] };

  assert.equal(AI.chooseTarget([bodies, standins]), 'bodies');

  bodies.entities[0].hp = 3;
  assert.equal(AI.chooseTarget([bodies, standins]), 'standins');
  assert.equal(AI.chooseTarget([bodies]), 'bodies');
  assert.equal(AI.chooseTarget(null), null);
});

test('AI 硬币策略：自己失败用幸运币，对方成功用诅咒币', () => {
  const lucky = { id: 'p0:lucky', playerIdx: 0, coin: 'lucky' };
  const curse = { id: 'p0:curse', playerIdx: 0, coin: 'curse' };

  assert.equal(
    AI.chooseCoin({ kind: 'check', roller: { owner: 0 }, value: 0, coins: [lucky] }, 0).id,
    lucky.id
  );

  assert.equal(
    AI.chooseCoin({ kind: 'check', roller: { owner: 1 }, value: 1, coins: [curse] }, 0).id,
    curse.id
  );

  assert.equal(AI.chooseCoin({ kind: 'check', roller: { owner: 0 }, value: 1, coins: [lucky] }, 0), null);
  assert.equal(AI.chooseCoin({ kind: 'check', roller: { owner: 1 }, value: 0, coins: [curse] }, 0), null);
  assert.equal(AI.chooseCoin({ kind: 'die', roller: { owner: 0 }, value: 2, coins: [lucky] }, 0), null);
});
