/*
 * 杀币战争 · 启发式 AI
 * ------------------------------------------------------------
 * 纯函数模块，不依赖 DOM。
 *   难度 1（简单）：随机试探，靠固定优先级 + 概率触发。
 *   难度 2（进阶）：先读懂局面，再按“这一手能换回多少”排序出手；
 *                  硬币会区分“这次掷数对谁有利”，不随便浪费。
 * 游戏本身有大量随机判定，所以这里追求的是“明显更合理”，不是最优解。
 *
 * 难度 2 依赖的几条规则认知（都用 scripts/probe-mechanics.cjs 验证过）：
 *   1. 普通攻击不占技能槽，判定失败只会自伤 1 点，**技能不会白送对方**；
 *      其他技能判定失败会把技能白送给对方（本体失败→对方本体，替身失败→对方替身），
 *      对方技能槽满了才会落空。
 *   2. 普通攻击一次覆盖一整组（全体对手本体 / 全体对手替身）。
 *   3. 反甲在自己普攻失败触发自伤时，会把 1 点伤害打向对方本体。
 *   4. 磨刀放大的是“下一次伤害”，自伤也算，所以它同时放大自己的风险。
 *   5. 幸运币 / 诅咒币是**覆盖**原结果：幸运币把失败救回来（成功率 50%→75%），
 *      诅咒币把对方的成功压成失败（成功率 50%→25%）。
 *   6. 替身**不再复活**：被打空直接消失；本体退场或本体复活时替身一并消散。
 *      所以替身是一次性挡箭牌，召唤它非常划算。
 *   7. 本体生命值上限＝在场人数 + 1，有人退场时剩余玩家的上限会下调。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SBWarAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIFFICULTY = { EASY: 1, HARD: 2 };
  const LEVEL_LABELS = { 1: '简单', 2: '进阶' };

  /** 从参数里取难度，任何非 2 的值都按难度 1 处理 */
  function levelOf(options) {
    return options && Number(options.level) === DIFFICULTY.HARD ? DIFFICULTY.HARD : DIFFICULTY.EASY;
  }

  function levelLabel(level) {
    return LEVEL_LABELS[levelOf({ level })] || LEVEL_LABELS[DIFFICULTY.EASY];
  }

  // ------------------------------------------------------------ 通用工具

  /** 除自己以外的所有存活实体（本体 + 替身） */
  function enemiesOf(game, playerIdx) {
    if (!game || typeof game.othersOf !== 'function') return [];
    return game.othersOf(playerIdx)
      .flatMap((player) => [player.body, player.standin])
      .filter((entity) => entity && entity.alive);
  }

  function hasDefense(entities) {
    return (entities || [])
      .filter(Boolean)
      .some((entity) => entity.alive && (entity.shield > 0 || entity.thorns > 0 || entity.tenacity));
  }

  /** 敌人身上是否存在“值得偷”的效果 */
  function hasStealable(entity) {
    if (!entity) return false;
    return (
      entity.sharpen > 0 ||
      entity.shield > 0 ||
      Boolean(entity.split) ||
      entity.tenacity ||
      entity.thorns > 0 ||
      entity.lucky > 0 ||
      entity.curse > 0 ||
      entity.thief ||
      entity.hetero
    );
  }

  /**
   * 有效生命：护盾算 1 点；韧性记录的是“迟早要掉的血”，按结算后的一半计入；
   * 拆分时每个阶段只有 1 点但各自能复活，所以按剩余阶段数算。
   */
  function effectiveHp(entity) {
    if (!entity) return 0;
    let hp = Math.max(0, entity.hp);
    if (entity.split) hp = Math.max(hp, entity.split.remaining);
    if (entity.shield > 0) hp += 1;
    if (entity.tenacity && entity.tenacityRecord > 0) hp += Math.ceil(entity.tenacityRecord / 2);
    return hp;
  }

  /**
   * 预计本回合要承受的伤害。
   * 假设：每位对手实体有约七成半概率出手；多人局普通攻击是群体攻击，
   * 对手更倾向打与其本体/替身同组的实体；磨刀会放大伤害。
   */
  function estimateIncoming(entity, enemies) {
    if (!entity) return 0;
    let total = 0;
    for (const enemy of enemies || []) {
      const amp = 1 + Math.min(2, enemy.sharpen || 0);
      const hit = enemy.isStandin === entity.isStandin ? 0.85 : 0.3;
      total += amp * hit * 0.75;
    }
    return total;
  }

  /** 对手是否能靠护盾 / 异质挡住真实伤害之外的东西（决定反甲是否划算） */
  function hasPierceable(enemies) {
    return (enemies || []).some((enemy) => !enemy.hetero && (enemy.shield > 0 || enemy.tenacity));
  }

  /** 攻击某个目标组的收益（进阶 AI 用来比较“本体组”与“替身组”） */
  function groupValue(actor, entities) {
    let value = 0;
    for (const entity of entities) {
      if (entity.isStandin) {
        // 拆掉替身 = 少一个能行动、能被选中的单位（替身不再复活，打掉就真的没了）
        value += 55;
        continue;
      }
      if (entity.hp <= 1) value += 150; // 可能直接送走
      else value += 20 * (1 + Math.min(2, actor.sharpen || 0));
      if (entity.shield > 0) value -= 12;
      if (entity.tenacity) value -= 14;
    }
    return value;
  }

  /** 本体 / 替身两组的预估收益 */
  function bestAttackGroup(actor, enemies) {
    const bodies = enemies.filter((entity) => !entity.isStandin);
    const standins = enemies.filter((entity) => entity.isStandin);
    const bodyValue = groupValue(actor, bodies);
    const standinValue = groupValue(actor, standins);
    const useBodies = bodyValue >= standinValue;
    const value = useBodies ? bodyValue : standinValue;
    const count = useBodies ? bodies.length : standins.length;
    if (!count || value <= 0) return null;

    const lethal = (useBodies ? bodies : standins).some((entity) => entity.hp <= 1);
    return {
      id: useBodies ? 'bodies' : 'standins',
      entities: useBodies ? bodies : standins,
      count,
      value,
      lethal,
      why: lethal
        ? `打${useBodies ? '本体组' : '替身组'}能收割 1 血目标`
        : `打${useBodies ? '本体组' : '替身组'}更划算`
    };
  }

  // ------------------------------------------------------------ 行动者

  function chooseActor(game, playerIdx, options) {
    const actors = game.getActors(playerIdx);
    if (!actors.length) return null;
    const body = actors.find((entity) => !entity.isStandin) || null;
    const standin = actors.find((entity) => entity.isStandin) || null;

    // 本体只剩 1 点生命时，优先让替身行动，避免本体被反噬 / 群攻打死
    if (body && body.hp <= 1 && standin) return standin;

    if (levelOf(options) !== DIFFICULTY.HARD) return body || standin;

    if (!body || !standin) return body || standin;

    // 本体血量偏低：普攻失败的自伤会把它打到 0，交给替身扛这一手
    // 阈值两种口径：
    //   绝对值（standinActorRelative = 0）：本体血量 ≤ standinActorHp 就让替身上
    //   相对值（standinActorRelative = 1）：本体没满血就让替身上（= 上限 - 1），
    //     这样本体满血时一定会自己出手，不会退化成“本体只负责召唤、替身负责输出”
    const switchHp = HARD_TUNE.standinActorRelative
      ? Math.max(1, body.maxHp - 1)
      : HARD_TUNE.standinActorHp;
    if (body.hp <= switchHp) return standin;
    // 本体再高一点但带着磨刀：自伤会被放大，同样致命
    if (body.hp <= switchHp + 1 && body.sharpen > 0) return standin;
    return body;
  }

  // ------------------------------------------------------------ 难度 1

  function chooseActionEasy(game, playerIdx, rng) {
    if (!game || game.over || game.busy || game.current !== playerIdx) return null;

    const player = game.players[playerIdx];
    const opponents = typeof game.othersOf === 'function' ? game.othersOf(playerIdx) : [];
    if (!player || !opponents.length) return null;

    const actor = chooseActor(game, playerIdx);
    if (!actor) return null;

    const skills = game.getSkillsFor(actor).filter((skill) => skill.available);
    if (!skills.length) return null;

    const byId = (id) => skills.find((skill) => skill.id === id) || null;
    const action = (id) => (byId(id) ? { actorId: actor.id, skillId: id } : null);
    const enemyEntities = opponents.flatMap((opponent) => [opponent.body, opponent.standin]).filter(Boolean);
    const finishingBody = enemyEntities.find((entity) => !entity.isStandin && entity.alive && entity.hp <= 1) || null;
    const enemyDefense = hasDefense(enemyEntities);

    // 濒死时优先保命
    if (actor.hp <= 1 && actor.shield <= 0 && byId(2)) return action(2);
    if (actor.hp <= 1 && !actor.tenacity && byId(4)) return action(4);

    // 对手本体只剩 1 生命：普攻补刀
    if (finishingBody && byId(0)) return action(0);

    // 没有替身时先召唤，制造额外的行动与承伤单位
    if (!player.standin && byId(9) && actor.hp >= 2 && rng() < 0.65) return action(9);

    if (actor.sharpen < 2 && byId(1) && rng() < 0.35) return action(1);
    if (actor.shield <= 0 && byId(2) && rng() < 0.3) return action(2);
    if (!actor.tenacity && byId(4) && actor.hp <= 2 && rng() < 0.25) return action(4);
    if (actor.thorns <= 0 && byId(5) && rng() < 0.2) return action(5);
    if (!actor.thief && byId(8) && rng() < 0.2) return action(8);
    if (actor.lucky <= 0 && byId(6) && rng() < 0.25) return action(6);
    if (actor.curse <= 0 && byId(7) && rng() < 0.2) return action(7);
    if (!actor.hetero && byId(10) && enemyDefense && rng() < 0.4) return action(10);
    if (!actor.split && byId(3) && actor.hp >= 2 && rng() < 0.12) return action(3);

    // 普通攻击不占槽，永远作为兜底
    return action(0) || null;
  }

  // ------------------------------------------------------------ 难度 2

  /**
   * 难度 2 的评分常量。基准：**一次普通攻击 = 100 分**。
   * 普攻是游戏里唯一稳定的输出来源（每回合就 1 点伤害），
   * 其他技能都围着它上下浮动；分数低于 100 就等于“这一手不如直接打一拳”。
   */
  const HARD_SCORE = {
    ATTACK_BASE: 100,
    /** 命中对方本体 1 点血的进展分 */
    HIT_BODY: 26,
    /** 命中对方替身 1 点血的进展分：替身不是胜负条件，权重低得多 */
    HIT_STANDIN: 8,
    /** 这一下有机会直接送走对方本体（胜负手） */
    KILL_BODY: 66,
    /** 这一下有机会拆掉对方替身 */
    KILL_STANDIN: 14,
    /** 打在护盾上：护盾会被消耗掉，但这一下打不穿 */
    HIT_SHIELD: 5
  };

  /**
   * 技能评分用的调节参数。集中放在这里，方便用 scripts/ai-arena.cjs 做参数扫描，
   * 也方便以后按难度再细分一档。
   */
  const HARD_TUNE = {
    // —— 普攻
    attackPlanWeight: 0.6,
    /** 整组都被护盾挡住时的空转惩罚 */
    attackAllBlockedPenalty: 22,

    // —— 护盾
    shieldBase: 70,
    shieldAt1Hp: 55,
    shieldAt2Hp: 16,
    shieldEnemyAt1Hp: 40,
    shieldEnemyAt2Hp: 14,
    shieldEnemyShielded: 10,

    // —— 磨刀
    sharpenBase: 26,
    sharpenBlockedTarget: 44,
    sharpenGiftFizzle: 22,
    sharpenLowHp: 18,

    // —— 韧性
    tenacityBase: 30,
    tenacityLowHp: 26,
    tenacityEnemySharpen: 18,
    tenacityGiftFizzle: 14,
    tenacityEnemyAt1Hp: 20,

    // —— 反甲
    thornsBase: 34,
    thornsWithAttack: 24,
    thornsEnemyShielded: 26,
    thornsGiftFizzle: 20,
    thornsEnemyLowHp: 10,

    // —— 小偷
    thiefBase: 28,
    thiefTargetHasEffects: 48,
    thiefGiftFizzle: 16,

    // —— 异质
    heteroBase: 24,
    heteroEnemyShielded: 90,
    heteroEnemyTenacity: 40,
    heteroEnemyHasHetero: 30,
    heteroGiftFizzle: 16,

    // —— 幸运
    luckyBase: 40,
    luckyLowHp: 18,
    luckyGiftFizzle: 12,

    // —— 诅咒
    curseBase: 34,
    curseEnemyStealable: 16,
    curseEnemyLowHp: 26,
    curseGiftFizzle: 14,

    // —— 拆分
    splitBase: 24,
    splitFullHp: 34,
    splitEnemySharpen: 16,
    splitGiftFizzle: 12,

    // —— 召唤
    // 替身不再复活之后，它就是一块纯粹的“一次性挡箭牌”：
    // 顶在前面替本体扛自伤、也吃掉对手打向替身组的群体攻击。
    // 实测（scripts/ai-sweep-tune.cjs，1000 局同一批种子）：
    // 召唤权重 105→145 加上“替身在本体 3 血时就顶前面”，双人局胜率 64.5% → 76.8%；
    // 召唤权重低于 140 时 AI 会优先去收割 1 血对手，反而丢掉挡箭牌（69.0%）。
    summonBase: 145,
    summonEnemyNoStandin: 0,

    // —— 结构性参数
    /** 防御类技能（护盾 / 韧性 / 拆分）按对手数量放大的倍数系数 */
    defenseThreatScale: 1,
    /** 替身组的价值倍率：多人局里也可以考虑拆掉替身、扒掉对方的效果 */
    standinValueScale: 1,
    /** 本体只剩 1 血时，其他技能（护盾除外）的额外扣分：这一回合自伤就是致命 */
    lowHpSkillPenalty: -80,
    /** 本体血量低于等于这个值时，改为让替身行动（替身扛自伤，本体不至于被打死） */
    standinActorHp: 3,
    /**
     * 替身上场阈值用哪种口径：
     *   0 = 绝对值（本体血量 ≤ standinActorHp）
     *   1 = 相对值（本体没满血就让替身上，即上限 - 1）
     * 相对值能保证本体满血时一定自己出手，避免退化成“本体只召唤、替身只输出”。
     */
    standinActorRelative: 0,

    // —— 硬币策略开关（0 / 1）
    /** 自己普攻失败时，只要不是致死也用幸运币救 */
    luckyOnAttackFailure: 0,
    /** 对手技能判定成功时用诅咒币压掉（技能会转到我们身上） */
    curseOnEnemySkill: 1,
    /** 对手复活判定成功时用诅咒币压掉 */
    curseOnEnemyRevive: 1,
    /** 对手普攻成功时也用诅咒币压掉 */
    curseOnEnemyAttack: 0
  };

  /**
   * 一次性把决策要用的信息算清楚，避免到处翻状态。
   */
  function readBoard(game, playerIdx) {
    const player = game.players[playerIdx];
    if (!player) return null;

    const opponents = typeof game.othersOf === 'function' ? game.othersOf(playerIdx) : [];
    // 已经退场的玩家不再构成威胁：退场时替身也会一并消散
    const aliveOpponents = opponents.filter((opponent) => opponent.body && opponent.body.alive);
    const enemies = enemiesOf(game, playerIdx);
    const bodies = enemies.filter((entity) => !entity.isStandin);
    const standins = enemies.filter((entity) => entity.isStandin);
    const body = player.body && player.body.alive ? player.body : null;
    const standin = player.standin && player.standin.alive ? player.standin : null;

    // 对方本体里血量最低的那个 —— 收割目标
    let weakestBody = null;
    for (const entity of bodies) {
      if (!weakestBody || entity.hp < weakestBody.hp) weakestBody = entity;
    }

    return {
      game,
      player,
      playerIdx,
      opponents,
      aliveOpponents,
      enemies,
      bodies,
      standins,
      body,
      standin,
      weakestBody,
      weakestBodyHp: weakestBody ? weakestBody.hp : 99,
      // 对方本体带护盾 → 我的普攻会被挡下
      enemyShielded: bodies.some((entity) => entity.shield > 0),
      // 对方带磨刀 → 一次能打 2 点
      enemySharpen: bodies.some((entity) => entity.sharpen > 0),
      // 对方带韧性 → 伤害会被记录延后
      enemyTenacity: bodies.some((entity) => entity.tenacity),
      // 对方已经异质 → 我的伤害本来就是真实的，不需要再开异质
      enemyHetero: enemies.some((entity) => entity.hetero),
      // 对方技能槽满了 → 我的技能判定失败时技能会直接落空（不白送）
      enemySlotsFull:
        aliveOpponents.length > 0 &&
        aliveOpponents.every((opponent) => opponent.body && opponent.body.slots.length >= opponent.body.slotCap),
      // 对方没有替身 → 我方替身行动失败时技能会落空
      enemyHasStandin: aliveOpponents.some((opponent) => opponent.standin && opponent.standin.alive),
      enemyStealable: enemies.some(hasStealable),
      /** 对手数量：人越多每回合挨打越密，防御类技能越值钱（已退场的玩家不计入） */
      threat: Math.max(1, aliveOpponents.length),
      turn: game.turn
    };
  }

  /**
   * 评估一次普通攻击该打哪一组（全体对手本体 / 全体对手替身）。
   * 关键：对方**本体的生命值才是胜负条件**，替身只是附属单位，
   * 所以默认集火本体组；只有本体被护盾完全挡住、或者本体组整体更划算时才改打替身组。
   */
  function planAttack(actor, board) {
    const groups = [
      { id: 'bodies', kind: 'body', label: '对方本体', entities: board.bodies },
      { id: 'standins', kind: 'standin', label: '对方替身', entities: board.standins }
    ].filter((group) => group.entities.length);
    if (!groups.length) return null;

    const sharpen = Math.min(2, actor.sharpen || 0);
    let best = null;

    for (const group of groups) {
      let score = 0;
      let kills = 0;
      let blocked = 0;

      for (const entity of group.entities) {
        // 异质对异质 → 不是真实伤害；一真一假 → 真实伤害无视护盾
        const real = actor.hetero !== entity.hetero;
        if (entity.shield > 0 && !real) {
          // 这一下打在护盾上：护盾会被消耗掉，但血打不动
          score += HARD_SCORE.HIT_SHIELD;
          blocked += 1;
          continue;
        }
        score += entity.isStandin
          ? HARD_SCORE.HIT_STANDIN * HARD_TUNE.standinValueScale
          : HARD_SCORE.HIT_BODY;
        if (entity.hp <= 1 + sharpen) {
          // 本体打空之后还有一次复活判定，替身打空就直接没了
          score += entity.isStandin
            ? HARD_SCORE.KILL_STANDIN * HARD_TUNE.standinValueScale
            : HARD_SCORE.KILL_BODY;
          kills += 1;
        }
      }

      const item = {
        id: group.id,
        kind: group.kind,
        label: group.label,
        entities: group.entities,
        count: group.entities.length,
        score,
        kills,
        blocked
      };
      if (!best || item.score > best.score) best = item;
    }

    if (best) {
      const parts = [];
      if (best.kills) parts.push(best.kills > 1 ? `可能同时送走 ${best.kills} 个目标` : '有机会直接送走对方本体');
      if (best.blocked) parts.push('部分目标有护盾，只能打掉护盾');
      if (best.count > 1) parts.push(`一次覆盖 ${best.count} 个目标`);
      best.why = parts.length ? parts.join('，') : `打${best.label}更划算`;
    }
    return best;
  }

  /**
   * 给每个可用技能打分（基准：普攻 = 100 分）。
   *
   * 之所以默认给低分：**每个技能都是 50% 判定，失败会把技能白送给对方**
   * （本体失败→对方本体，替身失败→对方替身；对方技能槽满了才会落空）。
   * 而普攻失败只自伤，技能不会外流。所以技能只有在这几种情况下才值得：
   *   · 能救自己的命（本体只剩 1 血时的护盾）；
   *   · 能直接破掉对方的防御（护盾 / 韧性 → 异质）；
   *   · 失败也不会外流（对方技能槽已满）；
   *   · 对方已经 1 血，这种技能反而是在救对方。
   *
   * 另有两个例外被刻意抬高：召唤替身（替身能替本体扛自伤），
   * 以及本体 1 血时对其他技能统一扣分（这一回合的自伤可能直接致命）。
   */
  function scoreSkills(actor, board, plan, options) {
    const bodyHp = board.body ? effectiveHp(board.body) : 0;
    const myHp = effectiveHp(actor);
    const weakestHp = board.weakestBodyHp;
    const giftFizzle = board.enemySlotsFull;
    // 对手越多，每回合挨打越密，防御类技能越值钱
    const threat = board.threat * HARD_TUNE.defenseThreatScale;
    const push = (id, score, why) => {
      // 本体只剩 1 点时，浪费回合的技能会让普攻自伤直接致命（护盾除外，它不产生自伤）
      if (id !== 2 && bodyHp <= 1) score += HARD_TUNE.lowHpSkillPenalty;
      if (score > 0) options.push({ id, score, why });
    };

    // —— 护盾：挡 1 点伤害，连自己普攻失败的自伤一起挡
    {
      let score = HARD_TUNE.shieldBase;
      let why = '先上护盾，挡掉接下来这一下';
      if (bodyHp <= 1) {
        score += HARD_TUNE.shieldAt1Hp * threat;
        why = '本体只剩 1 点，护盾能替本体挡下致命一击';
      } else if (bodyHp <= 2) {
        score += HARD_TUNE.shieldAt2Hp * threat;
      }
      if (weakestHp <= 1) {
        score -= HARD_TUNE.shieldEnemyAt1Hp;
        why = '对方只剩 1 点，护盾送过去等于救他们，先打';
      } else if (weakestHp <= 2) {
        score -= HARD_TUNE.shieldEnemyAt2Hp;
      }
      if (board.enemyShielded) score -= HARD_TUNE.shieldEnemyShielded;
      push(2, score, why);
    }

    // —— 磨刀：下次伤害 +1，但也放大自伤，失败会把 +1 送给对方
    {
      let score = HARD_TUNE.sharpenBase;
      let why = '现在磨刀回本太慢';
      if (plan && plan.blocked > 0 && plan.kills === 0) {
        score += HARD_TUNE.sharpenBlockedTarget;
        why = '目标被护盾挡着，+1 点伤害能打穿护盾';
      }
      if (giftFizzle) {
        score += HARD_TUNE.sharpenGiftFizzle;
        why = '对方技能槽满了，磨刀失败也送不出去';
      }
      if (bodyHp <= 2) score -= HARD_TUNE.sharpenLowHp; // 自伤会被放大，很危险
      push(1, score, why);
    }

    // —— 韧性：把伤害记下来、回合末结算一半，等于多挨一下
    {
      let score = HARD_TUNE.tenacityBase;
      let why = '用韧性把伤害记下来，回合末只结算一半';
      if (bodyHp <= 2) {
        score += HARD_TUNE.tenacityLowHp * threat;
        why = '本体不厚，韧性可以多扛一下';
      }
      if (board.enemySharpen) {
        score += HARD_TUNE.tenacityEnemySharpen;
        why = '对方带磨刀（一次 2 点），韧性刚好折半';
      }
      if (giftFizzle) score += HARD_TUNE.tenacityGiftFizzle;
      if (weakestHp <= 1) score -= HARD_TUNE.tenacityEnemyAt1Hp;
      push(4, score, why);
    }

    // —— 反甲：挨打后反击 1 点；自己普攻失败的自伤也会触发，直接打到对方本体
    {
      let score = HARD_TUNE.thornsBase;
      let why = '架反甲，挨打时能还回去 1 点';
      if (plan) {
        score += HARD_TUNE.thornsWithAttack;
        why = '架反甲：普攻失败的自伤会反手打到对方本体';
      }
      if (board.enemyShielded) {
        score -= HARD_TUNE.thornsEnemyShielded;
        why = '对方有护盾，反甲打过去会被挡掉';
      }
      if (giftFizzle) score += HARD_TUNE.thornsGiftFizzle;
      if (weakestHp <= 2) score += HARD_TUNE.thornsEnemyLowHp;
      push(5, score, why);
    }

    // —— 小偷：下次造成伤害后随机偷走对方一个效果
    {
      let score = HARD_TUNE.thiefBase;
      let why = '目标身上没什么可偷的';
      const targetHas = plan && plan.entities.some(hasStealable);
      if (targetHas) {
        score += HARD_TUNE.thiefTargetHasEffects;
        why = '目标身上挂着效果，打完可以顺走一个';
      }
      if (giftFizzle) score += HARD_TUNE.thiefGiftFizzle;
      push(8, score, why);
    }

    // —— 异质：真实伤害，无视护盾 / 韧性 / 反甲
    {
      let score = HARD_TUNE.heteroBase;
      let why = '对方没有护盾，异质收益不大';
      if (board.enemyShielded) {
        score += HARD_TUNE.heteroEnemyShielded;
        why = '对方有护盾，异质能让伤害变成真实伤害';
      }
      if (board.enemyTenacity) {
        score += HARD_TUNE.heteroEnemyTenacity;
        why = '对方带韧性，异质让伤害直接生效';
      }
      if (board.enemyHetero) {
        score -= HARD_TUNE.heteroEnemyHasHetero;
        why = '对方已经异质，我的伤害本来就是真实的';
      }
      if (giftFizzle) score += HARD_TUNE.heteroGiftFizzle;
      push(10, score, why);
    }

    // —— 幸运：给自己一枚幸运币，判定失败时 50% 概率救回来
    {
      let score = HARD_TUNE.luckyBase;
      let why = '先囤一枚幸运币，关键判定能重掷';
      if (bodyHp <= 2) score += HARD_TUNE.luckyLowHp;
      if (giftFizzle) score += HARD_TUNE.luckyGiftFizzle;
      push(6, score, why);
    }

    // —— 诅咒：给对方一枚诅咒币，能压掉对方的成功判定（技能成功还能被抢过来）
    {
      let score = HARD_TUNE.curseBase;
      let why = '囤一枚诅咒币，能压掉对手的成功判定';
      if (board.enemyStealable) score += HARD_TUNE.curseEnemyStealable;
      // 对方快见底了：它多半要过复活判定，诅咒币正好能把它按死
      if (weakestHp <= 2) {
        score += HARD_TUNE.curseEnemyLowHp;
        why = '对方快挂了，诅咒币能压掉它的复活判定';
      }
      if (giftFizzle) score += HARD_TUNE.curseGiftFizzle;
      push(7, score, why);
    }

    // —— 拆分：把生命拆成多个 1 血阶段，逐阶段做复活判定
    {
      let score = HARD_TUNE.splitBase;
      let why = '拆分成多个阶段，逐阶段判定复活';
      if (bodyHp >= 3) {
        score += HARD_TUNE.splitFullHp * threat;
        why = '满血拆成多个 1 血阶段，本体更难被打穿';
      }
      if (board.enemySharpen) score -= HARD_TUNE.splitEnemySharpen; // 2 点伤害会让阶段直接崩掉
      if (giftFizzle) score += HARD_TUNE.splitGiftFizzle;
      push(3, score, why);
    }

    // —— 召唤：多一个 1 血替身。
    // 替身不再复活之后，它就是一块纯粹的一次性挡箭牌，这一项在进阶 AI 里权重很高：
    //   1) 替身顶在前面替本体扛自伤（普攻失败的反噬打在替身上，本体就安全）；
    //   2) 替身在场时，对手打向“全体对手替身”的群体攻击大多打在替身上；
    //   3) 本体血量偏低时改由替身出手，让一次性单位去承担失败普攻的风险。
    // 实测（scripts/ai-sweep-tune.cjs，1000 局同一批种子）：召唤权重 105→145
    // 加上“替身在本体 3 血时就顶前面”，双人局胜率 64.5% → 78.8%。
    {
      let score = HARD_TUNE.summonBase;
      let why = '召唤一个替身：它能替本体扛自伤，也能吃掉对手打向替身组的群体攻击';
      if (!board.enemyHasStandin) {
        score += HARD_TUNE.summonEnemyNoStandin;
        why = '对方没有替身：我方替身行动失败时技能会直接落空';
      }
      push(9, score, why);
    }
  }

  /**
   * 进阶 AI：把每个可用技能换算成“这一手能换回多少”，取最高分。
   * 打分只依赖公开状态，不做搜索；目的是让行为稳定且明显强于随机试探。
   */
  function chooseActionHard(game, playerIdx, rng) {
    if (!game || game.over || game.busy || game.current !== playerIdx) return null;

    const board = readBoard(game, playerIdx);
    if (!board || !board.enemies.length) return null;

    const actor = chooseActor(game, playerIdx, { level: DIFFICULTY.HARD });
    if (!actor) return null;

    const skills = game.getSkillsFor(actor).filter((skill) => skill.available);
    if (!skills.length) return null;
    const byId = (id) => skills.find((skill) => skill.id === id) || null;
    const action = (id, why) => (byId(id) ? { actorId: actor.id, skillId: id, why } : null);

    const plan = planAttack(actor, board);
    const options = [];

    // —— 普通攻击：默认动作，也是所有技能的比较基准
    if (plan) {
      const bonus = (plan.score - HARD_SCORE.HIT_BODY) * HARD_TUNE.attackPlanWeight;
      let score = HARD_SCORE.ATTACK_BASE + bonus;
      // 整组都被护盾挡住 → 这一拳打不穿，只能打掉护盾，不如先做点别的
      if (plan.blocked > 0 && plan.blocked >= plan.count) score -= HARD_TUNE.attackAllBlockedPenalty;
      options.push({
        id: 0,
        score,
        why: plan.why
      });
    }

    // —— 技能：只有明显比“直接打一拳”更值时才出手
    scoreSkills(actor, board, plan, options);

    if (!options.length) return action(0, '没有更好的选择，直接普攻');

    // 极小的随机扰动：避免每次都选同一手，又不影响整体判断
    let best = options[0];
    let bestScore = -Infinity;
    for (const item of options) {
      const score = item.score + (rng ? (rng() - 0.5) * 6 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return action(best.id, best.why) || action(0, '直接普攻');
  }

  /**
   * 选择本回合的行动。
   * @param {object} options  { level: 1|2 }
   * @returns {{actorId: string, skillId: number, why?: string}|null}
   */
  function chooseAction(game, playerIdx, rng = Math.random, options = {}) {
    if (!game || game.over || game.busy || game.current !== playerIdx) return null;
    if (levelOf(options) === DIFFICULTY.HARD) return chooseActionHard(game, playerIdx, rng);
    return chooseActionEasy(game, playerIdx, rng);
  }

  // ------------------------------------------------------------ 目标组

  /** describe() 出来的实体只有 effects 列表，没有直接的 shield 字段 */
  function describedHasEffect(entity, key) {
    if (!entity) return false;
    if (entity.effects && Array.isArray(entity.effects)) {
      return entity.effects.some((chip) => chip && chip.key === key);
    }
    return false;
  }

  /**
   * 普通攻击的目标组：全体对手本体 / 全体对手替身。
   * @param {Array<{id: string, kind: string, entities: Array}>} options
   */
  function chooseTarget(options, opts) {
    if (!options || !options.length) return null;
    if (levelOf(opts) !== DIFFICULTY.HARD) {
      const bodies = options.find((option) => option.kind === 'body');
      const standins = options.find((option) => option.kind === 'standin');
      if (bodies && bodies.entities.some((entity) => entity.hp <= 1)) return bodies.id;
      if (standins && standins.entities.length) return standins.id;
      return (bodies || options[0]).id;
    }

    let best = options[0];
    let bestScore = -Infinity;
    for (const option of options) {
      let score = 0;
      for (const entity of option.entities || []) {
        if (entity.isStandin) {
          score += HARD_SCORE.HIT_STANDIN * HARD_TUNE.standinValueScale;
          if (entity.hp <= 1) score += HARD_SCORE.KILL_STANDIN * HARD_TUNE.standinValueScale;
          continue;
        }
        if (describedHasEffect(entity, 'shield')) {
          score += HARD_SCORE.HIT_SHIELD;
          continue;
        }
        score += HARD_SCORE.HIT_BODY;
        if (entity.hp <= 1) score += HARD_SCORE.KILL_BODY;
      }
      if (score > bestScore) {
        bestScore = score;
        best = option;
      }
    }
    return best.id;
  }

  // ------------------------------------------------------------ 硬币

  function coinOf(coins, playerIdx, kind) {
    return coins.find((coin) => coin.playerIdx === playerIdx && coin.coin === kind) || null;
  }

  function isReviveLabel(label) {
    return /复活|惩罚/.test(label || '');
  }

  function isAttackLabel(label) {
    return /普通攻击/.test(label || '');
  }

  /** 难度 1：只在“对己方不利”的掷数结果上动用硬币 */
  function chooseCoinEasy(payload, aiPlayerIndex) {
    if (!payload || payload.kind !== 'check' || !Array.isArray(payload.coins)) return null;
    if (!payload.roller) return null;

    const rollerIsAI = payload.roller.owner === aiPlayerIndex;
    const success = payload.value === 1;

    if (rollerIsAI && !success) return coinOf(payload.coins, aiPlayerIndex, 'lucky');
    if (!rollerIsAI && success) return coinOf(payload.coins, aiPlayerIndex, 'curse');
    return null;
  }

  /**
   * 难度 2 的硬币策略（硬币是**覆盖**原结果，所以只在有意义的时候用）：
   * - 自己复活 / 惩罚判定失败 → 必用幸运币（这一步失败就是出局）
   * - 自己技能判定失败 → 用幸运币（否则技能会被白送给对方）
   * - 自己普通攻击判定失败 → 自伤会致死时用；否则保留，留给复活判定
   * - 对手复活判定成功 → 用诅咒币压掉（可能直接结束战斗）
   * - 对手技能判定成功 → 用诅咒币压掉（技能会转到我们身上，等于白抢）
   * - 对手普通攻击成功 → 只有它只剩 1 点时才压（逼它自伤）
   * - 随机选择（偷取骰子）→ 不干预
   */
  function chooseCoinHard(payload, aiPlayerIndex) {
    if (!payload || !Array.isArray(payload.coins)) return null;
    if (!payload.roller) return null;

    const coins = payload.coins.filter((coin) => coin.playerIdx === aiPlayerIndex);
    if (!coins.length) return null;

    const rollerIsAI = payload.roller.owner === aiPlayerIndex;
    const success = payload.value === 1;
    const label = payload.label || '';

    if (payload.kind !== 'check') return null; // 偷取随机选择等骰子不干预

    if (rollerIsAI) {
      if (success) return null; // 已经成功，没必要重掷
      const lucky = coinOf(coins, aiPlayerIndex, 'lucky');
      if (!lucky) return null;
      if (isReviveLabel(label)) return lucky; // 复活 / 惩罚失败 = 直接出局
      if (!isAttackLabel(label)) return lucky; // 技能失败 = 白送给对方，救回来
      if (payload.roller.hp <= 1) return lucky; // 自伤会致死
      if (HARD_TUNE.luckyOnAttackFailure) return lucky; // 攻击失败也救：命中率 50% → 75%
      return null; // 攻击失败只是自伤 1 点，幸运币留着更值
    }

    if (!success) return null; // 对手失败时不该被它自己反用得逞
    const curse = coinOf(coins, aiPlayerIndex, 'curse');
    if (!curse) return null;
    if (isReviveLabel(label)) return HARD_TUNE.curseOnEnemyRevive ? curse : null; // 对手复活成功 → 压掉它
    if (!isAttackLabel(label)) return HARD_TUNE.curseOnEnemySkill ? curse : null; // 对手技能成功 → 压掉，技能归我们
    if (payload.roller.hp <= 1) return curse; // 对手只剩 1 点，逼它自伤
    if (HARD_TUNE.curseOnEnemyAttack) return curse; // 直接压掉对手这一下攻击
    return null;
  }

  function chooseCoin(payload, aiPlayerIndex, options) {
    if (levelOf(options) === DIFFICULTY.HARD) return chooseCoinHard(payload, aiPlayerIndex);
    return chooseCoinEasy(payload, aiPlayerIndex);
  }

  return {
    DIFFICULTY,
    LEVEL_LABELS,
    levelOf,
    levelLabel,
    chooseActor,
    chooseAction,
    chooseTarget,
    chooseCoin,
    // 便于测试与调试
    effectiveHp,
    estimateIncoming,
    groupValue,
    bestAttackGroup,
    HARD_SCORE,
    HARD_TUNE
  };
});
