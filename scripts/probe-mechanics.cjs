'use strict';

/*
 * 机制探针：验证难度 2 启发式依赖的关键规则交互。
 * 用法：node scripts/probe-mechanics.cjs
 *
 * 判定极性：rng() >= 0.5 → 判定成功（engine 里 raw = rng()<0.5 ? 0 : 1，raw===1 才算成功）
 */

const { Game } = require('../js/engine.js');

function makeRng(seed = 1) {
  let cursor = seed >>> 0;
  return () => {
    cursor = (cursor * 1664525 + 1013904223) % 4294967296;
    return cursor / 4294967296;
  };
}

async function newGame(rng, firstPlayer = 0) {
  const game = new Game({
    rng,
    io: {
      chooseCoinIntervention: async () => ({ done: true }),
      chooseTarget: async ({ options }) => options[0].id,
      pause: async () => {},
      animateRoll: async () => {}
    }
  });
  game.start(['甲', '乙'], { firstPlayer });
  return game;
}

function addStandin(game, idx) {
  const p = game.players[idx];
  const s = {
    id: `p${idx}s`,
    name: `${p.name}的替身`,
    owner: idx,
    isStandin: true,
    hp: 1,
    maxHp: 1,
    alive: true,
    slotCap: 2,
    slots: [],
    shield: 0,
    sharpen: 0,
    thorns: 0,
    tenacity: false,
    tenacityRecord: 0,
    split: null,
    hetero: false,
    thief: false,
    lucky: 0,
    curse: 0,
    _dying: false
  };
  p.standin = s;
  return s;
}

function line(entity) {
  const eff = [
    entity.sharpen ? `磨刀${entity.sharpen}` : '',
    entity.shield ? '护盾' : '',
    entity.thorns ? '反甲' : '',
    entity.tenacity ? '韧性' : '',
    entity.split ? `拆分${entity.split.remaining}` : '',
    entity.hetero ? '异质' : '',
    entity.thief ? '小偷' : '',
    entity.lucky ? '幸运' : '',
    entity.curse ? '诅咒' : ''
  ].filter(Boolean);
  return `${entity.name} ${entity.hp}/${entity.maxHp}${entity.alive ? '' : '(死)'} [${eff.join(',')}] 槽[${entity.slots}]`;
}

function show(game, title) {
  console.log(`\n${title}`);
  for (const p of game.players) {
    console.log(`  ${line(p.body)}`);
    if (p.standin) console.log(`  ${line(p.standin)}`);
  }
}

