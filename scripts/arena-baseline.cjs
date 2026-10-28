'use strict';

/**
 * 竞技场对照开关：SBWAR_BASELINE=1 时把「第 2 轮平衡」的改动关掉，
 * 用来在**同一批种子**下和旧版本对比。
 *
 * 关掉的三处改动：
 *   1. onlyAvailableSkills —— 只在可用技能里挑最高分（修掉「替身只会普攻」）
 *   2. safeGiftScore       —— 「失败也送不到对方」时那批技能的安全分
 *   3. sharpenBlockedTarget —— 磨刀破盾的条件加成
 */

const AI = require('../js/ai.js');

module.exports = function applyBaseline() {
  if (process.env.SBWAR_BASELINE === '1') {
    AI.HARD_TUNE.onlyAvailableSkills = 0;
    AI.HARD_TUNE.safeGiftScore = 0;
    AI.HARD_TUNE.safeGiftStandinScore = 0;
    AI.HARD_TUNE.sharpenBlockedTarget = 44;
  }
};
