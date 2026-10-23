/* ============================================================
   杀币战争 · 界面与交互
   ============================================================ */
(function () {
  'use strict';

  const { Game, SKILLS, SKILL_BY_ID, effectChips } = window.SBWar;
  const AI = window.SBWarAI;

  const $ = (id) => document.getElementById(id);
  const el = {
    board: $('board'),
    panel0: $('panel0'),
    panel1: $('panel1'),
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
    name0: $('name0'),
    name1: $('name1'),
    aiToggle: $('aiToggle'),
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
    coinConfirm0: $('coinConfirm0'),
    coinConfirm1: $('coinConfirm1'),
    coinHint: $('coinHint'),
    targetOverlay: $('targetOverlay'),
    targetTitle: $('targetTitle'),
    targetList: $('targetList'),
    victoryOverlay: $('victoryOverlay'),
    victoryTitle: $('victoryTitle'),
    victorySub: $('victorySub'),
    victoryReport: $('victoryReport'),
    againBtn: $('againBtn'),
    victorySetupBtn: $('victorySetupBtn')
  };

  let game = null;
  let selectedActor = null;
  let lastTurn = -1;
  let lastRenderedLogId = 0;
  let victoryShown = false;
  let startSequence = 0;
  let aiPlayerIndex = null;
  let aiTimer = null;
  let aiScheduled = false;
  let aiActing = false;
  let effectToastTimer = null;
  let lastEffectSignature = new Map();
  let changedEffects = new Map();

  let activeRoll = null;
  const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pendingCoin = null;
  let pendingTarget = null;

  let savedNames = ['玩家一', '玩家二'];

  // ---------------------------------------------------------- 工具

  const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPE[c]);

  function showOverlay(node) {
    if (node) node.classList.remove('hidden');
  }

  function hideOverlay(node) {
    if (node) node.classList.add('hidden');
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

  function slotsHTML(entity) {
    let html = '';
    for (let i = 0; i < entity.slotCap; i += 1) {
      const skillId = entity.slots[i];
      if (skillId === undefined) {
        html += '<div class="slot empty" aria-hidden="true"></div>';
        continue;
      }
      const skill = SKILL_BY_ID.get(skillId);
      if (!skill) continue;
      html += `<div class="slot filled" title="${esc(skill.name)}：${esc(skill.desc)}">
        <span class="slot-ico">${skill.icon}</span>
        <span class="slot-name">${esc(skill.name)}</span>
      </div>`;
    }
    return html;
  }

  function effectsHTML(entity, emptyText = '暂无效果') {
    const chips = effectChips(entity);
    if (!chips.length) return `<span class="effects-empty">${esc(emptyText)}</span>`;
    return chips
      .map(
        (chip) => {
          const pop = changedEffects.get(entity.id) && changedEffects.get(entity.id).has(chip.key) ? 'effect-pop' : '';
          return `<span class="effect-token tone-${chip.tone} ${pop}" data-effect="${chip.key}" title="${esc(chip.title)}">
          <span class="effect-icon">${chip.icon}</span>
          <span class="effect-name">${esc(chip.name)}</span>
          ${chip.value ? `<span class="effect-value">${esc(chip.value)}</span>` : ''}
        </span>`;
        }
      )
      .join('');
  }

  function entityHTML(entity, options = {}) {
    const isActive = options.active ? 'is-actor' : '';
    const isDead = entity.alive ? '' : 'is-dead';
    const hp = Math.max(0, entity.hp);
    const splitCaption = entity.split
      ? `阶段 ${entity.split.total - entity.split.remaining + 1} / ${entity.split.total}`
      : '生命值';
    const effectCount = effectChips(entity).length;
    return `
      <div class="entity ${isActive} ${isDead}">
        <div class="hp-block">
          <div class="hp-line">
            <span class="hp-value">${hp}</span>
            <span class="hp-max">/ ${entity.maxHp}</span>
            <span class="hp-caption ${entity.split ? 'phase' : ''}">${splitCaption}</span>
          </div>
          <div class="hp-pips">${pipsHTML(entity)}</div>
        </div>

        <div class="effects-block">
          <div class="mini-label"><span>已生效效果</span><em>${effectCount ? `${effectCount} 项` : '—'}</em></div>
          <div class="effects-grid">${effectsHTML(entity)}</div>
        </div>

        <div class="slots-block">
          <div class="mini-label"><span>技能槽</span><em>${entity.slots.length} / ${entity.slotCap}</em></div>
          <div class="slots">${slotsHTML(entity)}</div>
        </div>
      </div>
    `;
  }

  function standinHTML(standin, isCurrent) {
    if (!standin) {
      return `
        <div class="standin-card">
          <div class="standin-head">
            <span class="standin-title">替身</span>
            <span class="standin-none">未召唤</span>
          </div>
          <div class="standin-none">使用【召唤】获得 1 HP、2 技能槽的独立单位</div>
        </div>
      `;
    }

    const active = isCurrent && selectedActor === standin.id;
    const effectCount = effectChips(standin).length;
    return `
      <div class="standin-card has-standin ${active ? 'is-actor' : ''}">
        <div class="standin-head">
          <span class="standin-title">替身</span>
          <span class="standin-hp">生命 ${Math.max(0, standin.hp)} / ${standin.maxHp}${standin.split ? ` · 阶段 ${standin.split.remaining}/${standin.split.total}` : ''}</span>
        </div>
        <div class="mini-label"><span>已生效效果</span><em>${effectCount ? `${effectCount} 项` : '—'}</em></div>
        <div class="effects-grid compact">${effectsHTML(standin)}</div>
        <div class="standin-slots">
          <div class="mini-label"><span>技能槽</span><em>${standin.slots.length} / ${standin.slotCap}</em></div>
          <div class="slots two">${slotsHTML(standin)}</div>
        </div>
      </div>
    `;
  }

  function panelHTML(player, index) {
    const isCurrent = game.current === index && !game.over;
    const body = player.body;
    const bodyActive = isCurrent && selectedActor === body.id;
    return `
      <div class="panel-head">
        <div class="player-identity">
          <div class="player-label">PLAYER ${index === 0 ? 'ONE' : 'TWO'}</div>
          <h2 class="player-name">${esc(player.name)}${aiPlayerIndex === index ? ' <span class="ai-tag">电脑</span>' : ''}${body.alive ? '' : ' <span class="dead-tag">阵亡</span>'}</h2>
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

    if (aiPlayerIndex !== null && game.current === aiPlayerIndex) {
      return `
        <div class="ai-turn">
          <div class="ai-orb">AI</div>
          <p class="eyebrow">AI TURN</p>
          <h2 class="ai-title">${esc(playerName(aiPlayerIndex))} 正在${game.busy ? '结算' : '思考'}…</h2>
          <p class="ai-desc">电脑会根据双方生命、效果和技能槽选择行动。</p>
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

  function renderPanels() {
    if (!game) {
      el.panel0.innerHTML = idlePanelHTML(savedNames[0] || '玩家一', 'P1');
      el.panel1.innerHTML = idlePanelHTML(savedNames[1] || '玩家二', 'P2');
      el.panel0.classList.remove('is-active');
      el.panel1.classList.remove('is-active');
      return;
    }
    el.panel0.innerHTML = panelHTML(game.players[0], 0);
    el.panel1.innerHTML = panelHTML(game.players[1], 1);
    el.panel0.classList.toggle('is-active', game.current === 0 && !game.over);
    el.panel1.classList.toggle('is-active', game.current === 1 && !game.over);
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
      el.log.innerHTML = '';
      lastRenderedLogId = 0;
      return;
    }

    const entries = game.logs.slice(-220);
    const previousMax = lastRenderedLogId;
    lastRenderedLogId = entries.length ? entries[entries.length - 1].id : previousMax;

    el.log.innerHTML = entries
      .map((entry) => {
        const fresh = entry.id > previousMax ? 'log-new' : '';
        return `<div class="log-entry ${entry.type} ${fresh}">
          <span class="log-turn">${entry.turn}</span>
          <span class="log-text">${esc(entry.text)}</span>
        </div>`;
      })
      .join('');

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
    el.actionArea.innerHTML = actionHTML();
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
    if (aiPlayerIndex !== null && game.current === aiPlayerIndex) return;
    const actorId = selectedActor || defaultActorId(game.current);
    if (!actorId) return;
    const ok = await game.act(game.current, actorId, skillId);
    if (!ok) render();
  }

  async function performPass() {
    if (!game || game.busy || game.over) return;
    if (aiPlayerIndex !== null && game.current === aiPlayerIndex) return;
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
    if (!AI || !game || game.over || game.busy || aiPlayerIndex === null) return;
    if (game.current !== aiPlayerIndex) return;
    if (aiScheduled || aiActing) return;
    if (!el.rulesOverlay.classList.contains('hidden')) return;

    const instance = game;
    aiScheduled = true;
    aiTimer = window.setTimeout(() => {
      aiTimer = null;
      aiScheduled = false;
      if (game !== instance || game.over || game.busy || game.current !== aiPlayerIndex) return;
      if (!el.rulesOverlay.classList.contains('hidden')) return;
      runAITurn(instance);
    }, REDUCED_MOTION ? 350 : 900);
  }

  async function runAITurn(instance) {
    if (aiActing || !AI || game !== instance || game.over || game.busy || game.current !== aiPlayerIndex) return;
    aiActing = true;
    try {
      const action = AI.chooseAction(game, aiPlayerIndex);
      if (!action) {
        await game.pass(aiPlayerIndex);
      } else {
        const ok = await game.act(aiPlayerIndex, action.actorId, action.skillId);
        if (!ok && !game.over) await game.pass(aiPlayerIndex);
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

      const humanCoins = aiPlayerIndex !== null ? payload.coins.filter((coin) => coin.playerIdx !== aiPlayerIndex) : payload.coins;

      // AI 的硬币由启发式策略自动决定；决定使用时直接重掷，不打开给人类的面板
      if (aiPlayerIndex !== null && AI) {
        const aiCoin = AI.chooseCoin(payload, aiPlayerIndex);
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
              [el.coinConfirm0, el.coinConfirm1].forEach((button) => {
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
          const aiOwned = aiPlayerIndex !== null && coin.playerIdx === aiPlayerIndex;
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

      const confirmed = [false, false];
      const confirmButtons = [el.coinConfirm0, el.coinConfirm1];
      confirmButtons.forEach((button, index) => {
        const required = coinPlayers.has(index);
        button.classList.toggle('hidden', !required);
        button.disabled = !required;
        button.classList.remove('confirmed');
      });
      const updateConfirm = () => {
        confirmButtons.forEach((button, index) => {
          if (!coinPlayers.has(index)) return;
          button.textContent = `${playerName(index)} · ${confirmed[index] ? '已确认' : '不再使用'}`;
          button.classList.toggle('confirmed', confirmed[index]);
        });
      };
      const toggleConfirm = (index) => {
        if (!coinPlayers.has(index) || el.coinModal.classList.contains('is-rolling')) return;
        confirmed[index] = !confirmed[index];
        updateConfirm();
        if ([...coinPlayers].every((player) => confirmed[player])) finish({ done: true });
      };

      confirmButtons.forEach((button, index) => {
        button.onclick = () => toggleConfirm(index);
      });
      updateConfirm();

      const setRolling = () => {
        el.coinModal.classList.add('is-rolling');
        el.coinResult.textContent = '重掷中…';
        el.coinResult.className = 'coin-result';
        el.coinHint.textContent = '正在重掷，请稍候…';
        confirmButtons.forEach((button) => {
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

      const aiNote = aiPlayerIndex !== null ? ' 电脑的硬币由 AI 自动处理。' : '';
      el.coinHint.textContent = (revive
        ? '持有可用硬币的玩家确认后，本次复活判定以最后一次掷出的结果为准。'
        : '持有可用硬币的玩家确认后，本次随机数以最后一次掷出的结果为准。') + aiNote;

      showOverlay(el.coinOverlay);
      const firstCard = el.coinList.querySelector('.coin-card');
      if (firstCard) firstCard.focus({ preventScroll: true });
      else el.coinConfirm0.focus({ preventScroll: true });
    });
  }

  function chooseTarget(payload) {
    if (aiPlayerIndex !== null && payload.playerIdx === aiPlayerIndex) {
      const targetId = AI ? AI.chooseTarget(payload.candidates) : payload.candidates[0] && payload.candidates[0].id;
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(targetId), REDUCED_MOTION ? 150 : 550);
      });
    }

    return new Promise((resolve) => {
      if (pendingTarget) {
        const old = pendingTarget;
        pendingTarget = null;
        old(payload.candidates[0] ? payload.candidates[0].id : null);
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
      el.targetList.innerHTML = payload.candidates
        .map((candidate) => {
          const effects = candidate.effects.length
            ? candidate.effects.map((chip) => `<span class="target-stat">${chip.icon} ${esc(chip.label)}</span>`).join('')
            : '<span class="target-stat">无效果</span>';
          return `
            <button class="target-card" type="button" data-target="${candidate.id}">
              <span class="target-orb ${candidate.isStandin ? 'standin' : ''}">${candidate.isStandin ? '⊕' : '本'}</span>
              <span class="target-copy">
                <span class="target-name">${esc(candidate.name)} <span class="target-kind">${candidate.isStandin ? '替身' : '本体'}</span></span>
                <span class="target-stats">
                  <span class="target-stat">生命 ${Math.max(0, candidate.hp)} / ${candidate.maxHp}</span>
                  ${effects}
                </span>
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
    hideOverlay(el.setupOverlay);
    hideOverlay(el.victoryOverlay);
    hideOverlay(el.coinOverlay);
    hideOverlay(el.targetOverlay);
    hideOverlay(el.rulesOverlay);

    if (Object.prototype.hasOwnProperty.call(options, 'aiPlayerIndex')) {
      aiPlayerIndex = options.aiPlayerIndex === 0 || options.aiPlayerIndex === 1 ? options.aiPlayerIndex : null;
    } else {
      aiPlayerIndex = el.aiToggle && el.aiToggle.checked ? 1 : null;
    }

    savedNames = [names[0] || '玩家一', names[1] || '玩家二'];
    try {
      window.localStorage.setItem('sbwar.names', JSON.stringify(savedNames));
      window.localStorage.setItem('sbwar.ai', el.aiToggle && el.aiToggle.checked ? '1' : '0');
    } catch (error) {
      /* 忽略隐私模式下的存储错误 */
    }

    let firstPlayer = options.firstPlayer;
    if (firstPlayer !== 0 && firstPlayer !== 1) {
      firstPlayer = Math.random() < 0.5 ? 0 : 1;
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
          game === instance ? chooseTarget(payload) : Promise.resolve(payload.candidates[0] ? payload.candidates[0].id : null)
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
    game = null;
    aiPlayerIndex = null;
    selectedActor = null;
    lastTurn = -1;
    lastRenderedLogId = 0;
    victoryShown = false;

    hideOverlay(el.victoryOverlay);
    hideOverlay(el.coinOverlay);
    hideOverlay(el.targetOverlay);
    hideOverlay(el.rulesOverlay);
    showOverlay(el.setupOverlay);

    el.name0.value = savedNames[0] || '玩家一';
    el.name1.value = savedNames[1] || '玩家二';
    render();
    window.setTimeout(() => el.name0.focus({ preventScroll: true }), 60);
  }

  function victoryReportHTML() {
    const stats = game.stats || [];
    const columns = [0, 1].map((index) => {
      const s = stats[index] || {};
      const body = game.players[index].body;
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
        ['最终生命', `${Math.max(0, body.hp)} / ${body.maxHp}`]
      ];
      return `<div class="report-col ${index === 0 ? 'p0' : 'p1'}">
        <div class="report-col-head">
          <span>${esc(game.players[index].name)}</span>
          <em>${index === game.winner ? '胜者' : '败者'}</em>
        </div>
        <div class="report-stats">
          ${rows.map(([label, value]) => `<span>${label}<b>${value}</b></span>`).join('')}
        </div>
      </div>`;
    });

    const recent = game.logs
      .slice(-10)
      .map((entry) => `<div class="report-log-line ${entry.type}">${esc(entry.text)}</div>`)
      .join('');

    return `
      <div class="report-head"><span>战报</span><small>共 ${game.turn} 回合</small></div>
      <div class="report-grid">${columns.join('')}</div>
      <div class="report-recent">
        <div class="report-recent-title">最后记录</div>
        ${recent}
      </div>
    `;
  }

  function showVictory() {
    if (!game || !game.over) return;
    el.victoryTitle.textContent = `${playerName(game.winner)} 胜利`;
    el.victorySub.textContent = `第 ${game.turn} 回合结束 · 对手生命耗尽且复活失败`;
    el.victoryReport.innerHTML = victoryReportHTML();
    showOverlay(el.victoryOverlay);
    el.againBtn.focus({ preventScroll: true });
  }

  function rollHasCoin(payload) {
    if (!game || !payload.roller || payload.kind === 'first') return false;
    const roller = game.getEntity(payload.roller.id);
    if (roller && roller.lucky > 0) return true;
    const opponent = game.players[1 - payload.roller.owner];
    return [opponent.body, opponent.standin].some((entity) => entity && entity.alive && entity.curse > 0);
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

  function bindEvents() {
    el.startBtn.addEventListener('click', () => {
      const names = [el.name0.value.trim() || '玩家一', el.name1.value.trim() || '玩家二'];
      startGame(names, { aiPlayerIndex: el.aiToggle.checked ? 1 : null });
    });

    [el.name0, el.name1].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') el.startBtn.click();
      });
    });

    el.aiToggle.addEventListener('change', () => {
      if (el.aiToggle.checked && el.name1.value.trim() === '玩家二') el.name1.value = '电脑';
      if (!el.aiToggle.checked && el.name1.value.trim() === '电脑') el.name1.value = '玩家二';
    });

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

    el.againBtn.addEventListener('click', () => startGame(savedNames));
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
      if (Array.isArray(stored) && stored.length === 2) {
        savedNames = [String(stored[0] || '玩家一'), String(stored[1] || '玩家二')];
      }
      if (window.localStorage.getItem('sbwar.ai') === '1') {
        el.aiToggle.checked = true;
      }
    } catch (error) {
      /* 忽略读取失败 */
    }
    el.name0.value = savedNames[0];
    el.name1.value = savedNames[1];
    if (el.aiToggle.checked && el.name1.value === '玩家二') el.name1.value = '电脑';
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
      reset: resetToSetup
    };

    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
      startGame(['玩家一', '玩家二']);
    }
  }

  init();
})();
