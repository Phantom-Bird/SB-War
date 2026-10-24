'use strict';

/*
 * 复现：一次群体攻击里，磨刀只对组内第一个目标生效。
 *
 * 场景：带 1 层磨刀的攻击者，打两个「拆分 + 护盾」的对手。
 * 期望：整组共享同一份磨刀加成 → 两个目标各吃 2 点（护盾挡 1 点，还掉 1 点血）。
 * 实际：第一个目标把磨刀吃掉了，第二个目标只吃 1 点 → 被护盾挡光，0 点伤害。
 *
 * 用法：node scripts/probe-sharpen-group.cjs
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

function show(game, title) {
  console.log(`\n=== ${title} ===`);
  console.log(
    game.players
      .map((p) => {
        const body = `${p.name} 本体 ${p.body.alive ? `${p.body.hp}/${p.body.maxHp}` : '已退场'}`;
        const shield = p.body.shield ? ' 护盾' : '';
        const split = p.body.split ? ` 拆分${p.body.split.remaining}/${p.body.split.total}` : '';
        const sharp = p.body.sharpen ? ` 磨刀×${p.body.sharpen}` : '';
        return `  ${body}${shield}${split}${sharp}`;
      })
      .join('\n')
  );
}

(async () => {
  // 甲带 1 层磨刀；乙、丙都带拆分 + 护盾
  const game = makeGame(['甲', '乙', '丙'], [0.9, 0.1, 0.1]);
  const [a, b, c] = game.players;

  a.body.sharpen = 1;
  for (const p of [b, c]) {
    p.body.shield = 1;
    p.body.split = { total: 3, remaining: 3 };
    p.body.maxHp = 1;
    p.body.hp = 1;
  }
  show(game, '【攻击前】');

  await game.act(0, a.body.id, 0);

  show(game, '【攻击后】');
  console.log('\n战斗记录：');
  for (const entry of game.logs) {
    console.log(`  T${entry.turn} [${entry.type}] ${entry.text}`);
  }

  const bSplit = b.body.split ? b.body.split.remaining : 0;
  const cSplit = c.body.split ? c.body.split.remaining : 0;
  console.log('\n结论：');
  console.log(`  乙 剩 ${b.body.hp} 血（拆分剩 ${bSplit} 阶段），丙 剩 ${c.body.hp} 血（拆分剩 ${cSplit} 阶段）`);
  if (bSplit === 2 && cSplit === 2) {
    console.log('  ✅ 两个目标都吃到了磨刀加成（各掉 1 点血、各失去一个拆分阶段）');
  } else {
    console.log('  ❌ 磨刀没有覆盖整组：组内第一个目标把磨刀吃掉了');
  }
})();
