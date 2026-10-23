/*
 * 杀币战争 · 简单启发式 AI
 * ------------------------------------------------------------
 * 纯函数模块，不依赖 DOM。AI 的目标是“看起来合理”，
 * 而不是最优解；游戏本身有大量随机判定。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SBWarAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function chooseActor(game, playerIdx) {
    const actors = game.getActors(playerIdx);
    if (!actors.length) return null;
    const body = actors.find((entity) => !entity.isStandin) || null;
    const standin = actors.find((entity) => entity.isStandin) || null;

    // 本体只剩 1 点生命时，优先让替身行动，避免本体被反噬/反甲击杀
    if (body && body.hp <= 1 && standin) return standin;
    return body || standin;
  }

  function hasEnemyDefense(opponent) {
    return [opponent.body, opponent.standin]
      .filter(Boolean)
      .some((entity) => entity.alive && (entity.shield > 0 || entity.thorns > 0 || entity.tenacity));
  }

  /**
   * 选择本回合的行动。
   * @returns {{actorId: string, skillId: number}|null}
   */
  function chooseAction(game, playerIdx, rng = Math.random) {
    if (!game || game.over || game.busy || game.current !== playerIdx) return null;

    const player = game.players[playerIdx];
    const opponent = game.players[1 - playerIdx];
    if (!player || !opponent) return null;

    const actor = chooseActor(game, playerIdx);
    if (!actor) return null;

    const skills = game.getSkillsFor(actor).filter((skill) => skill.available);
    if (!skills.length) return null;

    const byId = (id) => skills.find((skill) => skill.id === id) || null;
    const action = (id) => (byId(id) ? { actorId: actor.id, skillId: id } : null);
    const normal = byId(0);
    const enemyBody = opponent.body;
    const enemyDefense = hasEnemyDefense(opponent);

    // 濒死时优先保命
    if (actor.hp <= 1 && actor.shield <= 0 && byId(2)) return action(2);
    if (actor.hp <= 1 && !actor.tenacity && byId(4)) return action(4);

    // 对方本体只剩 1 点生命：普攻有 50% 直接结束对局
    if (enemyBody && enemyBody.alive && enemyBody.hp <= 1 && normal) return action(0);

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

  /** 选择普通攻击目标 */
  function chooseTarget(candidates) {
    if (!candidates || !candidates.length) return null;
    const body = candidates.find((candidate) => !candidate.isStandin) || null;
    const standin = candidates.find((candidate) => candidate.isStandin) || null;

    if (body && body.hp <= 1) return body.id;
    if (standin && standin.hp <= 1) return standin.id;
    return (body || candidates[0]).id;
  }

  /**
   * 硬币策略：只在对 AI 不利的判定结果上使用。
   * - 自己（或自己的替身）判定失败：使用幸运币
   * - 对方判定成功：使用诅咒币
   * 随机选择（偷取目标）不干预。
   */
  function chooseCoin(payload, aiPlayerIndex) {
    if (!payload || payload.kind !== 'check' || !Array.isArray(payload.coins)) return null;
    if (!payload.roller) return null;

    const rollerIsAI = payload.roller.owner === aiPlayerIndex;
    const success = payload.value === 1;

    if (rollerIsAI && !success) {
      return payload.coins.find((coin) => coin.playerIdx === aiPlayerIndex && coin.coin === 'lucky') || null;
    }
    if (!rollerIsAI && success) {
      return payload.coins.find((coin) => coin.playerIdx === aiPlayerIndex && coin.coin === 'curse') || null;
    }
    return null;
  }

  return {
    chooseActor,
    chooseAction,
    chooseTarget,
    chooseCoin
  };
});
