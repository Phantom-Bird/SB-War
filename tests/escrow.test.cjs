'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../js/engine.js');

/**
 * 硬币托管（可选功能，默认关闭）：
 *   · 自己投出 1（判定成功）→ 弃权幸运币
 *   · 自己投出 0（判定失败）→ 自动用幸运币救回
 *   · 对方投出 1（判定成功）→ 自动用诅咒币压掉
 *   · 对方投出 0（判定失败）→ 弃权诅咒币
 *   · 非判定（骰子，如偷取随机选择）→ 一律弃权
 * 托管玩家不再弹硬币确认面板，结算顺序为
 * 「自己的托管幸运币 → 手动面板 → 托管诅咒币收尾」，
 * 保证托管的诅咒币作用在**最终判定值**上。
 */

function makeGame(options = {}) {
  const {
    firstPlayer = 0,
    values = [],
    names = ['甲', '乙'],
    escrowCoins = [],
    io = {}
  } = options;
  let cursor = 0;
  // rng < 0.5 → 判定失败（0）；rng >= 0.5 → 判定成功（1）
  const rng = () => (cursor < values.length ? values[cursor++] : 0.9);
  const calls = [];
  const game = new Game({
    rng,
    io: Object.assign(
      {
        chooseCoinIntervention: async (payload) => {
          calls.push(payload);
          return { done: true };
        },
        chooseTarget: async ({ options }) => options[0].id
      },
      io
    )
  });
  game.start(names, { firstPlayer, escrowCoins });
  return { game, calls };
}

const body = (game, index) => game.players[index].body;
const logs = (game) => game.logs.map((l) => l.text).join('\n');

test('托管默认关闭：谁都没有托管', () => {
  const { game } = makeGame();
  game.players.forEach((player) => assert.equal(player.escrow, false));
  assert.equal(game.isEscrowed(0), false);
});

test('托管玩家自己判定失败时，自动用幸运币救回', async () => {
  const { game, calls } = makeGame({ values: [0.1, 0.9], escrowCoins: [0] });
  const me = body(game, 0);
  me.lucky = 1;

  const success = await game.rollCheck(me, '测试判定');

  assert.equal(success, true, '幸运币把失败判定救成成功');
  assert.equal(me.lucky, 0, '幸运币被消耗');
  assert.equal(calls.length, 0, '托管玩家不再弹硬币确认面板');
  assert.match(logs(game), /使用幸运币重掷/);
});

test('托管玩家自己判定成功时，弃权幸运币（硬币保留）', async () => {
  const { game, calls } = makeGame({ values: [0.9], escrowCoins: [0] });
  const me = body(game, 0);
  me.lucky = 1;

  const success = await game.rollCheck(me, '测试判定');

  assert.equal(success, true);
  assert.equal(me.lucky, 1, '已经成功了就不用重掷，幸运币保留');
  assert.equal(calls.length, 0, '不弹面板');
  assert.match(logs(game), /托管硬币：本次弃权幸运币/);
});

test('托管玩家的诅咒币在对方判定成功时自动压掉', async () => {
  const { game, calls } = makeGame({ values: [0.9, 0.1], escrowCoins: [1] });
  const foe = body(game, 1);
  foe.curse = 1;

  const success = await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(success, false, '诅咒币把成功判定压成失败');
  assert.equal(foe.curse, 0, '诅咒币被消耗');
  assert.equal(calls.length, 0, '不弹面板');
  assert.match(logs(game), /使用诅咒币重掷/);
});

test('托管玩家的诅咒币在对方判定失败时自动弃权', async () => {
  const { game, calls } = makeGame({ values: [0.1], escrowCoins: [1] });
  const foe = body(game, 1);
  foe.curse = 1;

  const success = await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(success, false);
  assert.equal(foe.curse, 1, '对方已经失败了就不用压，诅咒币保留');
  assert.equal(calls.length, 0, '不弹面板');
  assert.match(logs(game), /托管硬币：本次弃权诅咒币/);
});