(async () => {
  // ---- A. 判定失败的普攻：自伤 + 自身反甲 → 伤害打向对方本体
  {
    const game = await newGame(makeRng(11));
    game.players[0].body.thorns = 1;
    game.players[0].body.slots = [5];
    game.rng = () => 0.1; // 判定失败
    await game.act(0, game.players[0].body.id, 0);
    show(game, 'A. 反甲 + 普攻失败 → 自伤 1，并反手打对方本体 1？');
  }

  // ---- B. 磨刀对成功攻击的增幅
  {
    const game = await newGame(makeRng(11));
    game.players[0].body.sharpen = 2;
    game.rng = () => 0.9; // 判定成功
    await game.act(0, game.players[0].body.id, 0);
    show(game, 'B. 磨刀 2 层 + 普攻成功 → 对方掉几点？磨刀是否消耗？');
  }

  // ---- C. 磨刀对自伤的增幅
  {
    const game = await newGame(makeRng(11));
    game.players[0].body.sharpen = 2;
    game.rng = () => 0.1; // 判定失败
    await game.act(0, game.players[0].body.id, 0);
    show(game, 'C. 磨刀 2 层 + 普攻失败 → 自伤几点？');
  }

  // ---- D. 技能判定失败 → 对方本体拿到该技能
  {
    const game = await newGame(makeRng(11));
    game.rng = () => 0.1; // 失败
    await game.act(0, game.players[0].body.id, 2); // 护盾
    show(game, 'D. 护盾判定失败 → 对方本体是否获得护盾？');
  }

  // ---- E. 替身行动失败 + 对方无替身 → 技能落空
  {
    const game = await newGame(makeRng(11));
    addStandin(game, 0);
    game.rng = () => 0.1; // 失败
    await game.act(0, 'p0s', 2);
    show(game, 'E. 替身行动失败 + 对方无替身 → 护盾是否落空（双方都没有护盾）？');
  }

  // ---- F. 替身行动失败 + 对方有替身 → 对方替身拿到技能
  {
    const game = await newGame(makeRng(11));
    addStandin(game, 0);
    addStandin(game, 1);
    game.rng = () => 0.1; // 失败
    await game.act(0, 'p0s', 2);
    show(game, 'F. 替身行动失败 + 对方有替身 → 对方替身拿到护盾？');
  }

  // ---- G. 幸运币：命中率 50% → 75%？
  {
    let hits = 0;
    let rerolls = 0;
    const N = 20000;
    for (let i = 0; i < N; i += 1) {
      const game = await newGame(makeRng(i + 1));
      game.players[0].body.lucky = 1;
      game.players[0].body.slots = [6];
      let called = 0;
      game.io.chooseCoinIntervention = async ({ coins }) => {
        called += 1;
        const coin = coins.find((c) => c.coin === 'lucky' && c.playerIdx === 0);
        if (!coin || called > 1) return { done: true };
        rerolls += 1;
        return { coinId: coin.id };
      };
      await game.act(0, game.players[0].body.id, 0);
      if (game.players[1].body.hp < 3) hits += 1;
    }
    console.log(`\nG. 幸运币重掷后普攻命中率 ${((hits / N) * 100).toFixed(1)}%（理论 75%），重掷次数 ${rerolls}`);
  }

  // ---- H. 无幸运币时命中率
  {
    let hits = 0;
    const N = 20000;
    for (let i = 0; i < N; i += 1) {
      const game = await newGame(makeRng(i + 1));
      await game.act(0, game.players[0].body.id, 0);
      if (game.players[1].body.hp < 3) hits += 1;
    }
    console.log(`H. 无硬币普攻命中率 ${((hits / N) * 100).toFixed(1)}%（理论 50%）`);
  }

  // ---- I. 1 HP 本体被 1 点伤害：复活判定的成功率
  {
    let revived = 0;
    const N = 20000;
    for (let i = 0; i < N; i += 1) {
      const game = await newGame(makeRng(i + 1));
      const b = game.players[1].body;
      b.hp = 1;
      await game.damage(game.players[0].body, b, 1, {});
      if (b.alive) revived += 1;
    }
    console.log(`I. 1 HP 本体挨 1 点伤害后复活率 ${((revived / N) * 100).toFixed(1)}%（理论 50%）`);
  }

  // ---- J. 替身挨 1 点伤害后复活率
  {
    let revived = 0;
    const N = 20000;
    for (let i = 0; i < N; i += 1) {
      const game = await newGame(makeRng(i + 1));
      const s = addStandin(game, 1);
      await game.damage(game.players[0].body, s, 1, {});
      if (s.alive) revived += 1;
    }
    console.log(`J. 1 HP 替身挨 1 点伤害后复活率 ${((revived / N) * 100).toFixed(1)}%（理论 50%）`);
  }

  // ---- K. LCG 相邻两抽的相关性（幸运币重掷依赖两次抽取独立）
  {
    let both = 0;
    let first = 0;
    const N = 20000;
    for (let i = 0; i < N; i += 1) {
      const rng = makeRng(i + 1);
      const a = rng();
      const b = rng();
      if (a >= 0.5) first += 1;
      if (a >= 0.5 && b >= 0.5) both += 1;
    }
    console.log(`K. LCG 相邻抽：P(a≥.5)=${(first / N).toFixed(3)} P(a≥.5 且 b≥.5)=${(both / N).toFixed(3)}（独立时应为 0.25）`);
  }
})();
