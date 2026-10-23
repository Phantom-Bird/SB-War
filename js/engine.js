/*
 * 杀币战争 · 核心规则引擎
 * ------------------------------------------------------------
 * 纯逻辑实现，不依赖 DOM，可在浏览器与 Node.js 中运行。
 * 浏览器：<script src="js/engine.js"></script> → window.SBWar
 * Node：  const { Game } = require('./js/engine.js')
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SBWar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BODY_MAX_HP = 3;
  const BODY_SLOTS = 4;
  const STANDIN_MAX_HP = 1;
  const STANDIN_SLOTS = 2;

  const SKILLS = [
    {
      id: 0, key: 'attack', name: '普通攻击', icon: '⚔', accent: '#ff9f68',
      slot: false, target: 'enemy',
      short: '对目标造成 1 点伤害；判定失败反噬自身 1 点。',
      desc: '对目标造成 1 点伤害。普通攻击不占用技能槽；判定失败时反噬自身 1 点伤害，不会由对方代为使用。这次自伤仍会触发磨刀、护盾、韧性、反甲等效果。'
    },
    {
      id: 1, key: 'sharpen', name: '磨刀', icon: '△', accent: '#f5c26b',
      slot: true, target: 'self',
      short: '下次造成伤害 +1，可叠加。',
      desc: '下次造成伤害时，伤害提高 1 点。可叠加：多层磨刀会在下一次伤害中一并消耗。'
    },
    {
      id: 2, key: 'shield', name: '护盾', icon: '□', accent: '#7cc7ff',
      slot: true, target: 'self',
      short: '抵挡 1 点伤害。',
      desc: '抵挡 1 点伤害。护盾抵挡伤害时，仍会触发受到伤害或对方造成伤害时能触发的效果。不可叠加。'
    },
    {
      id: 3, key: 'split', name: '拆分', icon: '|', accent: '#b9a2ff',
      slot: true, target: 'self',
      short: '把当前生命值拆成多个 1 HP 阶段。',
      desc: '当前每 1 点生命值变成一个阶段，每个阶段的生命值上限为 1，并且都可以进行复活判定。阶段复活成功会保住当前阶段；失败则失去该阶段并进入下一阶段，只有最后一个阶段失败才会出局。最后阶段复活成功后解除拆分，生命值变为 1/3。再次使用会解除拆分，并把生命值重置为剩余阶段数。'
    },
    {
      id: 4, key: 'tenacity', name: '韧性', icon: '—', accent: '#8fd6b4',
      slot: true, target: 'self',
      short: '记录伤害，回合结束时结算一半。',
      desc: '记录自身受到的所有伤害并推迟结算。自身回合结束时，解除韧性并结算记录伤害的一半（四舍五入）。再次使用会取消韧性并立即结算全部记录伤害。'
    },
    {
      id: 5, key: 'thorns', name: '反甲', icon: '◇', accent: '#ff8b9a',
      slot: true, target: 'self',
      short: '下次受伤后反击对方 1 点。',
      desc: '下次受到伤害后，对对方造成 1 点伤害。若伤害来自对方，则反击伤害来源；若是自伤，则把伤害打向对方本体。反甲可以被反甲造成的伤害触发，不可叠加。'
    },
    {
      id: 6, key: 'lucky', name: '幸运', icon: '☆', accent: '#ffd76a',
      slot: true, target: 'self',
      short: '获得幸运币：自己重掷随机数。',
      desc: '获得一枚幸运币。自己使用随机数生成器后，可以主动使用幸运币再生成一次随机数，并覆盖原来的值。'
    },
    {
      id: 7, key: 'curse', name: '诅咒', icon: '⇌', accent: '#c47bff',
      slot: true, target: 'self',
      short: '获得诅咒币：对方重掷随机数。',
      desc: '获得一枚诅咒币。对方使用随机数生成器后，可以主动使用诅咒币再生成一次随机数，并覆盖原来的值。'
    },
    {
      id: 8, key: 'thief', name: '小偷', icon: '▽', accent: '#9be07a',
      slot: true, target: 'self',
      short: '下次伤害结算后随机偷取一个效果。',
      desc: '下次造成伤害并完成结算后，随机选择目标的一个技能效果并消除；若自身技能槽可以容纳，则将同样的效果转移给自己。可叠加效果只偷取一层，记录型状态会连同记录一起被继承。'
    },
    {
      id: 9, key: 'summon', name: '召唤', icon: '⊕', accent: '#6fe3d2',
      slot: true, target: 'self',
      short: '召唤 1 HP、2 技能槽的替身。',
      desc: '召唤一个生命值为 1 的替身。替身拥有独立的 2 个技能槽和独立效果，可以行动、被选为目标并进行复活判定。每位玩家同时只能拥有一个替身。'
    },
    {
      id: 10, key: 'hetero', name: '异质', icon: '×', accent: '#ff6b6b',
      slot: true, target: 'self',
      short: '与无异质者互相造成真实伤害。',
      desc: '接下来，自身对无异质玩家的伤害、以及无异质玩家对自身的伤害都变为真实伤害。真实伤害无法触发技能效果，但可以触发复活判定。再次使用会解除异质。'
    }
  ];

  const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

  const DEFAULT_IO = {
    chooseCoinIntervention: async () => ({ done: true }),
    chooseTarget: async ({ candidates }) => (candidates[0] ? candidates[0].id : null),
    animateRoll: async () => {},
    pause: async () => {},
    onLog: () => {},
    onRoll: () => {},
    onEffect: () => {},
    changed: () => {},
    onGameOver: () => {}
  };

  function makeEntity({ id, name, owner, isStandin }) {
    return {
      id,
      name,
      owner,
      isStandin: !!isStandin,
      hp: isStandin ? STANDIN_MAX_HP : BODY_MAX_HP,
      maxHp: isStandin ? STANDIN_MAX_HP : BODY_MAX_HP,
      alive: true,
      slotCap: isStandin ? STANDIN_SLOTS : BODY_SLOTS,
      slots: [],
      // 技能效果
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
      // 内部状态
      _dying: false
    };
  }

  /** 返回用于 UI 展示的效果标签 */
  function effectChips(entity) {
    const chips = [];
    if (entity.sharpen > 0) {
      chips.push({ key: 'sharpen', icon: '△', name: '磨刀', value: `×${entity.sharpen}`, label: `磨刀 ×${entity.sharpen}`, tone: 'gold', title: '下次造成伤害 +1（可叠加）' });
    }
    if (entity.shield > 0) {
      chips.push({ key: 'shield', icon: '□', name: '护盾', value: '', label: '护盾', tone: 'blue', title: '抵挡下一次伤害中的 1 点' });
    }
    if (entity.split) {
      chips.push({ key: 'split', icon: '|', name: '拆分', value: `${entity.split.remaining}/${entity.split.total}`, label: `拆分 ${entity.split.remaining}/${entity.split.total}`, tone: 'purple', title: '每个阶段 1 HP，可分别进行复活判定' });
    }
    if (entity.tenacity) {
      const record = Math.max(0, entity.tenacityRecord || 0);
      chips.push({
        key: 'tenacity',
        icon: '—',
        name: '韧性',
        value: String(record),
        label: `韧性 · ${record}`,
        tone: 'green',
        title: `记录伤害 ${record} 点，回合结束结算一半`
      });
    }
    if (entity.thorns > 0) {
      chips.push({ key: 'thorns', icon: '◇', name: '反甲', value: '', label: '反甲', tone: 'red', title: '下次受到伤害后反击来源 1 点' });
    }
    if (entity.lucky > 0) {
      chips.push({ key: 'lucky', icon: '☆', name: '幸运币', value: '', label: '幸运币', tone: 'gold', title: '自己掷出随机数后可重掷并覆盖' });
    }
    if (entity.curse > 0) {
      chips.push({ key: 'curse', icon: '⇌', name: '诅咒币', value: '', label: '诅咒币', tone: 'purple', title: '对方掷出随机数后可重掷并覆盖' });
    }
    if (entity.thief) {
      chips.push({ key: 'thief', icon: '▽', name: '小偷', value: '', label: '小偷', tone: 'green', title: '下次造成伤害时随机偷取一个技能效果' });
    }
    if (entity.hetero) {
      chips.push({ key: 'hetero', icon: '×', name: '异质', value: '', label: '异质', tone: 'red', title: '与无异质实体互相造成真实伤害' });
    }
    return chips;
  }

  function skillName(id) {
    const s = SKILL_BY_ID.get(id);
    return s ? s.name : `技能${id}`;
  }

  class Game {
    constructor(options = {}) {
      this.io = Object.assign({}, DEFAULT_IO, options.io || {});
      this.rng = typeof options.rng === 'function' ? options.rng : Math.random;

      this.players = [];
      this.current = 0;
      this.turn = 0;
      this.busy = false;
      this.over = false;
      this.winner = null;
      this.started = false;
      this.logs = [];
      this.stats = [];
      this._logId = 0;
    }

    // ---------------------------------------------------------- 生命周期

    start(names = [], opts = {}) {
      this.players = [0, 1].map((i) => {
        const raw = names[i] == null ? '' : String(names[i]).trim();
        const name = raw || `玩家${i + 1}`;
        return {
          index: i,
          name,
          body: makeEntity({ id: `p${i}`, name, owner: i, isStandin: false }),
          standin: null
        };
      });

      const first = opts.firstPlayer;
      if (first === 0 || first === 1) this.current = first;
      else this.current = this.rng() < 0.5 ? 0 : 1;

      this.turn = 1;
      this.busy = false;
      this.over = false;
      this.winner = null;
      this.started = true;
      this.logs = [];
      this._logId = 0;
      this.stats = [0, 1].map(() => ({
        damageDealt: 0,
        damageTaken: 0,
        skillsUsed: 0,
        checks: 0,
        successes: 0,
        failures: 0,
        revives: 0,
        coins: 0,
        steals: 0,
        summons: 0
      }));

      this.log(`杀币战争开始：${this.players[this.current].name} 获得先手`, 'system');
      this.announceTurn();
      this.emitChanged();
      return this;
    }

    announceTurn() {
      const p = this.players[this.current];
      this.log(`—— 第 ${this.turn} 回合 · ${p.name} 行动 ——`, 'turn');
    }

    // ---------------------------------------------------------- 查询

    getEntity(id) {
      for (const p of this.players) {
        if (p.body && p.body.id === id) return p.body;
        if (p.standin && p.standin.id === id) return p.standin;
      }
      return null;
    }

    getPlayerOf(entity) {
      return this.players[entity.owner];
    }

    getActors(playerIdx) {
      const p = this.players[playerIdx];
      if (!p) return [];
      const list = [];
      if (p.body && p.body.alive) list.push(p.body);
      if (p.standin && p.standin.alive) list.push(p.standin);
      return list;
    }

    enemiesOf(owner) {
      const p = this.players[1 - owner];
      if (!p) return [];
      const list = [];
      if (p.body && p.body.alive) list.push(p.body);
      if (p.standin && p.standin.alive) list.push(p.standin);
      return list;
    }

    canUseSkill(entity, skillId) {
      if (!entity || !entity.alive) return false;
      if (skillId === 0) return true;
      if (entity.slots.includes(skillId)) return true;
      return entity.slots.length < entity.slotCap;
    }

    getSkillsFor(actor) {
      if (!actor) return [];
      const owner = this.players[actor.owner];
      return SKILLS.map((s) => {
        const inSlot = s.id === 0 || actor.slots.includes(s.id);
        let available = actor.alive && !this.over && !this.busy;
        let reason = '';

        if (!available) {
          reason = this.over ? '战斗结束' : this.busy ? '结算中' : '无法行动';
        } else if (s.id !== 0 && !inSlot && actor.slots.length >= actor.slotCap) {
          available = false;
          reason = '技能槽已满';
        } else if (s.id === 9 && owner && owner.standin) {
          available = false;
          reason = '已有替身';
        } else if (s.id === 0) {
          reason = '不占槽';
        } else if (inSlot) {
          reason = '已记录';
        } else {
          reason = '将占用 1 槽';
        }

        return Object.assign({}, s, { inSlot, available, reason });
      });
    }

    describe(entity) {
      if (!entity) return null;
      return {
        id: entity.id,
        name: entity.name,
        owner: entity.owner,
        isStandin: entity.isStandin,
        hp: entity.hp,
        maxHp: entity.maxHp,
        alive: entity.alive,
        slotCap: entity.slotCap,
        slots: entity.slots.slice(),
        effects: effectChips(entity)
      };
    }

    // ---------------------------------------------------------- 行动

    async act(playerIdx, actorId, skillId) {
      if (!this.started || this.over || this.busy) return false;
      if (playerIdx !== this.current) return false;

      const actor = this.getEntity(actorId);
      if (!actor || !actor.alive || actor.owner !== playerIdx) return false;

      const skill = SKILL_BY_ID.get(skillId);
      if (!skill) return false;
      if (!this.canUseSkill(actor, skillId)) return false;

      this.busy = true;
      this.emitChanged();

      try {
        const actorLabel = actor.isStandin ? '替身' : '本体';
        this.stats[playerIdx].skillsUsed += 1;
        this.log(`${this.players[playerIdx].name} 让${actorLabel}使用【${skill.name}】`, 'skill');

        const success = await this.rollCheck(actor, `${skill.name}判定`);

        if (success) {
          this.occupy(actor, skillId);
          await this.resolveSkill(actor, skillId, { forced: false });
        } else if (skillId === 0) {
          this.log(`普通攻击判定失败，${actor.isStandin ? '替身' : '本体'}反噬自身 1 点伤害`, 'fail');
          await this.damage(actor, actor, 1, {
            real: false,
            selfRecoil: true,
            noThief: true
          });
        } else {
          const opponent = this.players[1 - playerIdx];
          const receiver = actor.isStandin ? opponent.standin : opponent.body;
          if (receiver && receiver.alive && this.canUseSkill(receiver, skillId)) {
            this.log(`判定失败！由 ${receiver.name} 代为使用【${skill.name}】`, 'fail');
            this.occupy(receiver, skillId);
            await this.resolveSkill(receiver, skillId, { forced: true, originalActor: actor });
          } else {
            const why = receiver && receiver.alive ? '对方技能槽已满，无法容纳' : '对方没有可承接的实体';
            this.log(`判定失败，技能没有生效（${why}）`, 'fail');
          }
        }

        if (!this.over) {
          await this.beat(300);
          await this.endTurn();
        }
      } finally {
        this.busy = false;
        this.emitChanged();
      }
      return true;
    }

    async pass(playerIdx) {
      if (!this.started || this.over || this.busy) return false;
      if (playerIdx !== this.current) return false;

      this.busy = true;
      this.emitChanged();
      try {
        this.log(`${this.players[playerIdx].name} 跳过本次行动`, 'turn');
        await this.endTurn();
      } finally {
        this.busy = false;
        this.emitChanged();
      }
      return true;
    }

    occupy(entity, skillId) {
      if (skillId === 0) return false;
      if (entity.slots.includes(skillId)) return false;
      if (entity.slots.length >= entity.slotCap) return false;
      entity.slots.push(skillId);
      this.log(`${entity.name} 的技能槽记录了【${skillName(skillId)}】（${entity.slots.length}/${entity.slotCap}）`, 'slot');
      return true;
    }

    async resolveSkill(actor, skillId, ctx) {
      if (skillId === 0) {
        let target = null;
        if (ctx.forced) {
          target = ctx.originalActor || null;
        } else {
          const candidates = this.enemiesOf(actor.owner);
          target = await this.pickTarget(actor, candidates, '选择普通攻击的目标');
        }
        if (target && target.alive) {
          await this.damage(actor, target, 1, {});
        } else {
          this.log('没有可攻击的目标', 'fail');
        }
        return;
      }

      await this.applyEffect(actor, skillId);
    }

    async pickTarget(actor, candidates, purpose) {
      if (!candidates.length) return null;
      if (candidates.length === 1) return candidates[0];
      const id = await this.io.chooseTarget({
        playerIdx: actor.owner,
        actor: this.describe(actor),
        purpose,
        candidates: candidates.map((e) => this.describe(e))
      });
      const picked = this.getEntity(id);
      return picked && picked.alive ? picked : candidates[0];
    }

    async applyEffect(entity, skillId) {
      switch (skillId) {
        case 1:
          entity.sharpen += 1;
          this.log(`${entity.name} 磨刀，下次伤害 +1（当前 ${entity.sharpen} 层）`, 'effect');
          break;
        case 2:
          entity.shield = 1;
          this.log(`${entity.name} 获得护盾`, 'effect');
          break;
        case 3:
          this.toggleSplit(entity);
          break;
        case 4:
          await this.toggleTenacity(entity);
          break;
        case 5:
          entity.thorns = 1;
          this.log(`${entity.name} 获得反甲`, 'effect');
          break;
        case 6:
          entity.lucky = 1;
          this.log(`${entity.name} 获得幸运币`, 'effect');
          break;
        case 7:
          entity.curse = 1;
          this.log(`${entity.name} 获得诅咒币`, 'effect');
          break;
        case 8:
          entity.thief = true;
          this.log(`${entity.name} 进入小偷状态：下次造成伤害时偷取效果`, 'effect');
          break;
        case 9:
          this.summonStandin(entity);
          break;
        case 10:
          entity.hetero = !entity.hetero;
          this.log(`${entity.name} ${entity.hetero ? '进入' : '解除'}异质状态`, 'effect');
          break;
        default:
          break;
      }

      this.io.onEffect({
        entity: this.describe(entity),
        skillId,
        skill: SKILL_BY_ID.get(skillId)
      });
    }

    toggleSplit(entity) {
      if (entity.split) {
        const remaining = entity.split.remaining;
        entity.split = null;
        entity.maxHp = entity.isStandin ? STANDIN_MAX_HP : BODY_MAX_HP;
        entity.hp = Math.max(1, remaining);
        this.log(`${entity.name} 解除拆分，生命值重置为 ${entity.hp}/${entity.maxHp}`, 'effect');
        return;
      }

      if (entity.hp <= 0) return;
      const phases = entity.hp;
      entity.split = { total: phases, remaining: phases };
      entity.maxHp = 1;
      entity.hp = 1;
      this.log(`${entity.name} 拆分为 ${phases} 个阶段（每阶段 1 HP）`, 'effect');
    }

    async toggleTenacity(entity) {
      if (entity.tenacity) {
        const record = entity.tenacityRecord;
        entity.tenacity = false;
        entity.tenacityRecord = 0;
        this.log(`${entity.name} 取消韧性，立即结算 ${record} 点记录伤害`, 'effect');
        if (record > 0) {
          await this.damage(null, entity, record, { ignoreTenacity: true, fromTenacity: true });
        }
        return;
      }

      entity.tenacity = true;
      entity.tenacityRecord = 0;
      this.log(`${entity.name} 获得韧性：记录受到的伤害`, 'effect');
    }

    summonStandin(entity) {
      const owner = this.players[entity.owner];
      if (owner.standin) {
        this.log(`${owner.name} 已经拥有替身，召唤没有产生效果`, 'effect');
        return;
      }
      const standin = makeEntity({
        id: `p${owner.index}s`,
        name: `${owner.name}的替身`,
        owner: owner.index,
        isStandin: true
      });
      owner.standin = standin;
      const stats = this.stats[owner.index];
      if (stats) stats.summons += 1;
      this.log(`${owner.name} 召唤了 1 HP、2 技能槽的替身`, 'summon');
    }

    // ---------------------------------------------------------- 随机与硬币

    formatValue(value, sides, isCheck = false) {
      if (isCheck) return value === 1 ? '成功' : '失败';
      return `点数 ${value}`;
    }

    async animateRoll(entity, label, value, sides, phase, coin, meta, kind) {
      const rollKind = kind || (sides === 2 ? 'check' : 'die');
      await this.io.animateRoll({
        roller: this.describe(entity),
        label,
        value,
        sides,
        display: this.formatValue(value, sides, rollKind === 'check'),
        kind: rollKind,
        phase: phase || 'roll',
        coin: coin || null,
        meta: meta || null
      });
    }

    collectCoinInterventions(roller, used) {
      const coins = [];
      const rollerPlayer = this.players[roller.owner];
      const opponent = this.players[1 - roller.owner];

      for (const entity of [rollerPlayer.body, rollerPlayer.standin]) {
        const id = entity ? `${entity.id}:lucky` : null;
        if (entity && entity.alive && entity.lucky > 0 && !used.has(id)) {
          coins.push({
            id,
            coin: 'lucky',
            holderId: entity.id,
            holderName: entity.name,
            playerIdx: entity.owner,
            holder: this.describe(entity)
          });
        }
      }

      for (const entity of [opponent.body, opponent.standin]) {
        const id = entity ? `${entity.id}:curse` : null;
        if (entity && entity.alive && entity.curse > 0 && !used.has(id)) {
          coins.push({
            id,
            coin: 'curse',
            holderId: entity.id,
            holderName: entity.name,
            playerIdx: entity.owner,
            holder: this.describe(entity)
          });
        }
      }

      return coins;
    }

    async applyCoinInterventions(roller, label, value, sides, binary = false, meta = null, kind) {
      let current = value;
      const isCheck = kind ? kind === 'check' : binary;
      const used = new Set();
      const rollAgain = () => (binary ? (this.rng() < 0.5 ? 0 : 1) : 1 + Math.floor(this.rng() * sides));

      // 没有任何可用硬币时不需要打开干预界面
      if (!this.collectCoinInterventions(roller, used).length) return current;

      while (true) {
        const coins = this.collectCoinInterventions(roller, used);
        // 硬币用尽后直接结束，不再保留确认面板
        if (!coins.length) break;

        const decision = await this.io.chooseCoinIntervention({
          roller: this.describe(roller),
          label,
          value: current,
          sides,
          isCheck,
          kind: isCheck ? 'check' : 'die',
          display: this.formatValue(current, sides, isCheck),
          coins,
          meta: meta || null
        });

        if (!decision || decision.done) break;

        const coin = coins.find((item) => item.id === decision.coinId);
        if (!coin) break;

        const holder = this.getEntity(coin.holderId);
        if (!holder || !holder.alive || holder[coin.coin] <= 0) {
          used.add(coin.id);
          continue;
        }

        holder[coin.coin] = 0;
        used.add(coin.id);
        this.emitChanged();
        const stats = this.stats[holder.owner];
        if (stats) stats.coins += 1;

        const next = rollAgain();
        const coinName = coin.coin === 'lucky' ? '幸运币' : '诅咒币';
        await this.animateRoll(roller, label, next, sides, 'reroll', coin.coin, meta, isCheck ? 'check' : 'die');
        this.log(
          `${holder.name} 使用${coinName}重掷【${label}】：${this.formatValue(current, sides, isCheck)} → ${this.formatValue(next, sides, isCheck)}`,
          'coin'
        );
        current = next;
      }

      return current;
    }

    async rollCheck(entity, label) {
      const raw = this.rng() < 0.5 ? 0 : 1;
      await this.animateRoll(entity, label, raw, 2, 'roll', null, null, 'check');
      this.log(`${entity.name} 的【${label}】：${raw === 1 ? '成功' : '失败'}`, raw === 1 ? 'roll-ok' : 'roll-fail');

      const finalValue = await this.applyCoinInterventions(entity, label, raw, 2, true, null, 'check');
      if (finalValue !== raw) {
        this.log(`【${label}】最终结果：${finalValue === 1 ? '成功' : '失败'}`, finalValue === 1 ? 'roll-ok' : 'roll-fail');
      }

      this.io.onRoll({
        roller: this.describe(entity),
        label,
        value: finalValue,
        sides: 2,
        kind: 'check',
        display: this.formatValue(finalValue, 2, true)
      });

      const stats = this.stats[entity.owner];
      if (stats) {
        stats.checks += 1;
        if (finalValue === 1) stats.successes += 1;
        else stats.failures += 1;
      }
      return finalValue === 1;
    }

    async rollDie(sides, entity, label, meta = null) {
      const raw = 1 + Math.floor(this.rng() * sides);
      await this.animateRoll(entity, label, raw, sides, 'roll', null, meta, 'die');
      this.log(`${label}：${this.formatValue(raw, sides, false)}`, 'roll');
      const finalValue = await this.applyCoinInterventions(entity, label, raw, sides, false, meta, 'die');
      if (finalValue !== raw) {
        this.log(`【${label}】最终结果：${this.formatValue(finalValue, sides, false)}`, 'roll');
      }
      this.io.onRoll({
        roller: this.describe(entity),
        label,
        value: finalValue,
        sides,
        kind: 'die',
        display: this.formatValue(finalValue, sides, false),
        meta
      });
      return finalValue;
    }

    // ---------------------------------------------------------- 伤害与效果

    async damage(source, target, amount, opts = {}) {
      if (this.over || !target || !target.alive || amount <= 0) return;

      const depth = opts.depth || 0;
      if (depth > 16) {
        this.log('伤害连锁过深，停止继续结算', 'system');
        return;
      }

      const real = opts.real === true || (opts.real !== false && source && source.hetero !== target.hetero);
      let changed = false;
      let blocked = false;

      // 磨刀：只增幅普通伤害；真实伤害不触发伤害效果，也不消耗磨刀
      if (real) {
        this.log(`真实伤害：${target.name} 无法触发技能效果`, 'damage');
        if (source && source.sharpen > 0) {
          this.log(`${source.name} 的磨刀层数保留（${source.sharpen} 层）`, 'effect');
        }
      } else if (source && source.sharpen > 0 && !opts.noSharpen) {
        const bonus = source.sharpen;
        source.sharpen = 0;
        amount += bonus;
        this.log(`${source.name} 消耗 ${bonus} 层【磨刀】，伤害提升至 ${amount}`, 'damage');
        changed = true;
      }

      let dmg = amount;

      if (!real && target.shield > 0) {
        target.shield = 0;
        dmg = Math.max(0, dmg - 1);
        blocked = true;
        this.log(`${target.name} 的【护盾】抵挡 1 点伤害`, 'effect');
      }

      if (!real && target.tenacity && dmg > 0 && !opts.ignoreTenacity) {
        target.tenacityRecord += dmg;
        changed = true;
        this.log(`${target.name} 的【韧性】记录 ${dmg} 点伤害（累计 ${target.tenacityRecord}）`, 'effect');
      } else if (dmg > 0) {
        target.hp -= dmg;
        changed = true;
        const targetStats = this.stats[target.owner];
        if (targetStats) targetStats.damageTaken += dmg;
        if (source && source.owner !== target.owner) {
          const sourceStats = this.stats[source.owner];
          if (sourceStats) sourceStats.damageDealt += dmg;
        }
        this.log(`${target.name} 受到 ${dmg} 点${real ? '真实' : ''}伤害（${target.hp}/${target.maxHp}）`, 'damage');
      }

      if (changed || blocked) {
        await this.beat(blocked && !changed ? 320 : 420);
      }

      // 反甲：即使护盾挡下伤害也会触发。“对方”是反甲拥有者的对手；
      // 自伤时同样会触发，并把伤害反射给对手。
      if (!real && target.thorns > 0 && !opts.noThorns) {
        let thornsTarget = null;
        if (source && source.alive && source.owner !== target.owner) {
          thornsTarget = source;
        } else {
          const opponent = this.players[1 - target.owner];
          thornsTarget = [opponent.body, opponent.standin].find((entity) => entity && entity.alive) || null;
        }

        if (thornsTarget) {
          target.thorns = 0;
          this.log(`${target.name} 的【反甲】反击 ${thornsTarget.name}`, 'effect');
          await this.beat(340);
          await this.damage(target, thornsTarget, 1, { depth: depth + 1, isThorns: true });
        }
      }

      if (target.hp <= 0 && target.alive) {
        await this.handleDepleted(target);
      }

      // 小偷在伤害结算后触发：护盾/反甲等先结算，再偷取剩余效果
      if (!real && !this.over && source && source !== target && source.alive && source.thief && !opts.noThief) {
        source.thief = false;
        this.log(`${source.name} 的【小偷】在伤害结算后触发`, 'steal');
        await this.beat(320);
        if (target.alive) await this.stealRandom(source, target);
        else this.log(`${target.name} 已无法被偷取`, 'steal');
        if (this.over) return;
        await this.beat(340);
      }
    }

    async stealRandom(source, target) {
      const pool = this.stealableEffects(target);
      if (!pool.length) {
        this.log(`${target.name} 没有可偷取的技能效果`, 'steal');
        return;
      }

      let pick;
      if (pool.length === 1) {
        pick = pool[0];
      } else {
        const choices = pool.map((item) => skillName(item.skillId));
        const index = await this.rollDie(pool.length, source, `${source.name} 的小偷随机选择`, {
          type: 'steal',
          choices
        });
        pick = pool[index - 1];
      }

      const name = skillName(pick.skillId);
      const stats = this.stats[source.owner];
      if (stats) stats.steals += 1;
      this.log(`${source.name} 偷取了 ${target.name} 的【${name}】`, 'steal');

      this.removeEffect(target, pick.key, pick.data);

      let transferred = false;
      if (this.canUseSkill(source, pick.skillId)) {
        this.occupy(source, pick.skillId);
        await this.attachEffect(source, pick.key, pick.data);
        transferred = true;
      }

      if (transferred) {
        this.log(`【${name}】转移给了 ${source.name}`, 'steal');
      } else {
        this.log(`${source.name} 没有空余技能槽，【${name}】被消除`, 'steal');
      }
    }

    stealableEffects(entity) {
      const out = [];
      if (entity.sharpen > 0) out.push({ key: 'sharpen', skillId: 1, data: { stacks: 1 } });
      if (entity.shield > 0) out.push({ key: 'shield', skillId: 2, data: {} });
      if (entity.split) out.push({ key: 'split', skillId: 3, data: { total: entity.split.total, remaining: entity.split.remaining } });
      if (entity.tenacity) out.push({ key: 'tenacity', skillId: 4, data: { record: entity.tenacityRecord } });
      if (entity.thorns > 0) out.push({ key: 'thorns', skillId: 5, data: {} });
      if (entity.lucky > 0) out.push({ key: 'lucky', skillId: 6, data: {} });
      if (entity.curse > 0) out.push({ key: 'curse', skillId: 7, data: {} });
      if (entity.thief) out.push({ key: 'thief', skillId: 8, data: {} });
      if (entity.hetero) out.push({ key: 'hetero', skillId: 10, data: {} });
      return out;
    }

    removeEffect(entity, key, data) {
      switch (key) {
        case 'sharpen':
          entity.sharpen = Math.max(0, entity.sharpen - 1);
          break;
        case 'shield':
          entity.shield = 0;
          break;
        case 'split': {
          entity.split = null;
          entity.maxHp = entity.isStandin ? STANDIN_MAX_HP : BODY_MAX_HP;
          entity.hp = Math.max(1, data.remaining);
          this.log(`${entity.name} 的拆分被解除，生命值变为 ${entity.hp}/${entity.maxHp}`, 'effect');
          break;
        }
        case 'tenacity':
          entity.tenacity = false;
          entity.tenacityRecord = 0;
          break;
        case 'thorns':
          entity.thorns = 0;
          break;
        case 'lucky':
          entity.lucky = 0;
          break;
        case 'curse':
          entity.curse = 0;
          break;
        case 'thief':
          entity.thief = false;
          break;
        case 'hetero':
          entity.hetero = false;
          break;
        default:
          break;
      }
    }

    async attachEffect(entity, key, data) {
      switch (key) {
        case 'sharpen':
          entity.sharpen += data.stacks || 1;
          break;
        case 'shield':
          entity.shield = 1;
          break;
        case 'split':
          if (entity.split) {
            const remaining = entity.split.remaining;
            entity.split = null;
            entity.maxHp = entity.isStandin ? STANDIN_MAX_HP : BODY_MAX_HP;
            entity.hp = Math.max(1, remaining);
            this.log(`${entity.name} 已处于拆分状态，再次获得拆分时解除拆分`, 'effect');
          } else {
            entity.split = { total: data.total, remaining: data.remaining };
            entity.maxHp = 1;
            entity.hp = 1;
          }
          break;
        case 'tenacity':
          if (entity.tenacity) {
            const record = entity.tenacityRecord;
            entity.tenacity = false;
            entity.tenacityRecord = 0;
            this.log(`${entity.name} 已处于韧性状态，再次获得韧性时取消并结算 ${record} 点记录伤害`, 'effect');
            if (record > 0) {
              await this.damage(null, entity, record, { ignoreTenacity: true, fromTenacity: true });
            }
          } else {
            entity.tenacity = true;
            entity.tenacityRecord = data.record || 0;
          }
          break;
        case 'thorns':
          entity.thorns = 1;
          break;
        case 'lucky':
          entity.lucky = 1;
          break;
        case 'curse':
          entity.curse = 1;
          break;
        case 'thief':
          entity.thief = true;
          break;
        case 'hetero':
          if (entity.hetero) {
            entity.hetero = false;
            this.log(`${entity.name} 已处于异质状态，再次获得异质时解除`, 'effect');
          } else {
            entity.hetero = true;
          }
          break;
        default:
          break;
      }
    }

    // ---------------------------------------------------------- 死亡与复活

    async loseSplitStage(entity, reason) {
      if (!entity.split || entity.split.remaining <= 1) return false;

      entity.split.remaining -= 1;
      entity.hp = 1;
      const currentStage = entity.split.total - entity.split.remaining + 1;
      this.log(
        `${entity.name} ${reason}，失去当前阶段并进入第 ${currentStage} 阶段（剩余 ${entity.split.remaining} 阶段）`,
        'fail'
      );
      await this.beat(450);
      return true;
    }

    async handleDepleted(entity) {
      if (!entity || !entity.alive || entity.hp > 0 || entity._dying) return;
      entity._dying = true;

      try {
        const penalty = Math.max(0, -entity.hp);
        for (let i = 1; i <= penalty; i += 1) {
          const ok = await this.rollCheck(entity, `负生命惩罚判定 ${i}/${penalty}`);
          if (!ok) {
            // 拆分状态下，惩罚判定失败同样只失去当前阶段；最后阶段失败才出局
            if (!(await this.loseSplitStage(entity, '负生命惩罚判定失败'))) {
              await this.eliminate(entity);
            }
            return;
          }
        }

        if (entity.split) {
          if (entity.split.remaining > 1) {
            const ok = await this.rollCheck(entity, '阶段复活判定');
            if (ok) {
              entity.hp = 1;
              this.log(`${entity.name} 阶段复活成功，保住当前阶段（剩余 ${entity.split.remaining} 阶段）`, 'revive');
              await this.beat(450);
            } else if (!(await this.loseSplitStage(entity, '阶段复活失败'))) {
              await this.eliminate(entity);
            }
          } else {
            const ok = await this.rollCheck(entity, '最终复活判定');
            if (!ok) {
              await this.eliminate(entity);
              return;
            }
            // 拆分的解除发生在复活之后：最后一个阶段复活后为 1/3，而不是满血 3/3
            const remainingStages = entity.split.remaining;
            entity.split = null;
            await this.revive(entity, { splitRemaining: remainingStages });
          }
        } else {
          const ok = await this.rollCheck(entity, '复活判定');
          if (!ok) {
            await this.eliminate(entity);
            return;
          }
          await this.revive(entity);
        }
      } finally {
        entity._dying = false;
      }
    }

    async revive(entity, opts = {}) {
      entity.alive = true;
      const stats = this.stats[entity.owner];
      if (stats) stats.revives += 1;
      entity.maxHp = entity.isStandin ? STANDIN_MAX_HP : BODY_MAX_HP;
      const splitRemaining = opts.splitRemaining;
      entity.hp = splitRemaining != null ? Math.max(1, splitRemaining) : entity.maxHp;
      this.clearEffects(entity);
      entity.slots = [];

      if (splitRemaining != null) {
        this.log(`${entity.name} 复活，拆分解除，生命值重置为 ${entity.hp}/${entity.maxHp}；清除其他效果并释放技能槽`, 'revive');
      } else {
        this.log(`${entity.name} 复活：生命值回满，清除所有效果并释放技能槽`, 'revive');
      }

      await this.beat(500);
    }

    clearEffects(entity) {
      entity.shield = 0;
      entity.sharpen = 0;
      entity.thorns = 0;
      entity.tenacity = false;
      entity.tenacityRecord = 0;
      entity.split = null;
      entity.hetero = false;
      entity.thief = false;
      entity.lucky = 0;
      entity.curse = 0;
    }

    async eliminate(entity) {
      if (!entity || !entity.alive) return;
      entity.alive = false;
      entity.hp = 0;

      const owner = this.players[entity.owner];

      if (entity.isStandin) {
        if (owner.standin && owner.standin.id === entity.id) owner.standin = null;
        this.log(`${entity.name} 被消灭`, 'death');
        this.emitChanged();
        return;
      }

      this.over = true;
      this.winner = 1 - entity.owner;
      this.log(`${owner.name} 的生命值耗尽且复活失败，战斗结束！`, 'death');
      this.log(`${this.players[this.winner].name} 获得胜利！`, 'system');
      this.io.onGameOver({
        winner: this.winner,
        winnerName: this.players[this.winner].name
      });
      this.emitChanged();
    }

    // ---------------------------------------------------------- 回合

    async settleTenacity(entity) {
      const record = entity.tenacityRecord;
      const half = Math.ceil(record / 2);
      entity.tenacity = false;
      entity.tenacityRecord = 0;
      this.log(`${entity.name} 的【韧性】在回合结束结算：${record} 的记录伤害减半为 ${half} 点`, 'effect');
      await this.damage(null, entity, half, { ignoreTenacity: true, fromTenacity: true });
    }

    async endTurn() {
      if (this.over) return;

      const p = this.players[this.current];
      const owned = [p.body, p.standin].filter(Boolean);

      for (const entity of owned) {
        if (this.over) break;
        if (entity.alive && entity.tenacity && entity.tenacityRecord > 0) {
          await this.settleTenacity(entity);
        }
      }

      if (this.over) {
        this.emitChanged();
        return;
      }

      this.current = 1 - this.current;
      this.turn += 1;
      this.announceTurn();
      this.emitChanged();
    }

    // ---------------------------------------------------------- 工具

    log(text, type = 'info') {
      const entry = {
        id: (this._logId += 1),
        turn: this.turn,
        type,
        text
      };
      this.logs.push(entry);
      if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
      this.io.onLog(entry);
    }

    emitChanged() {
      this.io.changed();
    }

    /** 让界面刷新当前状态，并为连锁效果留出阅读时间 */
    async beat(ms = 380) {
      this.emitChanged();
      if (this.io.pause) await this.io.pause(ms);
    }
  }

  return {
    Game,
    SKILLS,
    SKILL_BY_ID,
    makeEntity,
    effectChips,
    skillName,
    BODY_MAX_HP,
    BODY_SLOTS,
    STANDIN_MAX_HP,
    STANDIN_SLOTS
  };
});