test('未托管的玩家仍然照常弹硬币确认面板', async () => {
  const { game, calls } = makeGame({ values: [0.1] });
  body(game, 0).lucky = 1;

  await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(calls.length, 1, '未托管时照常弹面板');
  assert.equal(calls[0].coins.length, 1);
  assert.equal(calls[0].coins[0].coin, 'lucky');
});

test('托管的硬币不进入手动面板，但在面板里单独标注', async () => {
  const { game, calls } = makeGame({ values: [0.1], escrowCoins: [1] });
  body(game, 0).lucky = 1; // 未托管：手动决定
  body(game, 1).curse = 1; // 托管：规则自动决定

  await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(calls.length, 1, '只有手动硬币才需要面板');
  assert.deepEqual(
    calls[0].coins.map((coin) => coin.coin),
    ['lucky'],
    '托管的诅咒币不在手动列表里'
  );
  assert.equal(calls[0].escrowed.length, 1, '托管硬币单独标注出来');
  assert.equal(calls[0].escrowed[0].coin, 'curse');
});

test('托管的诅咒币作用在最终判定值上：手动重掷成成功后仍会被压掉', async () => {
  const { game, calls } = makeGame({
    // 原始失败 → 手动幸运币重掷成成功 → 托管诅咒币再压回失败
    values: [0.1, 0.9, 0.1],
    escrowCoins: [1],
    io: {
      chooseCoinIntervention: async (payload) => {
        calls.push(payload);
        const lucky = payload.coins.find((coin) => coin.coin === 'lucky');
        return lucky ? { coinId: lucky.id } : { done: true };
      }
    }
  });
  body(game, 0).lucky = 1;
  body(game, 1).curse = 1;

  const success = await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(success, false, '最终结果被托管的诅咒币压成失败');
  assert.equal(body(game, 0).lucky, 0, '手动幸运币用掉了');
  assert.equal(body(game, 1).curse, 0, '托管诅咒币也用掉了（作用在重掷后的成功上）');
  assert.equal(calls.length, 1, '手动面板只弹一次');
});

test('骰子判定（非 check）时托管硬币一律弃权', async () => {
  const { game, calls } = makeGame({ values: [0.1, 0.9], escrowCoins: [0] });
  const me = body(game, 0);
  me.lucky = 1;

  const value = await game.rollDie(6, me, '测试骰子');

  assert.equal(value, 1, '骰子结果没有被改写');
  assert.equal(me.lucky, 1, '幸运币保留');
  assert.equal(calls.length, 0, '不弹面板');
  assert.match(logs(game), /托管硬币：本次弃权幸运币/);
});

test('运行中可以把某个玩家切到托管', async () => {
  const { game, calls } = makeGame({ values: [0.1, 0.9] });
  body(game, 0).lucky = 1;

  assert.equal(game.setCoinEscrow(0, true), true);
  assert.equal(game.isEscrowed(0), true);

  const success = await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(success, true, '切到托管后由规则自动救回');
  assert.equal(calls.length, 0, '切到托管后不再弹面板');
});

test('托管只影响自己持有的硬币：别人的硬币不受牵连', async () => {
  const { game, calls } = makeGame({ values: [0.1, 0.9], escrowCoins: [0] });
  body(game, 0).lucky = 1; // 托管玩家的幸运币
  body(game, 1).lucky = 1; // 另一个玩家的幸运币（不托管）

  await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(body(game, 0).lucky, 0, '托管玩家的幸运币被自动用掉');
  assert.equal(body(game, 1).lucky, 1, '别人的幸运币没被碰');
  assert.equal(calls.length, 0);
});

test('面板返回无效硬币时不会卡死', async () => {
  const { game, calls } = makeGame({
    values: [0.1],
    escrowCoins: [1],
    io: {
      chooseCoinIntervention: async (payload) => {
        calls.push(payload);
        return { coinId: '不存在的硬币' };
      }
    }
  });
  body(game, 0).lucky = 1; // 手动
  body(game, 1).curse = 1; // 托管

  const success = await game.rollCheck(body(game, 0), '测试判定');

  assert.equal(success, false);
  assert.equal(calls.length, 1, '无效选择不应反复弹面板');
});
