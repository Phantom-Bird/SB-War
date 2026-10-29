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
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 4;
  /**
   * 和局上限：人数 × 这个数 = 回合计数上限。
   * 回合计数 = 行动次数（每人一回合 +1），所以双人局是 250 次行动。
   *
   * 数值来自实测（scripts/probe-max-turns.cjs，每种配置 400 局、关掉上限）：
   *   2 人全难度 2：平均 41，最长 239 次行动（人均 119.5 回合）
   *   3 人全难度 2：平均 50，最长 194 次行动（人均 64.7 回合）
   *   4 人全难度 2：平均 60，最长 262 次行动（人均 65.5 回合）
   * 原来的 25 太紧：双人局 p90 就有 87 次行动（人均 43.5 回合），
   * 约四分之一的正常对局会被误判成和局。现在放到 125，
   * 正常对局基本不会被截断，只剩真正拖不动的僵局才会走到上限。
   */
  const DRAW_TURNS_PER_PLAYER = 125;

  /**
   * 本体生命值上限 = 人数 + 1。
   * 普通攻击现在一次覆盖“全体对手本体”或“全体对手替身”，
   * 双人局与原规则相同（1 伤害），人数越多越需要更高的血量来平衡。
   */
  function bodyMaxHpFor(playerCount) {
    return Math.max(2, playerCount) + 1;
  }

  /** 模式：2 人对决 / 3-4 人混战。多人模式下“对方”指全体其他玩家。 */
  const MODE_DUEL = 'duel';
  const MODE_BATTLE = 'battle';

  const SKILLS = [
    {
      id: 0, key: 'attack', name: '普通攻击', icon: '⚔', accent: '#ff9f68',
      slot: false, target: 'group',
      short: '对全体对手本体或全体对手替身造成 1 点伤害。',
      desc: '选择攻击全体对手的本体，或全体对手的替身，组内每个存活实体各受到 1 点伤害。普通攻击不占用技能槽；判定失败时反噬自身 1 点伤害，不会由对方代为使用。这次自伤仍会触发磨刀、护盾、韧性、反甲等效果。'
    },
    {
      id: 1, key: 'sharpen', name: '磨刀', icon: '△', accent: '#f5c26b',
      slot: true, target: 'self',
      short: '下次造成伤害 +1，可叠加。',
      desc: '下次造成伤害时，伤害提高 1 点。可叠加：多层磨刀会在下一次伤害中一并消耗。群体攻击时整组目标共享同一份加成，攻击结束后才消耗。'
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
      desc: '当前每 1 点生命值变成一个阶段，每个阶段的生命值上限为 1，并且都可以进行复活判定。阶段复活成功会保住当前阶段；失败则失去该阶段并进入下一阶段，只有最后一个阶段失败才会出局。最后阶段复活成功后解除拆分，生命值只剩 1 点。再次使用会解除拆分，并把生命值重置为剩余阶段数。'
    },
    {
      id: 4, key: 'tenacity', name: '韧性', icon: '—', accent: '#8fd6b4',
      slot: true, target: 'self',
      short: '记录生命值减少值，回合结束时结算一半。',
      desc: '记录自身生命值的减少量并推迟结算：无论受到的是普通伤害还是真实伤害，减少值都会被记录（护盾完全抵挡的部分不计入）。自身回合结束时，解除韧性并结算记录伤害的一半（四舍五入，所以单点的 1 点不会被减半）。延迟结算的伤害一律按自伤处理。再次使用会取消韧性并立即结算全部记录伤害。'
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
      desc: '召唤一个生命值为 1 的替身。替身拥有独立的 2 个技能槽和独立效果，可以行动、被选为目标。替身被打空就直接消失，不再进行复活判定；本体退场或本体复活时，替身也会一并消散。每位玩家同时只能拥有一个替身。'
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
    chooseTarget: async ({ options }) => (options && options.length ? options[0].id : null),
    animateRoll: async () => {},
    pause: async () => {},
    onLog: () => {},
    onRoll: () => {},
    onEffect: () => {},
    changed: () => {},
    onGameOver: () => {}
  };

  function makeEntity({ id, name, owner, isStandin, maxHp }) {
    const cap = isStandin ? STANDIN_MAX_HP : maxHp || BODY_MAX_HP;
    return {
      id,
      name,
      owner,
      isStandin: !!isStandin,
      hp: cap,
      maxHp: cap,
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
        title: `记录生命值减少 ${record} 点，回合结束结算一半`
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

  /**
   * 规整玩家名单：至少 2 人、最多 MAX_PLAYERS 人。
   * 末尾的空名字会被裁掉（人数随之减少），空位置回退为“玩家N”。
   */
  function normalizeNames(names) {
    const list = Array.isArray(names) ? names : [names];
    const raw = [];
    for (let i = 0; i < MAX_PLAYERS; i += 1) {
      raw.push(list[i] == null ? '' : String(list[i]).trim());
    }
    while (raw.length > MIN_PLAYERS && !raw[raw.length - 1]) raw.pop();
    return raw.map((name, i) => name || `玩家${i + 1}`);
  }

  class Game {
    constructor(options = {}) {
      this.io = Object.assign({}, DEFAULT_IO, options.io || {});
      this.rng = typeof options.rng === 'function' ? options.rng : Math.random;

      this.players = [];
      this.mode = MODE_DUEL;
      this.bodyMax = BODY_MAX_HP;
      this.current = 0;
      this.turn = 0;
      this.busy = false;
      this.over = false;
      this.winner = null;
      this.started = false;
      this.logs = [];
      this.stats = [];
      this.eliminationOrder = [];
      /** 和局原因：null / all-dead（全员阵亡）/ turn-limit（超上限）/ pass-streak（全场跳过） */
      this.drawReason = null;
      /** 连续跳过回合的玩家（判定“全场都跳过 → 和局”） */
      this.passStreak = new Set();
      this._logId = 0;
    }

    // ---------------------------------------------------------- 生命周期

    start(names = [], opts = {}) {
      const list = normalizeNames(names);
      this.mode = list.length > MIN_PLAYERS ? MODE_BATTLE : MODE_DUEL;
      this.bodyMax = bodyMaxHpFor(list.length);
      this.players = list.map((name, i) => ({
        index: i,
        name,
        body: makeEntity({ id: `p${i}`, name, owner: i, isStandin: false, maxHp: this.bodyMax }),
        standin: null,
        /** 硬币托管：开启后幸运币/诅咒币用不用由规则自动决定，不再手动确认 */
        escrow: Array.isArray(opts.escrowCoins) && opts.escrowCoins.includes(i)
      }));

      const first = opts.firstPlayer;
      if (Number.isInteger(first) && this.players[first]) this.current = first;
      else this.current = Math.floor(this.rng() * this.players.length);

      this.turn = 1;
      this.busy = false;
      this.over = false;
      this.winner = null;
      this.started = true;
      this.logs = [];
      this._logId = 0;
      this.eliminationOrder = [];
      this.drawReason = null;
      this.passStreak = new Set();
      this.stats = this.players.map(() => ({
        damageDealt: 0,
        damageTaken: 0,
        skillsUsed: 0,
        checks: 0,
        successes: 0,
        failures: 0,
        revives: 0,
        coins: 0,
        steals: 0,
        summons: 0,
        /** 退场发生在第几个回合；还活着 / 平局时为 null */
        eliminatedTurn: null,
        /** 在场上待了多少个回合（战报里的“存活回合”） */
        survivedTurns: 0,
        /** 最终名次；平局时为 null */
        rank: null
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

    /** 是否为多人混战模式 */
    isMultiplayer() {
      return this.players.length > MIN_PLAYERS;
    }

    /**
     * 本体生命值上限＝**当前存活人数 + 1**。
     * 有人退场时上限跟着下调（否则多人局很难结束）：
     * 4 人局 5 点 → 退场一人变 4 点 → 再退场变 3 点。
     * 双人局始终是 3 点，不受这条影响。
     */
    bodyMaxHp() {
      if (!this.started) return this.bodyMax || BODY_MAX_HP;
      const alive = this.alivePlayers().length;
      if (!alive) return this.bodyMax || BODY_MAX_HP;
      return bodyMaxHpFor(alive);
    }

    /**
     * 有玩家退场后，把剩余玩家的本体生命值上限调到新的水平，
     * 当前生命值超出新上限的部分直接削掉（不算伤害，只是不再有多余的血）。
     * 拆分中的实体保持 1 点上限不变，等拆分解除时会自动用新的上限恢复。
     */
    syncMaxHp() {
      if (!this.started || this.over) return;
      const target = bodyMaxHpFor(this.alivePlayers().length);
      const touched = [];
      for (const player of this.players) {
        const body = player.body;
        if (!body || !body.alive || body.hp <= 0) continue;
        if (body.split) continue; // 拆分中每个阶段上限固定是 1
        if (body.maxHp === target) continue;
        body.maxHp = target;
        if (body.hp > target) body.hp = target;
        touched.push(`${body.name} ${body.hp}/${body.maxHp}`);
      }
      if (touched.length) {
        this.log(`场上人数减少，剩余玩家的生命值上限调整为 ${target}：${touched.join('、')}`, 'system');
      }
    }

    /** 除了该玩家以外的全体玩家；双人模式下就是唯一的对手 */
    othersOf(owner) {
      return this.players.filter((player) => player.index !== owner);
    }

    /** 仍在场的玩家（本体存活即在场） */
    alivePlayers() {
      return this.players.filter((player) => player.body && player.body.alive);
    }

    getActors(playerIdx) {
      const p = this.players[playerIdx];
      if (!p) return [];
      const list = [];
      if (p.body && p.body.alive) list.push(p.body);
      if (p.standin && p.standin.alive) list.push(p.standin);
      return list;
    }

    /**
     * “对方”＝除自己以外的全体玩家的存活实体（本体 + 替身）。
     * 普通攻击的候选目标、诅咒币持有者等都基于这个列表。
     */
    enemiesOf(owner) {
      const list = [];
      for (const player of this.othersOf(owner)) {
        if (player.body && player.body.alive) list.push(player.body);
        if (player.standin && player.standin.alive) list.push(player.standin);
      }
      return list;
    }

    /**
     * 判定失败时的承接者：本体失败 → 其他所有玩家的本体；替身失败 → 其他所有玩家的替身。
     * 双人模式下就是“对方本体 / 对方替身”，多人模式下是全体其他玩家的对应实体。
     */
    backlashReceivers(entity) {
      const out = [];
      for (const player of this.othersOf(entity.owner)) {
        const receiver = entity.isStandin ? player.standin : player.body;
        if (receiver && receiver.alive) out.push(receiver);
      }
      return out;
    }

    /** 自伤触发反甲时的去向：其他所有玩家的本体 */
    opponentBodies(owner) {
      return this.othersOf(owner)
        .map((player) => player.body)
        .filter((body) => body && body.alive);
    }

    /** 从 from 之后按顺序找下一个仍在场的玩家 */
    nextPlayerAfter(from) {
      const count = this.players.length;
      for (let step = 1; step <= count; step += 1) {
        const candidate = this.players[(from + step) % count];
        if (candidate && candidate.body && candidate.body.alive) return candidate.index;
      }
      return from;
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

    /**
     * 当前玩家在结算过程中被淘汰时（例如反甲连锁打死了正在行动的玩家），
     * 把回合交给下一位仍在场的玩家，避免出现没人能行动的僵局。
     */
    ensureTurnReady() {
      if (this.over || !this.started) return;
      const current = this.players[this.current];
      if (current && current.body && !current.body.alive) {
        this.current = this.nextPlayerAfter(this.current);
        this.turn += 1;
        this.announceTurn();
        this.emitChanged();
      }
    }

    async act(playerIdx, actorId, skillId) {
      this.ensureTurnReady();
      if (!this.started || this.over || this.busy) return false;
      if (playerIdx !== this.current) return false;

      const actor = this.getEntity(actorId);
      if (!actor || !actor.alive || actor.owner !== playerIdx) return false;

      const skill = SKILL_BY_ID.get(skillId);
      if (!skill) return false;
      if (!this.canUseSkill(actor, skillId)) return false;

      // 有人真的出手了 → 连续跳过计数清零
      this.passStreak.clear();

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
          await this.applyBacklash(actor, skillId);
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
      this.ensureTurnReady();
      if (!this.started || this.over || this.busy) return false;
      if (playerIdx !== this.current) return false;

      this.busy = true;
      this.emitChanged();
      try {
        this.log(`${this.players[playerIdx].name} 跳过本次行动`, 'turn');
        this.passStreak.add(playerIdx);
        // 场上所有玩家都选择跳过 → 和局（没人愿意再打下去）
        if (this.allAlivePassed()) {
          await this.declareDraw('pass-streak');
          return true;
        }
        await this.endTurn();
      } finally {
        this.busy = false;
        this.emitChanged();
      }
      return true;
    }

    /** 场上所有存活玩家是否都选择了跳过回合 */
    allAlivePassed() {
      const alive = this.alivePlayers();
      if (!alive.length) return false;
      return alive.every((player) => this.passStreak.has(player.index));
    }

    occupy(entity, skillId) {
      if (skillId === 0) return false;
      if (entity.slots.includes(skillId)) return false;
      if (entity.slots.length >= entity.slotCap) return false;
      entity.slots.push(skillId);
      this.log(`${entity.name} 的技能槽记录了【${skillName(skillId)}】（${entity.slots.length}/${entity.slotCap}）`, 'slot');
      return true;
    }

    /**
     * 判定失败时的反用：技能交给“对方”——也就是除自己以外的所有玩家。
     * 本体失败 → 全体其他玩家的本体；替身失败 → 全体其他玩家的替身。
     * 谁的技能槽容纳得下，谁就代为使用（并占用自己的技能槽）。
     */
    async applyBacklash(actor, skillId) {
      const skill = SKILL_BY_ID.get(skillId);
      const receivers = this.backlashReceivers(actor);

      if (!receivers.length) {
        const why = actor.isStandin ? '其他玩家都没有替身' : '没有可承接的实体';
        this.log(`判定失败，技能没有生效（${why}）`, 'fail');
        return;
      }

      let used = 0;
      for (const receiver of receivers) {
        if (this.over) return;
        if (!receiver || !receiver.alive || !this.canUseSkill(receiver, skillId)) {
          this.log(`${receiver ? receiver.name : '该实体'} 无法承接【${skill.name}】（技能槽已满或实体不存在）`, 'fail');
          continue;
        }
        used += 1;
        this.log(`判定失败！由 ${receiver.name} 代为使用【${skill.name}】`, 'fail');
        this.occupy(receiver, skillId);
        await this.resolveSkill(receiver, skillId, { forced: true, originalActor: actor });
      }

      if (!used) {
        this.log('判定失败，技能没有生效（对方技能槽已满，无法容纳）', 'fail');
      }
    }

    async resolveSkill(actor, skillId, ctx) {
      if (skillId === 0) {
        // 反用普通攻击只会打回原使用者本人
        if (ctx.forced) {
          const target = ctx.originalActor || null;
          if (target && target.alive) {
            await this.resolveAttack(actor, [target]);
          } else {
            this.log('没有可攻击的目标', 'fail');
          }
          return;
        }
        await this.attackGroup(actor);
        return;
      }

      await this.applyEffect(actor, skillId);
    }

    /**
     * 普通攻击：选择攻击“全体对手本体”还是“全体对手替身”，
     * 一次对组内每个存活实体造成 1 点伤害。
     */
    async attackGroup(actor) {
      const enemies = this.enemiesOf(actor.owner);
      const options = [
        { id: 'bodies', kind: 'body', label: '全体对手本体', entities: enemies.filter((entity) => !entity.isStandin) },
        { id: 'standins', kind: 'standin', label: '全体对手替身', entities: enemies.filter((entity) => entity.isStandin) }
      ];

      const option = await this.pickTargetGroup(actor, options, '选择普通攻击的目标');
      if (!option) {
        this.log('没有可攻击的目标', 'fail');
        return;
      }

      const targets = option.entities.filter((entity) => entity.alive);
      this.log(`${actor.name} 的【普通攻击】攻击${option.label}：${targets.map((entity) => entity.name).join('、')}`, 'attack');

      await this.resolveAttack(actor, targets);
    }

    async pickTargetGroup(actor, options, purpose) {
      const usable = options.filter((option) => option.entities && option.entities.length);
      if (!usable.length) return null;
      if (usable.length === 1) return usable[0];

      const id = await this.io.chooseTarget({
        playerIdx: actor.owner,
        actor: this.describe(actor),
        purpose,
        options: usable.map((option) => ({
          id: option.id,
          kind: option.kind,
          label: option.label,
          entities: option.entities.map((entity) => this.describe(entity))
        }))
      });

      return usable.find((option) => option.id === id) || usable[0];
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

    /**
     * 恢复本体的生命值上限（随存活人数动态变化），并保证当前生命值不超过上限。
     * 拆分解除时剩余阶段数可能超过新的上限，这时要削到上限。
     */
    applyBodyMaxHp(entity, hp) {
      entity.maxHp = this.bodyMaxHp();
      entity.hp = Math.max(1, Math.min(hp, entity.maxHp));
      return entity.hp;
    }

    toggleSplit(entity) {
      if (entity.split) {
        const remaining = entity.split.remaining;
        entity.split = null;
        this.applyBodyMaxHp(entity, remaining);
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
          // 同样按自伤结算（source = null → 不是真实伤害）
          await this.damage(null, entity, record, { ignoreTenacity: true, fromTenacity: true });
        }
        return;
      }

      entity.tenacity = true;
      entity.tenacityRecord = 0;
      this.log(`${entity.name} 获得韧性：记录生命值的减少量`, 'effect');
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

      // 幸运币：掷数者自己的实体可以重掷自己的结果
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

      // 诅咒币：对方＝除掷数者以外的所有玩家，都可以干预这次随机数
      for (const player of this.othersOf(roller.owner)) {
        for (const entity of [player.body, player.standin]) {
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

      // 手动方表态「不再使用」后就不再重复弹面板，但托管硬币仍要按规则收尾
      let manualDone = false;

      while (true) {
        const coins = this.collectCoinInterventions(roller, used);
        // 硬币用尽后直接结束，不再保留确认面板
        if (!coins.length) break;

        // ① 掷数者自己的托管幸运币：先于手动决策结算
        const escrowedLucky = coins.find((coin) => coin.coin === 'lucky' && this.isEscrowed(coin.playerIdx));
        if (escrowedLucky) {
          current = await this.resolveEscrowedCoin(
            escrowedLucky, roller, label, current, sides, isCheck, meta, rollAgain, used
          );
          continue;
        }

        // ② 未托管玩家的硬币：交给面板手动决定（托管硬币不进面板）
        const manualCoins = coins.filter((coin) => !this.isEscrowed(coin.playerIdx));
        if (manualCoins.length && !manualDone) {
          const decision = await this.io.chooseCoinIntervention({
            roller: this.describe(roller),
            label,
            value: current,
            sides,
            isCheck,
            kind: isCheck ? 'check' : 'die',
            display: this.formatValue(current, sides, isCheck),
            coins: manualCoins,
            escrowed: coins.filter((coin) => this.isEscrowed(coin.playerIdx)),
            meta: meta || null
          });

          if (!decision || decision.done) {
            manualDone = true;
            continue;
          }

          const coin = manualCoins.find((item) => item.id === decision.coinId);
          if (!coin) {
            manualDone = true;
            continue;
          }

          const holder = this.getEntity(coin.holderId);
          if (!holder || !holder.alive || holder[coin.coin] <= 0) {
            used.add(coin.id);
            continue;
          }

          current = await this.spendCoinAndReroll(roller, label, coin, current, sides, isCheck, meta, rollAgain, used);
          continue;
        }

        // ③ 托管玩家的诅咒币：最后结算，保证作用在「最终判定值」上
        const escrowedCurse = coins.find((coin) => this.isEscrowed(coin.playerIdx));
        if (escrowedCurse) {
          current = await this.resolveEscrowedCoin(
            escrowedCurse, roller, label, current, sides, isCheck, meta, rollAgain, used
          );
          continue;
        }

        break;
      }

      return current;
    }

    /**
     * 托管硬币的自动决策：用还是弃权完全由规则决定。
     * 用掉 → 重掷并返回新值；弃权 → 保留硬币，只在本次判定中失效。
     */
    async resolveEscrowedCoin(coin, roller, label, current, sides, isCheck, meta, rollAgain, used) {
      const holder = this.getEntity(coin.holderId);
      if (!holder || !holder.alive || holder[coin.coin] <= 0) {
        used.add(coin.id);
        return current;
      }
      if (!this.shouldUseEscrowedCoin(coin, current, isCheck)) {
        used.add(coin.id);
        const coinName = coin.coin === 'lucky' ? '幸运币' : '诅咒币';
        this.log(`${holder.name} 托管硬币：本次弃权${coinName}`, 'coin');
        return current;
      }
      return await this.spendCoinAndReroll(roller, label, coin, current, sides, isCheck, meta, rollAgain, used);
    }

    /** 消费一枚硬币并重掷，返回新的结果 */
    async spendCoinAndReroll(roller, label, coin, current, sides, isCheck, meta, rollAgain, used) {
      const holder = this.getEntity(coin.holderId);
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
      return next;
    }

    /** 该玩家是否开启了硬币托管 */
    isEscrowed(playerIdx) {
      const player = this.players[playerIdx];
      return Boolean(player && player.escrow);
    }

    /** 运行中开关某位玩家的硬币托管（对局内的按钮就调它） */
    setCoinEscrow(playerIdx, on) {
      const player = this.players[playerIdx];
      if (!player) return false;
      player.escrow = !!on;
      this.log(`${player.name} ${player.escrow ? '开启' : '关闭'}硬币托管`, 'system');
      this.emitChanged();
      return player.escrow;
    }

    /**
     * 托管规则：硬币用不用由规则决定，不再手动确认。
     *   · **自己的幸运币**：判定失败才用（已经成功就别重掷）→ 自己投出 1 时弃权。
     *   · **对手的诅咒币**：对方判定成功才用（已经失败就别重掷）→ 对方投出 0 时弃权。
     *   · 非判定（骰子，如偷取随机选择）：一律不干预。
     * 与难度 2 的硬币策略一致，但它是**可选**功能：
     * 托管会用幸运币把失败的判定救回来，削弱“故意普攻失败 → 自伤 → 复活 → 刷技能槽”这类打法。
     */
    shouldUseEscrowedCoin(coin, value, isCheck) {
      if (!isCheck) return false;
      const success = value === 1;
      if (coin.coin === 'lucky') return !success; // 自己失败 → 用幸运币救
      return success; // 对方成功 → 用诅咒币压
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
    //
    // 这里有两类效果，**结算口径不同**。改这块之前先读这一段（坑位见 HANDOFF §9-24）：
    //
    // 1) **行动者的一次性效果**（磨刀 / 小偷）——按“**一次行动**”结算，不是按“一个目标”。
    //    · 磨刀是“这一次攻击”的伤害加成：群体攻击时**整组共享同一份加成**，
    //      攻击结束后才统一消耗（见 resolveAttack）。真实伤害（异质）不增幅也不消耗。
    //    · 小偷是“伤害结算后”触发：整组只触发一次（第一次命中就清掉标志位）。
    // 2) **目标自己的效果**（护盾 / 韧性 / 反甲）——按“**每一个目标**”结算，在 damage() 里处理。
    //
    // 早先磨刀是在 damage() 里逐目标消费的，于是组内第一个目标就把磨刀吃掉，
    // 后面的目标只吃 1 点基础伤害——带护盾的目标等于完全没被命中。已修。

    /**
     * 结算一次普通攻击：行动者对一组目标各造成 1 点伤害（可被磨刀增幅）。
     *
     * 这是“行动者的一次性效果”的结算层：
     *   · 磨刀：整组共用的加成，攻击结束后统一消耗；
     *   · 小偷：整组只触发一次（在 damage() 里第一次命中时清掉标志位）。
     * 目标自己的效果（护盾 / 韧性 / 反甲）由 damage() 逐目标结算。
     *
     * @param {object} actor 行动者
     * @param {Array} targets 目标实体列表（已死 / 主人已退场的会被跳过）
     * @param {object} opts { amountFinal } 传 true 表示伤害值已定，不要再增幅磨刀
     */
    async resolveAttack(actor, targets, opts = {}) {
      const bonus = actor.sharpen > 0 ? actor.sharpen : 0;
      let sharpenUsed = false;

      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        if (this.over || !target || !target.alive) continue;
        // 目标的主人已经退场就不再结算（退场会连带清掉替身，这里只是兜底）
        const owner = this.players[target.owner];
        if (!owner || !owner.body || !owner.body.alive) continue;
        if (i > 0) await this.beat(260);

        let amount = 1;
        // 真实伤害（异质对无异质）既不增幅也不消耗磨刀层数
        if (!opts.amountFinal && bonus > 0 && actor.hetero === target.hetero) {
          amount = 1 + bonus;
          if (!sharpenUsed) {
            sharpenUsed = true;
            this.log(`${actor.name} 消耗 ${bonus} 层【磨刀】，伤害提升至 ${amount}`, 'damage');
          }
        }
        await this.damage(actor, target, amount, { amountFinal: true });
      }

      if (sharpenUsed) actor.sharpen = 0;
    }

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
        this.log(`真实伤害：${target.name} 的护盾 / 反甲 / 小偷不触发`, 'damage');
        if (source && source.sharpen > 0) {
          this.log(`${source.name} 的磨刀层数保留（${source.sharpen} 层）`, 'effect');
        }
      } else if (source && source.sharpen > 0 && !opts.amountFinal) {
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

      // 韧性：记录「生命值减少值」并延迟结算。
      // 真实伤害也会被韧性承接并记录（真伤无视护盾，所以减少值就是全额）；
      // 但真伤仍然不触发护盾 / 反甲 / 小偷这些其他效果。
      if (target.tenacity && dmg > 0 && !opts.ignoreTenacity) {
        target.tenacityRecord += dmg;
        changed = true;
        this.log(`${target.name} 的【韧性】记录 ${dmg} 点生命值减少（累计 ${target.tenacityRecord}）`, 'effect');
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
        let thornsTargets = [];
        if (source && source.alive && source.owner !== target.owner) {
          thornsTargets = [source];
        } else {
          // 自伤：打向其他所有玩家的本体
          thornsTargets = this.opponentBodies(target.owner);
        }

        if (thornsTargets.length) {
          target.thorns = 0;
          const names = thornsTargets.map((entity) => entity.name).join('、');
          this.log(`${target.name} 的【反甲】反击 ${names}`, 'effect');
          await this.beat(340);
          for (const thornsTarget of thornsTargets) {
            if (this.over || !thornsTarget.alive) continue;
            await this.damage(target, thornsTarget, 1, { depth: depth + 1, isThorns: true });
          }
        }
      }

      if (target.hp <= 0 && target.alive) {
        await this.handleDepleted(target);
        // 兜底：复活流程异常中断时，不能留下“还活着但血量为 0”的实体
        if (target.hp <= 0 && target.alive) {
          target._dying = false;
          await this.eliminate(target);
        }
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
          this.applyBodyMaxHp(entity, data.remaining);
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
            this.applyBodyMaxHp(entity, remaining);
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
        // 替身只有 1 点生命，被打空就直接消失：不进行复活判定，也不做负生命惩罚判定。
        // （平衡性调整：替身是纯粹的“一次性挡箭牌”，不再自带第二次生命。）
        if (entity.isStandin) {
          await this.eliminate(entity);
          return;
        }

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
      entity.maxHp = entity.isStandin ? STANDIN_MAX_HP : this.bodyMaxHp();
      const splitRemaining = opts.splitRemaining;
      entity.hp = splitRemaining != null ? Math.max(1, Math.min(splitRemaining, entity.maxHp)) : entity.maxHp;
      this.clearEffects(entity);
      entity.slots = [];

      if (splitRemaining != null) {
        this.log(`${entity.name} 复活，拆分解除，生命值重置为 ${entity.hp}/${entity.maxHp}；清除其他效果并释放技能槽`, 'revive');
      } else {
        this.log(`${entity.name} 复活：生命值回满，清除所有效果并释放技能槽`, 'revive');
      }

      // 本体复活时替身一并消散：不允许同时拥有满血本体和替身。
      if (!entity.isStandin) {
        this.removeStandin(this.players[entity.owner], '随本体复活一同消散', 'effect');
      }

      await this.beat(500);
    }

    /**
     * 清掉某位玩家的替身。
     * 替身是本体的附属单位：本退场或本体复活时都要一起清掉，
     * 否则已退场玩家的替身会继续留在“全体对手替身”组里被攻击、判定、复活，
     * 群体伤害的结算就会算到已经退场的人头上。
     */
    removeStandin(owner, reason, type = 'effect') {
      const standin = owner && owner.standin;
      if (!standin) return false;
      owner.standin = null;
      if (standin.alive) {
        standin.alive = false;
        standin.hp = 0;
        standin.slots = [];
        this.clearEffects(standin);
      }
      this.log(`${standin.name} ${reason}`, type);
      return true;
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

      // 本体出局：替身随之消散（已退场的玩家不该再留在任何目标组里）
      this.removeStandin(owner, '随本体退场一同消散', 'death');
      this.passStreak.delete(entity.owner);

      // 本体出局：多人模式下只是退场，场上只剩一人时才结束战斗
      const survivors = this.alivePlayers();
      this.log(`${owner.name} 的生命值耗尽且复活失败，${this.isMultiplayer() ? '退场' : '战斗结束'}！`, 'death');
      this.recordElimination(entity.owner);

      if (survivors.length > 1) {
        this.log(`场上还剩 ${survivors.length} 人：${survivors.map((player) => player.name).join('、')}`, 'system');
        // 人数减少 → 剩余玩家的生命值上限下调（否则多人局很难结束）
        this.syncMaxHp();
        this.emitChanged();
        return;
      }

      this.over = true;
      // 反甲连锁可能同时带走最后两人，此时判平局
      this.winner = survivors.length === 1 ? survivors[0].index : null;
      this.finalizeStats();
      if (this.winner === null) {
        this.drawReason = 'all-dead';
        this.log('无人存活，本局平局', 'system');
        this.io.onGameOver({ winner: null, winnerName: null, draw: true });
      } else {
        this.log(`${this.players[this.winner].name} 获得胜利！`, 'system');
        this.io.onGameOver({
          winner: this.winner,
          winnerName: this.players[this.winner].name
        });
      }
      this.emitChanged();
    }

    /** 记录退场信息（战报里的“退场顺序 / 存活回合 / 最终排名”都靠它） */
    recordElimination(playerIdx) {
      const stats = this.stats[playerIdx];
      if (stats) {
        stats.eliminatedTurn = this.turn;
        stats.survivedTurns = this.turn;
      }
      const player = this.players[playerIdx];
      if (player) this.eliminationOrder.push({ index: playerIdx, name: player.name, turn: this.turn });
    }

    /** 战斗结束时把还在场上的玩家补齐统计 */
    finalizeStats() {
      for (const player of this.players) {
        const stats = this.stats[player.index];
        if (!stats) continue;
        if (stats.eliminatedTurn == null) stats.survivedTurns = this.turn;
      }
      for (const row of this.finalRanking()) {
        const stats = this.stats[row.index];
        if (stats) stats.rank = row.rank;
      }
    }

    /**
     * 最终排名：胜者第一；其余按“在场上待得更久”排序（最后退场的排在前面）。
     * 和局时**还在场上的玩家并列第一**；全员阵亡（真没人赢）时不排名。
     * @returns {Array<{index:number,name:string,rank:number|null,tied:boolean,survivedTurns:number,eliminatedTurn:number|null,alive:boolean}>}
     */
    finalRanking() {
      const elimOrder = new Map(this.eliminationOrder.map((item, i) => [item.index, i]));
      const rows = this.players.map((player) => {
        const stats = this.stats[player.index] || {};
        return {
          index: player.index,
          name: player.name,
          survivedTurns: stats.survivedTurns || 0,
          eliminatedTurn: stats.eliminatedTurn == null ? null : stats.eliminatedTurn,
          alive: Boolean(player.body && player.body.alive)
        };
      });

      const draw = this.over && this.winner == null;
      rows.sort((a, b) => {
        if (a.index === this.winner) return -1;
        if (b.index === this.winner) return 1;
        if (a.survivedTurns !== b.survivedTurns) return b.survivedTurns - a.survivedTurns;
        const ea = elimOrder.has(a.index) ? elimOrder.get(a.index) : -1;
        const eb = elimOrder.has(b.index) ? elimOrder.get(b.index) : -1;
        if (ea !== eb) return eb - ea; // 后退场的排前面
        return a.index - b.index;
      });

      if (draw) {
        const aliveRows = rows.filter((row) => row.alive);
        if (aliveRows.length) {
          // 和局：还在场上的玩家并列第一，其余按存活回合排在后面
          aliveRows.forEach((row) => { row.rank = 1; });
          let next = aliveRows.length + 1;
          rows.filter((row) => !row.alive).forEach((row) => { row.rank = next; next += 1; });
        } else {
          rows.forEach((row) => { row.rank = null; });
        }
      } else {
        rows.forEach((row, i) => { row.rank = i + 1; });
      }

      // 同一名次的人数 > 1 → 并列
      const count = new Map();
      rows.forEach((row) => {
        if (row.rank == null) return;
        count.set(row.rank, (count.get(row.rank) || 0) + 1);
      });
      rows.forEach((row) => {
        row.tied = row.rank != null && count.get(row.rank) > 1;
      });

      return rows;
    }

    // ---------------------------------------------------------- 回合

    async settleTenacity(entity) {
      const record = entity.tenacityRecord;
      const half = Math.ceil(record / 2);
      entity.tenacity = false;
      entity.tenacityRecord = 0;
      this.log(`${entity.name} 的【韧性】在回合结束结算：${record} 的记录伤害减半为 ${half} 点`, 'effect');
      // 延迟结算的伤害一律按**自伤**处理（source 传 null）：
      // 不是真实伤害 → 护盾照挡、反甲照反击到对手本体、伤害不记到任何玩家账上。
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

      this.current = this.nextPlayerAfter(this.current);
      this.turn += 1;
      this.announceTurn();
      this.emitChanged();

      // 超过回合上限（人数 × DRAW_TURNS_PER_PLAYER）→ 和局，避免一局打太久
      if (this.turn > this.drawTurnLimit()) {
        await this.declareDraw('turn-limit');
      }
    }

    /** 和局的回合上限：人数 × DRAW_TURNS_PER_PLAYER */
    drawTurnLimit() {
      return this.players.length * DRAW_TURNS_PER_PLAYER;
    }

    /**
     * 判定和局并结束战斗。
     * @param {string} reason 'turn-limit'（超上限）/ 'pass-streak'（全场跳过）
     */
    async declareDraw(reason) {
      if (this.over) return;
      this.over = true;
      this.winner = null;
      this.drawReason = reason;
      this.finalizeStats();

      if (reason === 'turn-limit') {
        this.log(`超过 ${this.drawTurnLimit()} 回合上限，本局和局`, 'system');
      } else {
        this.log('场上所有玩家都选择跳过回合，本局和局', 'system');
      }
      const alive = this.alivePlayers();
      if (alive.length) {
        this.log(`仍在场上的 ${alive.map((player) => player.name).join('、')} 并列第一`, 'system');
      }
      this.io.onGameOver({ winner: null, winnerName: null, draw: true, reason });
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
    normalizeNames,
    bodyMaxHpFor,
    BODY_MAX_HP,
    BODY_SLOTS,
    STANDIN_MAX_HP,
    STANDIN_SLOTS,
    MIN_PLAYERS,
    MAX_PLAYERS,
    DRAW_TURNS_PER_PLAYER,
    MODE_DUEL,
    MODE_BATTLE
  };
});
