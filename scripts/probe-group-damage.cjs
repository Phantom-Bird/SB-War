'use strict';

/*
 * 群体伤害结算探针：枚举多人局里“一次攻击打多人、其中前一个人复活失败”的各种配置，
 * 检查后续目标的伤害是否如实结算、场上状态是否自洽。
 * 用法：node scripts/probe-group-damage.cjs
 */

const { Game } = require('../js/engine.js');

function makeGame(names, values) {
  let cursor = 0;
  const rng = () => (cursor < values.length ? values[cursor++] : 0.9);
  const game = new Game({
    rng,
    io: {
      chooseCoinIntervention: async () => ({ done: true }),
      chooseTarget: async ({ options }) => options[0].id,
      pause: async () => {},
      animateRoll: async () => {}
    }
  });
  game.start(names, { firstPlayer: 0 });
  return game;
}

function snapshot(game) {
  return game.players
    .map((p) => {
      const body = p.body.alive ? `${p.body.hp}/${p.body.maxHp}` : 'X';
      const standin = p.standin ? (p.standin.alive ? `${p.standin.hp}/${p.standin.maxHp}` : 'x') : '-';
      return `${p.name}[体${body}替${standin}]`;
    })
    .join(' ');
}

async function scenario(title, setup, values, groupId = 'bodies') {
  const game = makeGame(['甲', '乙', '丙'], values);
  const [a, b, c] = game.players;
  setup({ a, b, c, game });

  let picked = null;
  game.io.chooseTarget = async ({ options }) => {
    picked = options.map((o) => o.id);
    return groupId;
  };

  const before = {
    b: b.body.hp,
    c: c.body.hp,
    bStandin: b.standin ? b.standin.hp : null,
    cStandin: c.standin ? c.standin.hp : null
  };

  await game.act(0, a.body.id, 0);

  console.log(`\n=== ${title} ===`);
  console.log(`  目标组: ${picked ? picked.join(',') : '(未打开)'}`);
  console.log(`  结果: ${snapshot(game)} over=${game.over} winner=${game.winner} current=${game.current} turn=${game.turn}`);
  const lines = game.logs.map((l) => `    T${l.turn} [${l.type}] ${l.text}`);
  console.log(lines.join('\n'));
  return { game, before };
}

(async () => {
  // 1. 基准：乙 1 血无替身，复活失败；丙应正常掉 1 血
  await scenario(
    'S1 乙 1 血无替身，复活判定失败',
    ({ b, c }) => {
      b.body.hp = 1;
      c.body.hp = 3;
    },
    [0.9, 0.1]
  );

  // 2. 乙有替身，本体复活失败 → 替身是否残留
  await scenario(
    'S2 乙带替身，本体复活失败',
    ({ b, c, game }) => {
      b.body.hp = 1;
      c.body.hp = 3;
      game.summonStandin(b.body);
    },
    [0.9, 0.1]
  );

  // 3. 乙有替身且替身顶在前面，攻击替身组
  await scenario(
    'S3 攻击替身组，乙替身复活失败',
    ({ b, c, game }) => {
      game.summonStandin(b.body);
      game.summonStandin(c.body);
    },
    [0.9, 0.1],
    'standins'
  );

  // 4. 乙本体带反甲，攻击本体组
  await scenario(
    'S4 乙本体带反甲，复活失败',
    ({ b, c }) => {
      b.body.hp = 1;
      b.body.thorns = 1;
      c.body.hp = 3;
    },
    [0.9, 0.1]
  );

  // 5. 乙本体带护盾 + 1 血
  await scenario(
    'S5 乙本体带护盾',
    ({ b, c }) => {
      b.body.hp = 1;
      b.body.shield = 1;
      c.body.hp = 3;
    },
    [0.9, 0.1]
  );

  // 6. 丙带替身，攻击本体组，乙复活失败
  await scenario(
    'S6 丙带替身，乙本体复活失败',
    ({ b, c, game }) => {
      b.body.hp = 1;
      c.body.hp = 3;
      game.summonStandin(c.body);
    },
    [0.9, 0.1]
  );

  // 7. 乙本体处于拆分状态
  await scenario(
    'S7 乙本体拆分中',
    ({ b, c }) => {
      b.body.hp = 1;
      b.body.split = { total: 3, remaining: 2 };
      b.body.maxHp = 1;
      c.body.hp = 3;
    },
    [0.9, 0.1]
  );
})();
