/* ============================================================
   杀币战争 · 界面与交互
   ============================================================ */
(function () {
  'use strict';

  const { Game, SKILLS, SKILL_BY_ID, effectChips, MAX_PLAYERS, MIN_PLAYERS } = window.SBWar;
  const AI = window.SBWarAI;
  const DIFFICULTY = (AI && AI.DIFFICULTY) || { EASY: 1, HARD: 2 };
  const DEFAULT_DIFFICULTY = DIFFICULTY.EASY;

  const $ = (id) => document.getElementById(id);
  const el = {
    board: $('board'),
    sideLeft: $('sideLeft'),
    sideRight: $('sideRight'),
    actionArea: $('actionArea'),
    log: $('log'),
    turnStatus: $('turnStatus'),
    turnStatusText: $('turnStatusText'),
    turnBadge: $('turnBadge'),
    rollStage: $('rollStage'),
    rollEyebrow: $('rollEyebrow'),
    rollCoin: $('rollCoin'),
    rollCoinFace: $('rollCoinFace'),
    rollLabel: $('rollLabel'),
    rollRoller: $('rollRoller'),
    rollOutcome: $('rollOutcome'),
    rollChoices: $('rollChoices'),
    rollCoinHint: $('rollCoinHint'),
    effectToast: $('effectToast'),
    setupOverlay: $('setupOverlay'),
    setupFields: $('setupFields'),
    modeTabs: $('modeTabs'),
    modeHint: $('modeHint'),
    difficultyBlock: $('difficultyBlock'),
    difficultyTabs: $('difficultyTabs'),
    difficultyHint: $('difficultyHint'),
    startBtn: $('startBtn'),
    setupRulesBtn: $('setupRulesBtn'),
    rulesBtn: $('rulesBtn'),
    restartBtn: $('restartBtn'),
    rulesOverlay: $('rulesOverlay'),
    rulesClose: $('rulesClose'),
    ruleSkills: $('ruleSkills'),
    coinOverlay: $('coinOverlay'),
    coinModal: $('coinModal'),
    coinEyebrow: $('coinEyebrow'),
    coinTitle: $('coinTitle'),
    coinDesc: $('coinDesc'),
    coinResult: $('coinResult'),
    coinList: $('coinList'),
    coinConfirmRow: $('coinConfirmRow'),
    coinHint: $('coinHint'),
    targetOverlay: $('targetOverlay'),
    targetTitle: $('targetTitle'),
    targetList: $('targetList'),
    victoryOverlay: $('victoryOverlay'),
    victoryModal: document.querySelector('.victory-modal'),
    victoryTitle: $('victoryTitle'),
    victorySub: $('victorySub'),
    victoryReport: $('victoryReport'),
    againBtn: $('againBtn'),
    victorySetupBtn: $('victorySetupBtn')
  };

  // 席位输入：固定 4 行，按模式显示
  const seats = Array.from({ length: MAX_PLAYERS }, (_, index) => ({
    index,
    row: document.querySelector(`.setup-row[data-row="${index}"]`),
    name: $(`name${index}`),
    ai: $(`ai${index}`)
  }));
  // 硬币确认按钮：coinConfirm0..3（多人时全部参与确认）
  const coinConfirms = Array.from({ length: MAX_PLAYERS }, (_, index) => $(`coinConfirm${index}`));

  const DEFAULT_NAMES = ['玩家一', '玩家二', '玩家三', '玩家四'];

  let game = null;
  let selectedActor = null;
  let lastTurn = -1;
  let lastRenderedLogId = 0;
  let victoryShown = false;
  let startSequence = 0;
  let aiPlayers = new Set();
  let aiTimer = null;
  let aiScheduled = false;
  let aiActing = false;
  let effectToastTimer = null;
  let lastEffectSignature = new Map();
  let changedEffects = new Map();
  let panelNodes = [];
  let seatCount = MIN_PLAYERS;
  let aiLevel = DEFAULT_DIFFICULTY;
  /** 难度 2 会给出这一手的判断理由，展示给玩家看 */
  let aiReason = '';

  let activeRoll = null;
  const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pendingCoin = null;
  let pendingTarget = null;

  let savedNames = DEFAULT_NAMES.slice(0, MIN_PLAYERS);

  /** 席位序号对应的中文序号标签（设置界面用） */
  const SEAT_LABELS = ['一', '二', '三', '四'];
  const seatLabel = (index) => `玩家${SEAT_LABELS[index] || index + 1}`;
  /** 面板上的英文席位标签 */
  const PLAYER_LABELS = ['ONE', 'TWO', 'THREE', 'FOUR'];
  const playerTag = (index) => `PLAYER ${PLAYER_LABELS[index] || index + 1}`;

  const isAI = (index) => aiPlayers.has(index);
  const hasAI = () => aiPlayers.size > 0;

  // ---------------------------------------------------------- 工具

  const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPE[c]);

  function showOverlay(node) {
    if (node) node.classList.remove('hidden');
  }

  function hideOverlay(node) {
    if (node) node.classList.add('hidden');
  }

  /**
   * 只在内容真的变化时才写 innerHTML。
   * 否则每次 render 都会重建节点，节点上的 CSS 动画（呼吸、脉冲、弹出）
   * 会不断从 0 重新开始，看起来就像“动画跟着渲染帧率走而不是跟着真实时间走”。
   */
  function setHTML(node, html) {
    if (!node) return;
    if (node.__sbwarHtml === html) return;
    node.__sbwarHtml = html;
    node.innerHTML = html;
  }

  function playerName(index) {
    return game && game.players[index] ? game.players[index].name : `玩家${index + 1}`;
  }

  function defaultActorId(index) {
    if (!game) return null;
    const p = game.players[index];
    if (p && p.body && p.body.alive) return p.body.id;
    if (p && p.standin && p.standin.alive) return p.standin.id;
    return null;
  }

  function ensureSelectedActor() {
    if (!game) return null;
    const actors = game.getActors(game.current);
    if (!actors.length) {
      selectedActor = null;
      return null;
    }
    let found = actors.find((a) => a.id === selectedActor);
    if (!found) {
      selectedActor = actors[0].id;
      found = actors[0];
    }
    return found;
  }

  function pipsHTML(entity) {
    const split = entity.split;
    const total = Math.max(1, split ? split.total : entity.maxHp);
    const filled = split ? split.remaining : Math.max(0, Math.min(entity.hp, total));
    const currentIndex = split ? split.total - split.remaining : -1;
    let html = '';
    for (let i = 0; i < total; i += 1) {
      const on = i >= total - filled ? 'on' : '';
      const current = i === currentIndex ? 'current' : '';
      html += `<span class="pip ${on} ${current}"></span>`;
    }
    return html;
  }

  /** 技能槽：紧凑小方块，只放图标，名字放进 title */
  function slotsHTML(entity) {
    let html = '';
    for (let i = 0; i < entity.slotCap; i += 1) {
      const skillId = entity.slots[i];
      if (skillId === undefined) {
        html += '<span class="slot empty" aria-hidden="true"></span>';
        continue;
      }
      const skill = SKILL_BY_ID.get(skillId);
      if (!skill) continue;
      html += `<span class="slot filled" title="${esc(skill.name)}：${esc(skill.desc)}">
        <span class="slot-ico">${skill.icon}</span>
      </span>`;
    }
    return html;
  }

  /** 已生效效果：紧凑小药丸，图标 + 名称 + 数值 */
  function effectsHTML(entity) {
    const chips = effectChips(entity);
    if (!chips.length) return '<span class="effects-empty">无</span>';
    return chips
      .map((chip) => {
        const pop = changedEffects.get(entity.id) && changedEffects.get(entity.id).has(chip.key) ? 'effect-pop' : '';
        return `<span class="effect-token tone-${chip.tone} ${pop}" data-effect="${chip.key}" title="${esc(chip.title)}">
          <span class="effect-icon">${chip.icon}</span>
          <span class="effect-name">${esc(chip.name)}</span>
          ${chip.value ? `<span class="effect-value">${esc(chip.value)}</span>` : ''}
        </span>`;
      })
      .join('');
  }

  /** 紧凑信息行：小标题 + 内容 */
  function tokenRow(label, content, extra = '') {
    return `<div class="token-row ${extra}">
      <span class="token-label">${label}</span>
      <span class="token-content">${content}</span>
    </div>`;
  }

  function entityHTML(entity, options = {}) {
    const isActive = options.active ? 'is-actor' : '';
    const isDead = entity.alive ? '' : 'is-dead';
    const hp = Math.max(0, entity.hp);
    const phase = entity.split ? `阶段 ${entity.split.total - entity.split.remaining + 1}/${entity.split.total}` : '';
    return `
      <div class="entity ${isActive} ${isDead}">
        <div class="hp-line">
          <span class="hp-value">${hp}</span>
          <span class="hp-max">/ ${entity.maxHp}</span>
          ${phase ? `<span class="hp-caption phase">${phase}</span>` : ''}
        </div>
        <div class="hp-pips">${pipsHTML(entity)}</div>
        ${tokenRow('效果', effectsHTML(entity))}
        ${tokenRow('技能槽', slotsHTML(entity))}
      </div>
    `;
  }

  function standinHTML(standin, isCurrent) {
    if (!standin) {
      return `
        <div class="standin-card is-empty">
          <span class="standin-title">替身</span>
          <span class="standin-none">未召唤 · 【召唤】可获得 1 HP、2 技能槽的独立单位</span>
        </div>
      `;
    }

    const active = isCurrent && selectedActor === standin.id;
    const phase = standin.split ? `阶段 ${standin.split.total - standin.split.remaining + 1}/${standin.split.total}` : '';
    return `
      <div class="standin-card has-standin ${active ? 'is-actor' : ''}">
        <div class="hp-line">
          <span class="hp-kind">替身</span>
          <span class="hp-value">${Math.max(0, standin.hp)}</span>
          <span class="hp-max">/ ${standin.maxHp}</span>
          ${phase ? `<span class="hp-caption phase">${phase}</span>` : ''}
        </div>
        ${tokenRow('效果', effectsHTML(standin))}
        ${tokenRow('技能槽', slotsHTML(standin))}
      </div>
    `;
  }

  function panelHTML(player, index) {
    const isCurrent = game.current === index && !game.over;
    const body = player.body;
    const bodyActive = isCurrent && selectedActor === body.id;
    const tags = [];
    if (isAI(index)) tags.push('<span class="ai-tag">电脑</span>');
    if (!body.alive) tags.push('<span class="dead-tag">已退场</span>');
    return `
      <div class="panel-head">
        <div class="player-identity">
          <div class="player-label">${playerTag(index)}</div>
          <h2 class="player-name">${esc(player.name)}${tags.join('')}</h2>
        </div>
        ${isCurrent ? '<span class="turn-chip">行动中</span>' : ''}
      </div>
      ${entityHTML(body, { active: bodyActive })}
      ${standinHTML(player.standin, isCurrent)}
    `;
  }

  function skillButtonHTML(skill) {
    return `
      <button class="skill-btn ${skill.inSlot ? 'is-recorded' : ''}"
              data-skill="${skill.id}"
              style="--accent:${skill.accent}"
              title="${esc(skill.desc)}"
              ${skill.available ? '' : 'disabled'}>
        <span class="skill-icon">${skill.icon}</span>
        <span class="skill-copy">
          <span class="skill-name">${esc(skill.name)}</span>
          <span class="skill-status">${esc(skill.reason)}</span>
        </span>
      </button>
    `;
  }

  function actionHTML() {
    if (!game) {
      return `
        <div class="empty-state">
          <div class="empty-mark">⚔</div>
          <h2>等待开战</h2>
          <p>填写两位玩家的名字，然后掷币决定先手。</p>
        </div>
      `;
    }

    if (game.over) {
      return `
        <div class="result-card">
          <p class="result-kicker">BATTLE OVER</p>
          <h2 class="result-title">${esc(playerName(game.winner))} 胜利</h2>
          <p class="result-sub">第 ${game.turn} 回合结束 · 生命耗尽且复活失败</p>
        </div>
      `;
    }

    if (isAI(game.current)) {
      const hard = aiLevel === DIFFICULTY.HARD;
      return `
        <div class="ai-turn">
          <div class="ai-orb">AI</div>
          <p class="eyebrow">AI TURN</p>
          <h2 class="ai-title">${esc(playerName(game.current))} 正在${game.busy ? '结算' : '思考'}…</h2>
          <p class="ai-desc">${hard ? '难度 2 · 进阶电脑：普攻与召唤轮着用，始终把替身顶在前面当挡箭牌，只集火对方本体。' : '难度 1 · 简单电脑：按固定优先级试探。'}${hard && aiReason ? `判断：${esc(aiReason)}。` : '电脑会参考场上所有玩家的生命、效果和技能槽。'}</p>
          <div class="ai-thinking" aria-hidden="true"><span></span><span></span><span></span></div>
        </div>
      `;
    }

    const player = game.players[game.current];
    const actor = ensureSelectedActor();
    if (!actor) {
      return `
        <div class="empty-state">
          <div class="empty-mark">…</div>
          <h2>等待结算</h2>
        </div>
      `;
    }

    const skills = game.getSkillsFor(actor);
    const actors = game.getActors(game.current);
    const tabs = player.standin
      ? `<div class="actor-tabs">
          ${actors
            .map(
              (item) => `
              <button class="actor-tab ${item.id === actor.id ? 'active' : ''}" data-actor="${item.id}" ${game.busy ? 'disabled' : ''}>
                <span>${item.isStandin ? '替身' : '本体'}</span>
                <em>${Math.max(0, item.hp)} / ${item.maxHp}</em>
              </button>`
            )
            .join('')}
        </div>`
      : '';

    return `
      <div class="action-head">
        <div class="action-heading">
          <p class="eyebrow">ACTION PHASE</p>
          <h2 class="action-title"><span class="accent">${esc(player.name)}</span> · ${actor.isStandin ? '替身' : '本体'}行动</h2>
        </div>
        <span class="action-hint">${game.busy ? '正在结算…' : '判定成功才生效'}</span>
      </div>
      ${tabs}
      <div class="skill-grid">
        ${skills.map(skillButtonHTML).join('')}
      </div>
      <div class="action-foot">
        <span class="slot-meter">技能槽 <strong>${actor.slots.length} / ${actor.slotCap}</strong> · 失败会被反用</span>
        <button class="pass-btn" id="passBtn" type="button" ${game.busy ? 'disabled' : ''}>跳过行动</button>
      </div>
      ${game.busy ? '<div class="busy-strip"><span class="busy-dot"></span>正在掷币、判定并结算效果…</div>' : ''}
    `;
  }

  function renderStatus() {
    el.turnStatus.classList.remove('live', 'over');
    if (!game) {
      el.turnStatusText.textContent = '等待开战';
      el.turnBadge.textContent = '—';
      return;
    }
    if (game.over) {
      el.turnStatus.classList.add('over');
      el.turnStatusText.textContent = `战斗结束 · ${playerName(game.winner)} 获胜`;
      el.turnBadge.textContent = `T${game.turn}`;
      return;
    }
    el.turnStatus.classList.add('live');
    el.turnStatusText.textContent = `第 ${game.turn} 回合 · ${playerName(game.current)} 行动中`;
    el.turnBadge.textContent = `T${game.turn}`;
  }

  /**
 * 玩家面板按人数分列：2 人时左右各一，3–4 人时在左右两列堆叠。
 * 面板节点只在人数变化时重建，平时只更新内容。
 */
  function layoutSides(count) {
    const leftCount = Math.ceil(count / 2);
    return { leftCount, rightStart: leftCount };
  }

  function syncPanelNodes(count) {
    const { leftCount } = layoutSides(count);
    const wanted = Array.from({ length: count }, (_, index) => ({
      index,
      side: index < leftCount ? 'left' : 'right'
    }));

    const sameLayout =
      panelNodes.length === count &&
      panelNodes.every((node, index) => node.side === wanted[index].side && node.node.parentElement);

    if (sameLayout) return;

    panelNodes.forEach((entry) => entry.node.remove());
    el.sideLeft.innerHTML = '';
    el.sideRight.innerHTML = '';
    panelNodes = wanted.map((entry) => {
      const node = document.createElement('section');
      node.className = `player-panel p${entry.index}`;
      node.id = `panel${entry.index}`;
      node.setAttribute('aria-label', seatLabel(entry.index));
      (entry.side === 'left' ? el.sideLeft : el.sideRight).appendChild(node);
      return { index: entry.index, side: entry.side, node };
    });
  }

  function renderPanels() {
    if (!game) {
      const count = seatCount;
      syncPanelNodes(count);
      panelNodes.forEach((entry) => {
        const name = savedNames[entry.index] || seatLabel(entry.index);
        setHTML(entry.node, idlePanelHTML(name, playerTag(entry.index)));
        entry.node.classList.remove('is-active');
      });
      return;
    }

    syncPanelNodes(game.players.length);
    panelNodes.forEach((entry) => {
      const player = game.players[entry.index];
      if (!player) return;
      setHTML(entry.node, panelHTML(player, entry.index));
      entry.node.classList.toggle('is-active', game.current === entry.index && !game.over);
    });
  }

  function idlePanelHTML(name, tag) {
    return `
      <div class="panel-head">
        <div class="player-identity">
          <div class="player-label">${tag}</div>
          <h2 class="player-name">${esc(name)}</h2>
        </div>
      </div>
      <div class="empty-state" style="min-height:260px">
        <div class="empty-mark">币</div>
        <p>等待战斗开始</p>
      </div>
    `;
  }

  function renderLog() {
    if (!game) {
      setHTML(el.log, '');
      lastRenderedLogId = 0;
      return;
    }

    const entries = game.logs.slice(-220);
    const previousMax = lastRenderedLogId;
    lastRenderedLogId = entries.length ? entries[entries.length - 1].id : previousMax;

    setHTML(
      el.log,
      entries
        .map((entry) => {
          const fresh = entry.id > previousMax ? 'log-new' : '';
          return `<div class="log-entry ${entry.type} ${fresh}">
          <span class="log-turn">${entry.turn}</span>
          <span class="log-text">${esc(entry.text)}</span>
        </div>`;
        })
        .join('')
    );

    // 每次战斗记录更新都翻到最下方
    el.log.scrollTop = el.log.scrollHeight;
    window.requestAnimationFrame(() => {
      el.log.scrollTop = el.log.scrollHeight;
    });
  }

  function prepareEffectChanges() {
    const next = new Map();
    const changed = new Map();

    if (game) {
      for (const player of game.players) {
        for (const entity of [player.body, player.standin]) {
          if (!entity) continue;
          const chips = effectChips(entity);
          const previous = lastEffectSignature.get(entity.id) || new Map();
          const changedKeys = new Set();
          for (const chip of chips) {
            const old = previous.get(chip.key);
            if (!old || old.value !== chip.value) changedKeys.add(chip.key);
          }
          next.set(entity.id, new Map(chips.map((chip) => [chip.key, chip])));
          changed.set(entity.id, changedKeys);
        }
      }
    }

    lastEffectSignature = next;
    changedEffects = changed;
  }

  function render() {
    if (game) {
      if (game.turn !== lastTurn) {
        lastTurn = game.turn;
        selectedActor = defaultActorId(game.current);
      }
      if (!game.over) ensureSelectedActor();
    }

    prepareEffectChanges();
    renderStatus();
    renderPanels();
    setHTML(el.actionArea, actionHTML());
    renderLog();

    if (game && game.over && !victoryShown) {
      victoryShown = true;
      window.setTimeout(() => {
        if (game && game.over) showVictory();
      }, 520);
    }

    scheduleAITurn();
  }

  // ---------------------------------------------------------- 行动

  async function performSkill(skillId) {
    if (!game || game.busy || game.over) return;
    if (isAI(game.current)) return;
    const actorId = selectedActor || defaultActorId(game.current);
    if (!actorId) return;
    const ok = await game.act(game.current, actorId, skillId);
    if (!ok) render();
  }

  async function performPass() {
    if (!game || game.busy || game.over) return;
    if (isAI(game.current)) return;
    await game.pass(game.current);
  }

  // ---------------------------------------------------------- AI

  function cancelAITurn() {
    if (aiTimer) window.clearTimeout(aiTimer);
    aiTimer = null;
    aiScheduled = false;
    aiActing = false;
  }

  function scheduleAITurn() {
    if (!AI || !game || game.over || game.busy || !hasAI()) return;
    const current = game.current;
    if (!isAI(current)) return;
    if (aiScheduled || aiActing) return;
    if (!el.rulesOverlay.classList.contains('hidden')) return;

    const instance = game;
    aiScheduled = true;
    aiTimer = window.setTimeout(() => {
      aiTimer = null;
      aiScheduled = false;
      if (game !== instance || game.over || game.busy || game.current !== current) return;
      if (!el.rulesOverlay.classList.contains('hidden')) return;
      runAITurn(instance, current);
    }, REDUCED_MOTION ? 350 : 900);
  }

  async function runAITurn(instance, playerIndex) {
    if (aiActing || !AI || game !== instance || game.over || game.busy || game.current !== playerIndex) return;
    aiActing = true;
    try {
      aiReason = '';
      const action = AI.chooseAction(game, playerIndex, Math.random, { level: aiLevel });
      aiReason = (action && action.why) || '';
      if (!action) {
        await game.pass(playerIndex);
      } else {
        const ok = await game.act(playerIndex, action.actorId, action.skillId);
        if (!ok && !game.over) await game.pass(playerIndex);
      }
    } catch (error) {
      console.error('AI 行动失败', error);
    } finally {
      aiActing = false;
      if (game === instance) render();
    }
  }

  function showEffectToast(payload) {
    if (!payload || !payload.skill || !payload.entity) return;
    const skill = payload.skill;
    el.effectToast.style.setProperty('--toast-accent', skill.accent);
    el.effectToast.innerHTML = `
      <span class="effect-toast-icon">${skill.icon}</span>
      <span class="effect-toast-copy">
        <strong>${esc(skill.name)}</strong>
        <small>${esc(payload.entity.name)} · 技能发动</small>
      </span>
    `;
    el.effectToast.classList.remove('show');
    void el.effectToast.offsetWidth;
    el.effectToast.classList.add('show');
    if (effectToastTimer) window.clearTimeout(effectToastTimer);
    effectToastTimer = window.setTimeout(() => el.effectToast.classList.remove('show'), 4000);
  }

  function resetEffectVisuals() {
    if (effectToastTimer) window.clearTimeout(effectToastTimer);
    effectToastTimer = null;
    el.effectToast.classList.remove('show');
    el.effectToast.innerHTML = '';
    lastEffectSignature = new Map();
    changedEffects = new Map();
  }

  // ---------------------------------------------------------- 硬币 / 目标弹层

  function chooseCoinIntervention(payload) {
    return new Promise((resolve) => {
      if (pendingCoin) {
        const old = pendingCoin;
        pendingCoin = null;
        old({ done: true });
      }

      if (!payload.coins || !payload.coins.length) {
        hideOverlay(el.coinOverlay);
        resolve({ done: true });
        return;
      }

      const humanCoins = payload.coins.filter((coin) => !isAI(coin.playerIdx));

      // AI 的硬币由启发式策略自动决定；决定使用时直接重掷，不打开给人类的面板
      if (hasAI() && AI) {
        // 多个电脑时按席位顺序逐个决定，用掉一枚后会重新进入本钩子，轮到下一位
        const aiCoin = Array.from(aiPlayers)
          .map((index) => AI.chooseCoin(payload, index, { level: aiLevel }))
          .find(Boolean);
        if (aiCoin) {
          let settledAI = false;
          const finishAI = () => {
            if (settledAI) return;
            settledAI = true;
            if (pendingCoin === finishAI) pendingCoin = null;
            if (!el.coinOverlay.classList.contains('hidden')) {
              el.coinModal.classList.add('is-rolling');
              el.coinResult.textContent = '重掷中…';
              el.coinResult.className = 'coin-result';
              el.coinHint.textContent = '电脑正在使用硬币重掷…';
              coinConfirms.forEach((button) => {
                button.disabled = true;
              });
              el.coinList.querySelectorAll('button').forEach((button) => {
                button.disabled = true;
              });
            }
            resolve({ coinId: aiCoin.id });
          };
          pendingCoin = finishAI;
          window.setTimeout(finishAI, REDUCED_MOTION ? 200 : 800);
          return;
        }

        // AI 决定保留硬币：若不涉及人类的硬币，直接结束；否则只让人类持币者确认
        if (!humanCoins.length) {
          hideOverlay(el.coinOverlay);
          resolve({ done: true });
          return;
        }
      }

      let settled = false;
      const finish = (decision, keepOpen = false) => {
        if (settled) return;
        settled = true;
        if (pendingCoin === finish) pendingCoin = null;
        if (!keepOpen) {
          el.coinModal.classList.remove('is-rolling');
          hideOverlay(el.coinOverlay);
        }
        resolve(decision || { done: true });
      };
      pendingCoin = finish;

      const revive = /复活|惩罚/.test(payload.label);
      const isCheck = payload.isCheck === true || payload.kind === 'check';
      const coinPlayers = new Set(humanCoins.map((coin) => coin.playerIdx));

      el.coinModal.classList.remove('is-rolling');
      el.coinModal.classList.toggle('revive', revive);
      el.coinEyebrow.textContent = revive ? 'REVIVAL INTERVENTION' : 'COIN INTERVENTION';
      el.coinTitle.textContent = revive ? '是否干预复活判定？' : '是否重掷当前结果？';
      el.coinDesc.textContent = `【${payload.roller.name} · ${payload.label}】当前结果：${payload.display}。所有可用硬币如下；使用后以最后一次掷出的结果为准。`;
      el.coinResult.textContent = payload.display;
      el.coinResult.className = 'coin-result';
      if (isCheck) {
        el.coinResult.classList.add(payload.value === 1 ? 'good' : 'bad');
      }

      el.coinList.innerHTML = payload.coins
        .map((coin) => {
          const lucky = coin.coin === 'lucky';
          const aiOwned = isAI(coin.playerIdx);
          return `<button class="coin-card ${lucky ? 'lucky' : 'curse'} ${aiOwned ? 'ai-reserved' : ''}" type="button" data-coin-id="${esc(coin.id)}" ${aiOwned ? 'disabled' : ''}>
            <span class="coin-card-icon">${lucky ? '☆' : '⇌'}</span>
            <span class="coin-card-copy">
              <strong>${lucky ? '幸运币' : '诅咒币'}</strong>
              <small>${esc(coin.holder.name)} · ${aiOwned ? '电脑保留' : '重掷当前结果'}</small>
            </span>
            <span class="coin-card-use">${aiOwned ? '电脑' : '使用'}</span>
          </button>`;
        })
        .join('');

      const confirmed = new Map();
      coinConfirms.forEach((button, index) => {
        const required = coinPlayers.has(index);
        confirmed.set(index, false);
        button.classList.toggle('hidden', !required);
        button.disabled = !required;
        button.classList.remove('confirmed');
      });
      const updateConfirm = () => {
        coinConfirms.forEach((button, index) => {
          if (!coinPlayers.has(index)) return;
          button.textContent = `${playerName(index)} · ${confirmed.get(index) ? '已确认' : '不再使用'}`;
          button.classList.toggle('confirmed', confirmed.get(index));
        });
      };
      const toggleConfirm = (index) => {
        if (!coinPlayers.has(index) || el.coinModal.classList.contains('is-rolling')) return;
        confirmed.set(index, !confirmed.get(index));
        updateConfirm();
        if ([...coinPlayers].every((player) => confirmed.get(player))) finish({ done: true });
      };

      coinConfirms.forEach((button, index) => {
        button.onclick = () => toggleConfirm(index);
      });
      updateConfirm();

      const setRolling = () => {
        el.coinModal.classList.add('is-rolling');
        el.coinResult.textContent = '重掷中…';
        el.coinResult.className = 'coin-result';
        el.coinHint.textContent = '正在重掷，请稍候…';
        coinConfirms.forEach((button) => {
          button.disabled = true;
        });
        el.coinList.querySelectorAll('button').forEach((button) => {
          button.disabled = true;
        });
      };

      el.coinList.onclick = (event) => {
        const card = event.target.closest('[data-coin-id]');
        if (!card || el.coinModal.classList.contains('is-rolling')) return;

        // 最后一枚人类可用硬币用掉后，面板关闭；AI 硬币会自动处理
        const lastHumanCoin = humanCoins.length <= 1;
        if (lastHumanCoin) {
          finish({ coinId: card.getAttribute('data-coin-id') });
        } else {
          setRolling();
          finish({ coinId: card.getAttribute('data-coin-id') }, true);
        }
      };

      const aiNote = hasAI() ? ' 电脑的硬币由 AI 自动处理。' : '';
      el.coinHint.textContent = (revive
        ? '持有可用硬币的玩家确认后，本次复活判定以最后一次掷出的结果为准。'
        : '持有可用硬币的玩家确认后，本次随机数以最后一次掷出的结果为准。') + aiNote;

      showOverlay(el.coinOverlay);
      const firstCard = el.coinList.querySelector('.coin-card');
      if (firstCard) firstCard.focus({ preventScroll: true });
      else {
        const firstConfirm = coinConfirms.find((button) => !button.classList.contains('hidden'));
        if (firstConfirm) firstConfirm.focus({ preventScroll: true });
      }
    });
  }

  function chooseTarget(payload) {
    if (isAI(payload.playerIdx)) {
      const targetId = AI ? AI.chooseTarget(payload.options, { level: aiLevel }) : payload.options[0] && payload.options[0].id;
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(targetId), REDUCED_MOTION ? 150 : 550);
      });
    }

    return new Promise((resolve) => {
      if (pendingTarget) {
        const old = pendingTarget;
        pendingTarget = null;
        old(payload.options[0] ? payload.options[0].id : null);
      }

      let settled = false;
      const finish = (id) => {
        if (settled) return;
        settled = true;
        if (pendingTarget === finish) pendingTarget = null;
        hideOverlay(el.targetOverlay);
        resolve(id);
      };
      pendingTarget = finish;

      el.targetTitle.textContent = payload.purpose;
      el.targetList.innerHTML = payload.options
        .map((option) => {
          const members = option.entities
            .map((entity) => {
              const effects = entity.effects.length
                ? entity.effects.map((chip) => `<span class="target-stat">${chip.icon} ${esc(chip.label)}</span>`).join('')
                : '<span class="target-stat">无效果</span>';
              return `
                <span class="target-member">
                  <span class="target-member-head">
                    <span class="target-orb ${entity.isStandin ? 'standin' : ''}">${entity.isStandin ? '⊕' : '本'}</span>
                    <span class="target-member-name">${esc(entity.name)}</span>
                    <span class="target-stat">生命 ${Math.max(0, entity.hp)} / ${entity.maxHp}</span>
                  </span>
                  <span class="target-stats">${effects}</span>
                </span>
              `;
            })
            .join('');
          return `
            <button class="target-card group" type="button" data-target="${esc(option.id)}">
              <span class="target-copy">
                <span class="target-name">${esc(option.label)}
                  <span class="target-kind">${option.entities.length} 个目标</span>
                </span>
                <span class="target-members">${members}</span>
              </span>
              <span class="target-arrow">→</span>
            </button>
          `;
        })
        .join('');

      el.targetList.onclick = (event) => {
        const card = event.target.closest('[data-target]');
        if (!card) return;
        finish(card.getAttribute('data-target'));
      };

      showOverlay(el.targetOverlay);
      const first = el.targetList.querySelector('.target-card');
      if (first) first.focus({ preventScroll: true });
    });
  }

  function cancelPendingPrompts() {
    if (pendingCoin) {
      const finish = pendingCoin;
      pendingCoin = null;
      finish({ done: true });
    }
    if (pendingTarget) {
      const finish = pendingTarget;
      pendingTarget = null;
      finish(null);
    }
  }

  // ---------------------------------------------------------- 对局生命周期

  async function startGame(names, options = {}) {
    const token = (startSequence += 1);
    cancelAITurn();
    cancelPendingPrompts();
    cancelRollAnimation();
    resetEffectVisuals();
    aiReason = '';
    hideOverlay(el.setupOverlay);
    hideOverlay(el.victoryOverlay);
    hideOverlay(el.coinOverlay);
    hideOverlay(el.targetOverlay);
    hideOverlay(el.rulesOverlay);

    // 名单：按传入长度决定人数（2–4 人），末尾的空名字会被裁掉
    const list = Array.isArray(names) ? names : [names];
    const raw = [];
    for (let i = 0; i < MAX_PLAYERS; i += 1) {
      raw.push(list[i] == null ? '' : String(list[i]).trim());
    }
    while (raw.length > MIN_PLAYERS && !raw[raw.length - 1]) raw.pop();
    savedNames = raw.map((name, index) => name || seatLabel(index));
    seatCount = savedNames.length;

    // AI 席位：兼容旧的 aiPlayerIndex，也支持 aiPlayerIndexes / 每席位开关
    const nextAI = new Set();
    if (Array.isArray(options.aiPlayerIndexes)) {
      options.aiPlayerIndexes.forEach((index) => {
        if (Number.isInteger(index) && index >= 0 && index < seatCount) nextAI.add(index);
      });
    } else if (Object.prototype.hasOwnProperty.call(options, 'aiPlayerIndex')) {
      const index = options.aiPlayerIndex;
      if (Number.isInteger(index) && index >= 0 && index < seatCount) nextAI.add(index);
    } else {
      seats.forEach((seat) => {
        if (seat.index < seatCount && seat.ai && seat.ai.checked) nextAI.add(seat.index);
      });
    }
    aiPlayers = nextAI;

    // 难度：优先用调用方传入的，其次读设置界面
    if (options.difficulty !== undefined && options.difficulty !== null) {
      aiLevel = Number(options.difficulty) === DIFFICULTY.HARD ? DIFFICULTY.HARD : DIFFICULTY.EASY;
      applyDifficulty(aiLevel);
    }

    try {
      window.localStorage.setItem('sbwar.names', JSON.stringify(savedNames));
      window.localStorage.setItem('sbwar.seats', JSON.stringify(Array.from(aiPlayers)));
    } catch (error) {
      /* 忽略隐私模式下的存储错误 */
    }

    let firstPlayer = options.firstPlayer;
    if (!Number.isInteger(firstPlayer) || firstPlayer < 0 || firstPlayer >= seatCount) {
      firstPlayer = Math.floor(Math.random() * seatCount);
      game = null;
      selectedActor = null;
      lastTurn = -1;
      lastRenderedLogId = 0;
      victoryShown = false;
      render();
      el.turnStatusText.textContent = '决定先手中…';
      el.turnStatus.classList.add('live');

      await animateRoll({
        roller: { id: 'first-roll', name: '命运硬币', owner: 0, isStandin: false, effects: [] },
        label: '先后手判定',
        value: firstPlayer + 1,
        sides: 2,
        display: `${savedNames[firstPlayer]} 先手`,
        kind: 'first',
        phase: 'roll',
        coin: null,
        meta: { type: 'first', firstName: savedNames[firstPlayer] }
      });

      if (token !== startSequence) return;
    }

    const instance = new Game({
      io: {
        changed: () => {
          if (game === instance) render();
        },
        animateRoll: (payload) => (game === instance ? animateRoll(payload) : Promise.resolve()),
        onEffect: (payload) => {
          if (game === instance) showEffectToast(payload);
        },
        pause: (ms) =>
          game === instance
            ? new Promise((resolve) => window.setTimeout(resolve, REDUCED_MOTION ? 0 : Math.max(0, ms || 360)))
            : Promise.resolve(),
        chooseCoinIntervention: (payload) =>
          game === instance ? chooseCoinIntervention(payload) : Promise.resolve({ done: true }),
        chooseTarget: (payload) =>
          game === instance ? chooseTarget(payload) : Promise.resolve(payload.options[0] ? payload.options[0].id : null)
      }
    });

    game = instance;
    victoryShown = false;
    lastTurn = -1;
    lastRenderedLogId = 0;
    selectedActor = null;

    instance.start(savedNames, { firstPlayer });
    selectedActor = defaultActorId(instance.current);
    render();
  }

  function resetToSetup() {
    startSequence += 1;
    cancelAITurn();
    cancelPendingPrompts();
    cancelRollAnimation();
    resetEffectVisuals();
    aiReason = '';
    game = null;
    aiPlayers = new Set();
    selectedActor = null;
    lastTurn = -1;
    lastRenderedLogId = 0;
    victoryShown = false;

    hideOverlay(el.victoryOverlay);
    hideOverlay(el.coinOverlay);
    hideOverlay(el.targetOverlay);
    hideOverlay(el.rulesOverlay);
    showOverlay(el.setupOverlay);

    applySeatCount(savedNames.length);
    seats.forEach((seat) => {
      seat.name.value = savedNames[seat.index] || seatLabel(seat.index);
      seat.ai.checked = aiPlayers.has(seat.index);
    });
    render();
    window.setTimeout(() => seats[0].name.focus({ preventScroll: true }), 60);
  }

  function victoryReportHTML() {
    const stats = game.stats || [];
    const ranking = typeof game.finalRanking === 'function' ? game.finalRanking() : [];
    const rankOf = new Map(ranking.map((row) => [row.index, row]));
    const draw = game.winner === null || game.winner === undefined;

    const columns = game.players.map((player, index) => {
      const s = stats[index] || {};
      const body = player.body;
      const row = rankOf.get(index) || null;
      const rankText = !row ? '—' : row.rank == null ? '平局' : `第 ${row.rank} 名`;
      const survived = s.survivedTurns || 0;
      const survivedText = survived > 0 ? `${survived} 回合` : '—';
      const rows = [
        ['造成伤害', s.damageDealt || 0],
        ['受到伤害', s.damageTaken || 0],
        ['技能使用', s.skillsUsed || 0],
        ['判定成功', s.successes || 0],
        ['判定失败', s.failures || 0],
        ['复活次数', s.revives || 0],
        ['使用硬币', s.coins || 0],
        ['偷取效果', s.steals || 0],
        ['召唤替身', s.summons || 0],
        ['最终生命', `${Math.max(0, body.hp)} / ${body.maxHp}`],
        ['最终排名', rankText],
        ['存活回合', survivedText]
      ];
      const result = index === game.winner ? '胜者' : body.alive ? (game.isMultiplayer() ? '存活' : '败者') : '退场';
      return `<div class="report-col p${index}">
        <div class="report-col-head">
          <span>${esc(player.name)}</span>
          <em>${result}</em>
        </div>
        <div class="report-stats">
          ${rows.map(([label, value]) => `<span>${label}<b>${value}</b></span>`).join('')}
        </div>
      </div>`;
    });

    // 最终排名：胜者第一，其余按“在场上待得更久”排序
    const rankList = ranking.length
      ? `<ol class="report-rank-list">
          ${ranking
            .map((row, i) => {
              const note = row.eliminatedTurn == null
                ? `存活 ${row.survivedTurns} 回合 · 坚持到最终`
                : `存活 ${row.survivedTurns} 回合 · 第 ${row.eliminatedTurn} 回合退场`;
              const no = row.rank == null ? '—' : String(row.rank);
              const top = i === 0 && !draw ? ' is-top' : '';
              return `<li class="rank-row${top}">
                <span class="rank-no">${no}</span>
                <span class="rank-name">${esc(row.name)}</span>
                <span class="rank-note">${esc(note)}</span>
              </li>`;
            })
            .join('')}
        </ol>`
      : '';

    const order = (game.eliminationOrder || []).map((item) => item.name);
    const orderNote = order.length ? `退场顺序：${order.join(' → ')}` : '无人退场';

    const recent = game.logs
      .slice(-10)
      .map((entry) => `<div class="report-log-line ${entry.type}">${esc(entry.text)}</div>`)
      .join('');

    return `
      <div class="report-head"><span>战报</span><small>共 ${game.turn} 回合</small></div>
      <div class="report-rank">
        <div class="report-rank-head"><span>最终排名</span><small>${esc(orderNote)}</small></div>
        ${rankList}
      </div>
      <div class="report-grid ${game.isMultiplayer() ? 'is-battle' : ''}">${columns.join('')}</div>
      <div class="report-recent">
        <div class="report-recent-title">最后记录</div>
        ${recent}
      </div>
    `;
  }

  function showVictory() {
    if (!game || !game.over) return;
    const draw = game.winner === null || game.winner === undefined;
    const multiplayer = game.isMultiplayer();
    el.victoryTitle.textContent = draw ? '平局' : `${playerName(game.winner)} 胜利`;
    el.victorySub.textContent = draw
      ? `第 ${game.turn} 回合结束 · 全员阵亡`
      : `第 ${game.turn} 回合结束 · ${multiplayer ? '其余玩家生命耗尽且复活失败' : '对手生命耗尽且复活失败'}`;
    el.victoryReport.innerHTML = victoryReportHTML();
    if (el.victoryReport.querySelector('.report-grid.is-battle')) {
      el.victoryModal.classList.add('is-battle');
    } else {
      el.victoryModal.classList.remove('is-battle');
    }
    showOverlay(el.victoryOverlay);
    el.againBtn.focus({ preventScroll: true });
  }

  function rollHasCoin(payload) {
    if (!game || !payload.roller || payload.kind === 'first') return false;
    const roller = game.getEntity(payload.roller.id);
    if (roller && roller.lucky > 0) return true;
    // 诅咒币：除掷数者以外的所有玩家都可以干预
    return game
      .othersOf(payload.roller.owner)
      .flatMap((player) => [player.body, player.standin])
      .some((entity) => entity && entity.alive && entity.curse > 0);
  }

  function cancelRollAnimation() {
    if (!activeRoll) return;
    const finish = activeRoll;
    activeRoll = null;
    finish();
  }

  function animateRoll(payload) {
    if (activeRoll) {
      const previous = activeRoll;
      activeRoll = null;
      previous();
    }

    return new Promise((resolve) => {
      const firstTurn = payload.kind === 'first';
      const hasCoin = rollHasCoin(payload);
      const spinMs = REDUCED_MOTION ? 220 : 1200;
      const holdMs = REDUCED_MOTION ? 500 : hasCoin ? 1600 : 1200;
      const revive = /复活|惩罚/.test(payload.label);
      const choices = payload.meta && Array.isArray(payload.meta.choices) ? payload.meta.choices : [];

      let settled = false;
      let spinTimer = null;
      let holdTimer = null;
      let faceTimer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (faceTimer) window.clearInterval(faceTimer);
        if (spinTimer) window.clearTimeout(spinTimer);
        if (holdTimer) window.clearTimeout(holdTimer);
        if (activeRoll === finish) activeRoll = null;
        hideOverlay(el.rollStage);
        resolve();
      };
      activeRoll = finish;

      el.rollEyebrow.textContent =
        payload.phase === 'reroll'
          ? 'COIN REROLL'
          : firstTurn
            ? 'FIRST TURN'
            : payload.meta && payload.meta.type === 'steal'
              ? 'STEAL PICK'
              : revive
                ? 'REVIVAL CHECK'
                : payload.kind === 'die'
                  ? 'RANDOM PICK'
                  : 'COIN CHECK';
      el.rollLabel.textContent = payload.label;
      el.rollRoller.textContent = payload.roller.name;
      el.rollCoin.className = 'roll-coin spinning';
      el.rollCoinFace.textContent = '?';
      el.rollOutcome.textContent = '正在生成随机数…';
      el.rollOutcome.className = 'roll-outcome';
      el.rollChoices.innerHTML = choices
        .map((choice, index) => `<span class="roll-choice" data-choice="${index}">${esc(choice)}</span>`)
        .join('');
      el.rollCoinHint.textContent = hasCoin ? '场上有硬币：结果出现后可以干预' : '';
      showOverlay(el.rollStage);

      faceTimer = window.setInterval(() => {
        if (settled) return;
        if (payload.kind === 'check') {
          el.rollCoinFace.textContent = Math.random() < 0.5 ? '0' : '1';
        } else {
          el.rollCoinFace.textContent = String(1 + Math.floor(Math.random() * payload.sides));
        }
      }, 65);

      spinTimer = window.setTimeout(() => {
        if (settled) return;
        if (faceTimer) {
          window.clearInterval(faceTimer);
          faceTimer = null;
        }

        const success = payload.value === 1;
        if (firstTurn) {
          el.rollCoin.className = 'roll-coin is-number';
          el.rollCoinFace.textContent = '先';
          el.rollOutcome.textContent = `${payload.meta.firstName} 先手`;
          el.rollOutcome.className = 'roll-outcome number';
        } else if (payload.kind === 'check') {
          el.rollCoin.className = `roll-coin ${success ? 'is-good' : 'is-bad'}`;
          el.rollCoinFace.textContent = success ? '1' : '0';
          el.rollOutcome.textContent = success ? '判定成功' : '判定失败';
          el.rollOutcome.className = `roll-outcome ${success ? 'good' : 'bad'}`;
        } else {
          el.rollCoin.className = 'roll-coin is-number';
          el.rollCoinFace.textContent = String(payload.value);
          if (choices.length) {
            const selected = payload.value - 1;
            el.rollOutcome.textContent = choices[selected] ? `偷取：${choices[selected]}` : payload.display;
            el.rollOutcome.className = 'roll-outcome number';
            el.rollChoices.querySelectorAll('.roll-choice').forEach((node, index) => {
              node.classList.toggle('selected', index === selected);
              node.classList.toggle('dimmed', index !== selected);
            });
          } else {
            el.rollOutcome.textContent = payload.display;
            el.rollOutcome.className = 'roll-outcome number';
          }
        }

        el.rollCoinHint.textContent = hasCoin ? '硬币可以干预这次结果…' : firstTurn ? '先手已确定' : '结果生效中…';
        holdTimer = window.setTimeout(finish, holdMs);
      }, spinMs);
    });
  }

  // ---------------------------------------------------------- 规则 / 初始化

  function buildRuleSkills() {
    el.ruleSkills.innerHTML = SKILLS.map(
      (skill) => `
        <div class="rule-skill">
          <div class="rule-skill-icon" style="color:${skill.accent}">${skill.icon}</div>
          <div class="rule-skill-copy">
            <div class="rule-skill-name">${esc(skill.name)}</div>
            <div class="rule-skill-desc">${esc(skill.desc)}</div>
          </div>
        </div>
      `
    ).join('');
  }

  function openRules() {
    showOverlay(el.rulesOverlay);
    el.rulesClose.focus({ preventScroll: true });
  }

  function closeRules() {
    hideOverlay(el.rulesOverlay);
    scheduleAITurn();
  }

  function applySeatCount(count) {
    const next = Math.max(MIN_PLAYERS, Math.min(count, MAX_PLAYERS));
    seatCount = next;
    seats.forEach((seat) => {
      if (seat.row) seat.row.classList.toggle('hidden', seat.index >= next);
      if (!seat.name.value.trim()) seat.name.value = seatLabel(seat.index);
    });
    el.modeTabs.querySelectorAll('.mode-btn').forEach((button) => {
      button.classList.toggle('active', Number(button.getAttribute('data-count')) === next);
    });
    el.modeHint.textContent =
      next > MIN_PLAYERS
        ? `多人模式：“对方”＝其余 ${next - 1} 名玩家；本体反噬由他们的本体承接，替身反噬由他们的替身承接。`
        : '双人同屏，或勾选“电脑”让 AI 接管任意席位。';
    return next;
  }

  function currentSeatConfig() {
    const names = [];
    const aiPlayerIndexes = [];
    for (let index = 0; index < seatCount; index += 1) {
      const seat = seats[index];
      names.push(seat.name.value.trim() || seatLabel(index));
      if (seat.ai.checked) aiPlayerIndexes.push(index);
    }
    return { names, aiPlayerIndexes };
  }

  /** 至少勾了一个电脑时才显示难度选择 */
  function syncDifficultyVisibility() {
    const anyAI = seats.some((seat) => seat.index < seatCount && seat.ai && seat.ai.checked);
    if (el.difficultyBlock) el.difficultyBlock.hidden = !anyAI;
  }

  function applyDifficulty(level) {
    aiLevel = Number(level) === DIFFICULTY.HARD ? DIFFICULTY.HARD : DIFFICULTY.EASY;
    if (el.difficultyTabs) {
      el.difficultyTabs.querySelectorAll('.mode-btn').forEach((button) => {
        button.classList.toggle('active', Number(button.getAttribute('data-level')) === aiLevel);
      });
    }
    if (el.difficultyHint) {
      el.difficultyHint.textContent =
        aiLevel === DIFFICULTY.HARD
          ? '进阶：普攻与召唤轮着用，始终把替身顶在前面当挡箭牌、只集火对方本体，破盾用异质，硬币只花在关键判定上。'
          : '简单：靠固定优先级加概率试探，容易浪费技能和硬币。';
    }
    try {
      window.localStorage.setItem('sbwar.difficulty', String(aiLevel));
    } catch (error) {
      /* 忽略隐私模式下的存储错误 */
    }
    return aiLevel;
  }

  function bindEvents() {
    el.startBtn.addEventListener('click', () => {
      const { names, aiPlayerIndexes } = currentSeatConfig();
      startGame(names, { aiPlayerIndexes, difficulty: aiLevel });
    });

    seats.forEach((seat) => {
      if (!seat.name) return;
      seat.name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') el.startBtn.click();
      });
      if (!seat.ai) return;
      seat.ai.addEventListener('change', () => {
        // 勾选电脑时给个默认名字，取消勾选时还原
        if (seat.ai.checked && seat.name.value.trim() === seatLabel(seat.index)) {
          seat.name.value = `电脑${seat.index + 1}`;
        }
        if (!seat.ai.checked && seat.name.value.trim() === `电脑${seat.index + 1}`) {
          seat.name.value = seatLabel(seat.index);
        }
        syncDifficultyVisibility();
      });
    });

    el.modeTabs.addEventListener('click', (event) => {
      const button = event.target.closest('.mode-btn');
      if (!button) return;
      applySeatCount(Number(button.getAttribute('data-count')));
      syncDifficultyVisibility();
      if (!game) render();
      seats[0].name.focus({ preventScroll: true });
    });

    if (el.difficultyTabs) {
      el.difficultyTabs.addEventListener('click', (event) => {
        const button = event.target.closest('.mode-btn');
        if (!button) return;
        applyDifficulty(button.getAttribute('data-level'));
      });
    }

    el.setupRulesBtn.addEventListener('click', openRules);
    el.rulesBtn.addEventListener('click', openRules);
    el.rulesClose.addEventListener('click', closeRules);
    el.rulesOverlay.addEventListener('click', (event) => {
      if (event.target === el.rulesOverlay) closeRules();
    });

    el.restartBtn.addEventListener('click', () => {
      if (!game) {
        resetToSetup();
        return;
      }
      if (game.over || window.confirm('当前对局尚未结束，确定要重开吗？')) resetToSetup();
    });

    el.againBtn.addEventListener('click', () =>
    startGame(savedNames, { aiPlayerIndexes: Array.from(aiPlayers), difficulty: aiLevel })
  );
    el.victorySetupBtn.addEventListener('click', resetToSetup);

    // 行动区事件委托
    el.actionArea.addEventListener('click', (event) => {
      const actorBtn = event.target.closest('[data-actor]');
      if (actorBtn) {
        selectedActor = actorBtn.getAttribute('data-actor');
        render();
        return;
      }

      const skillBtn = event.target.closest('[data-skill]');
      if (skillBtn && !skillBtn.disabled) {
        performSkill(Number(skillBtn.getAttribute('data-skill')));
        return;
      }

      if (event.target.closest('#passBtn')) {
        performPass();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !el.rulesOverlay.classList.contains('hidden')) {
        closeRules();
      }
    });
  }

  function loadNames() {
    try {
      const stored = JSON.parse(window.localStorage.getItem('sbwar.names') || 'null');
      if (Array.isArray(stored) && stored.length) {
        savedNames = DEFAULT_NAMES.map((fallback, index) =>
          index < MAX_PLAYERS ? String(stored[index] || fallback) : fallback
        );
      }
      const seatsStored = JSON.parse(window.localStorage.getItem('sbwar.seats') || 'null');
      if (Array.isArray(seatsStored)) {
        seatsStored.forEach((index) => {
          if (seats[index] && seats[index].ai) seats[index].ai.checked = true;
        });
      }
    } catch (error) {
      /* 忽略读取失败 */
    }

    const storedCount = Math.max(MIN_PLAYERS, Math.min(savedNames.length, MAX_PLAYERS));
    while (savedNames.length > storedCount) savedNames.pop();
    applySeatCount(storedCount);
    seats.forEach((seat) => {
      seat.name.value = savedNames[seat.index] || seatLabel(seat.index);
    });

    let storedLevel = DEFAULT_DIFFICULTY;
    try {
      storedLevel = Number(window.localStorage.getItem('sbwar.difficulty'));
    } catch (error) {
      /* 忽略读取失败 */
    }
    applyDifficulty(Number(storedLevel) === DIFFICULTY.HARD ? DIFFICULTY.HARD : DEFAULT_DIFFICULTY);
    syncDifficultyVisibility();
  }

  function init() {
    loadNames();
    buildRuleSkills();
    bindEvents();
    render();

    // 便于手工调试与自动化验收
    window.SBWarUI = {
      start: (names, options) => startGame(names || savedNames, options || {}),
      getGame: () => game,
      render,
      reset: resetToSetup,
      getAIPlayers: () => Array.from(aiPlayers),
      getDifficulty: () => aiLevel,
      /** 难度 2 上一手的判断理由（用于展示与测试） */
      getAIReason: () => aiReason,
      setDifficulty: (level) => applyDifficulty(level)
    };

    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
      startGame(['玩家一', '玩家二']);
    }
    if (params.get('demo') === 'battle') {
      startGame(['玩家一', '玩家二', '玩家三', '玩家四'], { aiPlayerIndexes: [1, 2, 3], firstPlayer: 0, difficulty: DIFFICULTY.HARD });
    }
    if (params.get('demo') === 'hard') {
      startGame(['人类', '进阶电脑'], { firstPlayer: 0, aiPlayerIndexes: [1], difficulty: DIFFICULTY.HARD });
    }
  }

  init();
})();
