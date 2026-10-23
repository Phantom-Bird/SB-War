'use strict';

/*
 * 无头浏览器冒烟测试（可选）
 * 使用本机 Chrome 的 DevTools Protocol 打开 index.html，模拟点击并截图。
 *
 * 运行：node scripts/ui-smoke.cjs
 * 可用 CHROME_PATH 环境变量指定浏览器路径。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CDP_PORT || 9333);
const SCREEN_DIR = path.join(ROOT, '.ui-screens');
const PROFILE_DIR = path.join(ROOT, '.chrome-smoke-profile');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(url, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`等待 ${url} 超时：${lastError ? lastError.message : '无响应'}`);
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (event) => reject(new Error(`WebSocket 失败：${event.message || 'unknown'}`)));
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const task = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) task.reject(new Error(JSON.stringify(message.error)));
        else task.resolve(message.result);
        return;
      }
      if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) handler(message.params);
      }
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function main() {
  const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!chromePath) throw new Error('未找到 Chrome / Edge，请设置 CHROME_PATH');

  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCREEN_DIR, { recursive: true });

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--window-size=1440,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const errors = [];
  let cdp;

  try {
    await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('没有可用的页面目标');

    cdp = new CDP(page.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', (params) => {
      errors.push(params.exceptionDetails.text || 'Runtime exception');
    });
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry && params.entry.level === 'error') errors.push(params.entry.text);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    const url = `${pathToFileURL(path.join(ROOT, 'index.html')).href}?demo=1`;

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        const description = details.exception && details.exception.description;
        throw new Error(description || details.text || '页面脚本执行失败');
      }
      return result.result.value;
    };

    const waitUntil = async (expression, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await sleep(80);
      }
      throw new Error(`等待条件超时：${expression}`);
    };

    const screenshot = async (name) => {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(SCREEN_DIR, name), Buffer.from(shot.data, 'base64'));
    };

    const assert = (condition, message) => {
      if (!condition) throw new Error(`断言失败：${message}`);
    };

    // 0. 开局设置：切换到四人混战
    let setupLoaded = false;
    cdp.on('Page.loadEventFired', () => {
      setupLoaded = true;
    });
    await cdp.send('Page.navigate', { url: `${pathToFileURL(path.join(ROOT, 'index.html')).href}` });
    for (let i = 0; i < 100 && !setupLoaded; i += 1) await sleep(100);
    await waitUntil("window.SBWarUI && !document.getElementById('setupOverlay').classList.contains('hidden')");
    await evaluate("document.querySelector('.mode-btn[data-count=\"4\"]').click(); true");
    assert(
      (await evaluate("document.querySelectorAll('.setup-row:not(.hidden)').length")) === 4,
      '四人混战应显示 4 个席位输入'
    );
    assert((await evaluate("document.getElementById('modeHint').textContent")).includes('对方'), '多人模式应说明“对方”的含义');
    await screenshot('00-setup-multiplayer.png');

    // 0.5 点击“电脑”标签应能切换该席位的 AI 开关（曾因 label 套多个控件而失效）
    const aiToggleResult = await evaluate(`(() => {
      const before = document.getElementById('ai1').checked;
      document.querySelector('.setup-row[data-row="1"] .setup-seat').click();
      const after = document.getElementById('ai1').checked;
      document.querySelector('.setup-row[data-row="1"] .setup-seat').click();
      return { before, after, restored: document.getElementById('ai1').checked };
    })()`);
    assert(aiToggleResult.after === !aiToggleResult.before, `点击“电脑”应能切换 AI 开关：${JSON.stringify(aiToggleResult)}`);
    assert(aiToggleResult.restored === aiToggleResult.before, '再次点击应能切回');

    // 0.6 难度选择：没有电脑时隐藏，勾选电脑后出现，切换后写进 localStorage
    const difficultyHidden = await evaluate("document.getElementById('difficultyBlock').hidden");
    assert(difficultyHidden === true, '没有电脑时不应显示难度选择');
    await evaluate("document.querySelector('.setup-row[data-row=\"1\"] .setup-seat').click(); true");
    await sleep(120);
    const difficultyVisible = await evaluate("!document.getElementById('difficultyBlock').hidden");
    assert(difficultyVisible, '勾选电脑后应显示难度选择');
    await evaluate("document.querySelector('#difficultyTabs .mode-btn[data-level=\"2\"]').click(); true");
    await sleep(120);
    const difficultyState = await evaluate(`(() => ({
      level: window.SBWarUI.getDifficulty(),
      stored: window.localStorage.getItem('sbwar.difficulty'),
      hint: document.getElementById('difficultyHint').textContent,
      active: document.querySelector('#difficultyTabs .mode-btn.active').getAttribute('data-level')
    }))()`);
    assert(difficultyState.level === 2, `难度应切到 2，实际 ${difficultyState.level}`);
    assert(difficultyState.stored === '2', `难度应写入本地存储，实际 ${difficultyState.stored}`);
    assert(difficultyState.active === '2', '难度按钮应高亮');
    assert(difficultyState.hint.includes('普攻'), '难度说明应描述进阶电脑的打法');
    await screenshot('00b-setup-difficulty.png');
    await evaluate("document.querySelector('.setup-row[data-row=\"1\"] .setup-seat').click(); true");
    await sleep(120);
    assert(
      (await evaluate("document.getElementById('difficultyBlock').hidden")) === true,
      '取消电脑后应重新隐藏难度选择'
    );

    // 1. 开局界面（演示入口会先播放先手动画）
    setupLoaded = false;
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 100 && !setupLoaded; i += 1) await sleep(100);
    await waitUntil(
      "window.SBWarUI && window.SBWarUI.getGame() && document.getElementById('rollStage').classList.contains('hidden')",
      8000
    );
    assert(await evaluate("document.getElementById('setupOverlay').classList.contains('hidden')"), '开局遮罩应已隐藏');
    assert((await evaluate("document.getElementById('turnStatusText').textContent")).includes('第 1 回合'), '应显示第 1 回合');

    // 2. 普通攻击与随机数动画（固定先手便于断言）
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        g.rng = () => 0.9;
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await sleep(350);
    await screenshot('01-roll.png');
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy');
    assert((await evaluate('window.SBWarUI.getGame().players[1].body.hp')) === 2, '攻击后对方应剩 2 点生命');
    await screenshot('01-battle.png');

    // 3. 已生效效果展示
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        const a = g.players[0].body;
        const b = g.players[1].body;
        a.sharpen = 2;
        a.shield = 1;
        a.lucky = 1;
        a.hp = 1;
        a.maxHp = 1;
        a.split = { total: 3, remaining: 2 };
        b.thorns = 1;
        b.tenacity = true;
        b.tenacityRecord = 2;
        b.hetero = true;
        window.SBWarUI.render();
        return true;
      })()
    `);
    await sleep(200);
    assert((await evaluate("document.querySelectorAll('#panel0 .effect-token').length")) === 4, '效果区应显示 4 个效果');
    const effectSize = await evaluate(`(() => {
      const token = document.querySelector('#panel0 .effect-token');
      const icon = token.querySelector('.effect-icon');
      return {
        tokenHeight: Math.round(token.getBoundingClientRect().height),
        iconSize: parseFloat(getComputedStyle(icon).fontSize)
      };
    })()`);
    assert(effectSize.tokenHeight >= 40, `效果卡片应有足够尺寸：height=${effectSize.tokenHeight}`);
    assert(effectSize.iconSize >= 16, `效果图标应足够大：font-size=${effectSize.iconSize}`);
    await screenshot('02-effects.png');

    // 3.2 文案用全称，且未召唤替身时只能出现一个 ⊕
    const labelText = await evaluate(`(() => ({
      player: document.querySelector('#panel0 .player-label').textContent.trim(),
      labels: Array.from(document.querySelectorAll('#panel0 .token-label')).map((n) => n.textContent.trim()),
      standinOrbs: document.querySelectorAll('#panel0 .standin-card.is-empty .standin-title').length,
      standinText: document.querySelector('#panel0 .standin-card.is-empty').textContent
    }))()`);
    assert(labelText.player === 'PLAYER ONE', `席位标签应使用全称：${labelText.player}`);
    assert(labelText.labels.includes('效果') && labelText.labels.includes('技能槽'), `应使用“效果 / 技能槽”全称：${JSON.stringify(labelText.labels)}`);
    assert(labelText.standinOrbs === 1, `未召唤替身时应只有一个 ⊕：${labelText.standinText}`);

    // 3.3 血条要撑满整行
    const pipFull = await evaluate(`(() => {
      const pips = document.querySelector('#panel0 .hp-pips');
      const first = pips.querySelector('.pip');
      return Math.round(first.getBoundingClientRect().width / pips.getBoundingClientRect().width * 100);
    })()`);
    assert(pipFull >= 20, `血条应横向铺开而不是缩在一角：单格占比 ${pipFull}%`);
    assert(
      (await evaluate("document.querySelector('#panel1 .effect-token[data-effect=\"tenacity\"] .effect-value').textContent")) === '2',
      '韧性图标应显示记录伤害'
    );
    assert(
      await evaluate("document.querySelector('#panel0 .effect-token.effect-pop') !== null"),
      '新生效的效果应有弹出动画'
    );

    // 3.5 每块玩家面板都应足够紧凑（不大于 512×512），保证一屏放得下
    // 真实最坏情况：本体 4 个技能槽全部记录 → 最多 4 个效果；替身 2 槽 → 最多 2 个效果
    const panelSizes = await evaluate(`(() => {
      const g = window.SBWarUI.getGame();
      for (const player of g.players) {
        if (!player.standin) g.summonStandin(player.body);
        for (const entity of [player.body, player.standin]) {
          g.clearEffects(entity);
          entity.hp = entity.maxHp;
          entity.slots = [];
        }
        player.body.sharpen = 2;
        player.body.shield = 1;
        player.body.lucky = 1;
        player.body.thorns = 1;
        player.body.slots = [1, 2, 6, 5].slice(0, player.body.slotCap);
        player.standin.tenacity = true;
        player.standin.tenacityRecord = 3;
        player.standin.curse = 1;
        player.standin.slots = [4, 7].slice(0, player.standin.slotCap);
      }
      window.SBWarUI.render();
      return Array.from(document.querySelectorAll('.player-panel')).map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.id, w: Math.round(rect.width), h: Math.round(rect.height) };
      });
    })()`);
    for (const panel of panelSizes) {
      assert(
        panel.w <= 512 && panel.h <= 512,
        `玩家面板过大：${panel.id} = ${panel.w}x${panel.h}（上限 512x512）`
      );
    }
    console.log(`  面板尺寸（4 效果 + 替身 2 效果的最坏情况）：${panelSizes.map((p) => `${p.id} ${p.w}x${p.h}`).join('，')}`);
    await screenshot('02b-worst-case-panels.png');
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        return true;
      })()
    `);
    await sleep(300);

    // 4. 规则弹层
    await evaluate("document.getElementById('rulesBtn').click();");
    await waitUntil("!document.getElementById('rulesOverlay').classList.contains('hidden')");
    await screenshot('03-rules.png');
    await evaluate("document.getElementById('rulesClose').click();");

    // 4.5 技能生效提示
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        g.rng = () => 0.9;
        document.querySelector('[data-skill="2"]').click();
        return true;
      })()
    `);
    await waitUntil(
      "document.getElementById('effectToast').classList.contains('show') && document.getElementById('effectToast').textContent.includes('护盾')",
      6000
    );
    await screenshot('03-effect-toast.png');
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy');

    // 5. 幸运币重掷
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        const seq = [0.1, 0.9];
        g.rng = () => (seq.length ? seq.shift() : 0.9);
        g.players[0].body.lucky = 1;
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await sleep(350);
    await screenshot('04-lucky-roll.png');
    await waitUntil("!document.getElementById('coinOverlay').classList.contains('hidden')");
    assert(
      await evaluate("!document.getElementById('coinConfirm0').classList.contains('hidden') && document.getElementById('coinConfirm1').classList.contains('hidden')"),
      '只有持有硬币的玩家需要确认'
    );
    await screenshot('04-lucky-coin.png');
    await evaluate("document.querySelector('.coin-card[data-coin-id$=\":lucky\"]').click();");
    await waitUntil("document.getElementById('coinOverlay').classList.contains('hidden')");
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy');
    assert((await evaluate('window.SBWarUI.getGame().players[1].body.hp')) === 2, '幸运币重掷成功后应命中');

    // 6. 目标选择（对方有替身）
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        const seq = [0.9, 0.1];
        g.rng = () => (seq.length ? seq.shift() : 0.9);
        g.summonStandin(g.players[1].body);
        window.SBWarUI.render();
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await waitUntil("!document.getElementById('targetOverlay').classList.contains('hidden')");
    const targetGroups = await evaluate("Array.from(document.querySelectorAll('#targetList [data-target]')).map(n => n.getAttribute('data-target'))");
    assert(targetGroups.includes('bodies') && targetGroups.includes('standins'), '目标面板应提供“全体对手本体 / 全体对手替身”两组');
    await screenshot('05-target.png');
    await evaluate("document.querySelector('[data-target=\"standins\"]').click();");
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy');
    assert((await evaluate('window.SBWarUI.getGame().players[1].standin')) === null, '替身应被击破并移除');

    // 7. 小偷随机选择动画
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        g.rng = () => 0.9;
        g.players[1].body.sharpen = 1;
        g.players[1].body.tenacity = true;
        document.querySelector('[data-skill="8"]').click();
        return true;
      })()
    `);
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy');
    await evaluate("document.getElementById('passBtn').click();");
    await waitUntil('window.SBWarUI.getGame().turn === 3 && !window.SBWarUI.getGame().busy');
    await evaluate("document.querySelector('[data-skill=\"0\"]').click();");
    await waitUntil("document.querySelector('#rollChoices .roll-choice.selected') !== null", 12000);
    assert((await evaluate("document.querySelectorAll('#rollChoices .roll-choice').length")) === 2, '偷取动画应展示两个候选效果');
    await screenshot('07-steal-roll.png');
    await waitUntil('!window.SBWarUI.getGame().busy', 12000);

    const logMetrics = await evaluate(`(() => {
      const log = document.getElementById('log');
      return { top: log.scrollTop, height: log.scrollHeight, client: log.clientHeight };
    })()`);
    assert(logMetrics.top + logMetrics.client >= logMetrics.height - 2, '战斗记录应自动滚动到底部');

    // 8. 一次性展示双方硬币，并由双方确认结束
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        g.rng = () => 0.1;
        g.players[0].body.lucky = 1;
        g.players[1].body.curse = 1;
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await waitUntil("!document.getElementById('coinOverlay').classList.contains('hidden')", 6000);
    assert((await evaluate("document.querySelectorAll('#coinList .coin-card').length")) === 2, '硬币面板应一次性展示双方可用硬币');
    assert(
      await evaluate("!document.getElementById('coinConfirm0').classList.contains('hidden') && !document.getElementById('coinConfirm1').classList.contains('hidden')"),
      '双方都持有硬币时都需要确认'
    );
    await screenshot('08-all-coins.png');
    await evaluate("document.getElementById('coinConfirm0').click(); document.getElementById('coinConfirm1').click();");
    await waitUntil("document.getElementById('coinOverlay').classList.contains('hidden')");
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy');
    assert((await evaluate('window.SBWarUI.getGame().players[0].body.hp')) === 2, '双方确认不使用硬币后，失败结果应生效并反噬');
    assert((await evaluate('window.SBWarUI.getGame().players[0].body.lucky')) === 1, '未使用的幸运币应保留');
    assert((await evaluate('window.SBWarUI.getGame().players[1].body.curse')) === 1, '未使用的诅咒币应保留');

    // 9. 幸运币干预复活判定
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 1 });
        const g = window.SBWarUI.getGame();
        const seq = [0.9, 0.1, 0.9];
        g.rng = () => (seq.length ? seq.shift() : 0.9);
        g.players[0].body.hp = 1;
        g.players[0].body.lucky = 1;
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await waitUntil("!document.getElementById('coinOverlay').classList.contains('hidden')", 9000);
    assert((await evaluate("document.getElementById('coinTitle').textContent")).includes('复活'), '复活判定应进入硬币干预界面');
    assert(
      await evaluate("!document.getElementById('coinConfirm0').classList.contains('hidden') && document.getElementById('coinConfirm1').classList.contains('hidden')"),
      '只有持有复活币的玩家需要确认'
    );
    await screenshot('09-revive-coin.png');
    await evaluate("document.querySelector('.coin-card[data-coin-id$=\":lucky\"]').click();");
    await waitUntil("document.getElementById('coinOverlay').classList.contains('hidden')");
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy', 9000);
    assert((await evaluate('window.SBWarUI.getGame().players[0].body.hp')) === 3, '幸运币重掷后应复活成功');

    // 10. 先手判定动画
    await evaluate("window.__oldGame = window.SBWarUI.getGame(); window.SBWarUI.start(['甲', '乙']); true");
    await waitUntil("!document.getElementById('rollStage').classList.contains('hidden')", 4000);
    await waitUntil("document.getElementById('rollEyebrow').textContent === 'FIRST TURN'", 3000);
    await waitUntil("document.getElementById('rollOutcome').textContent.includes('先手')", 5000);
    assert((await evaluate("document.getElementById('rollOutcome').textContent")).includes('先手'), '先手判定应展示动画');
    await screenshot('10-first-turn.png');
    await waitUntil("document.getElementById('rollStage').classList.contains('hidden') && window.SBWarUI.getGame() && window.SBWarUI.getGame() !== window.__oldGame", 7000);
    assert((await evaluate('window.SBWarUI.getGame().turn')) === 1, '先手动画结束后应开始第 1 回合');

    // 11. 电脑对手自动行动
    await evaluate("window.SBWarUI.start(['人类', '电脑'], { firstPlayer: 1, aiPlayerIndex: 1 }); true");
    await waitUntil("document.querySelector('#actionArea .ai-turn') !== null", 3000);
    await screenshot('11-ai-turn.png');
    await waitUntil('window.SBWarUI.getGame().current === 0 && !window.SBWarUI.getGame().busy', 20000);
    assert((await evaluate('window.SBWarUI.getGame().current')) === 0, '电脑行动后应轮到人类');

    // 11.5 难度 2：AI 回合面板应标明难度，并给出这一手的判断理由
    await evaluate("window.SBWarUI.start(['人类', '进阶电脑'], { firstPlayer: 1, aiPlayerIndex: 1, difficulty: 2 }); true");
    await waitUntil("document.querySelector('#actionArea .ai-turn') !== null", 3000);
    const aiPanel = await evaluate("document.querySelector('#actionArea .ai-turn .ai-desc').textContent");
    assert(aiPanel.includes('难度 2'), `AI 回合应标明难度 2，实际「${aiPanel}」`);
    assert(aiPanel.includes('进阶电脑'), 'AI 回合应标明“进阶电脑”');
    await screenshot('11b-ai-turn-hard.png');
    await waitUntil('window.SBWarUI.getGame().current === 0 && !window.SBWarUI.getGame().busy', 20000);
    const aiReason = await evaluate('window.SBWarUI.getAIReason()');
    assert(aiReason && aiReason.length > 0, '难度 2 应给出这一手的判断理由');

    // 12. 结束战报
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0, aiPlayerIndex: null });
        const g = window.SBWarUI.getGame();
        const seq = [0.9, 0.1];
        g.rng = () => (seq.length ? seq.shift() : 0.9);
        g.players[1].body.hp = 1;
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await waitUntil("!document.getElementById('victoryOverlay').classList.contains('hidden')", 9000);
    const reportText = await evaluate("document.getElementById('victoryReport').textContent");
    assert(reportText.includes('战报'), '对局结束后应显示战报');
    assert(reportText.includes('造成伤害'), '战报应包含伤害统计');
    await screenshot('12-victory-report.png');

    // 13. 四人混战：四块面板分列，判定失败由其余玩家的本体承接
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙', '丙', '丁'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        g.rng = () => 0.1; // 判定失败 → 反噬
        document.querySelector('[data-skill="1"]').click();
        return true;
      })()
    `);
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy', 9000);
    assert((await evaluate("document.querySelectorAll('.player-panel').length")) === 4, '四人混战应显示 4 块玩家面板');
    assert(
      (await evaluate("Array.from(document.querySelectorAll('#sideLeft .player-panel')).map(n => n.id).join(',')")) ===
        'panel0,panel1',
      '面板应在左右两列均衡分配'
    );
    assert((await evaluate("document.getElementById('panel2') !== null && document.getElementById('panel3') !== null")), '第三、四名玩家应有独立面板');
    assert((await evaluate('window.SBWarUI.getGame().players[1].body.sharpen')) === 1, '乙的本体应代为使用磨刀');
    assert((await evaluate('window.SBWarUI.getGame().players[2].body.sharpen')) === 1, '丙的本体应代为使用磨刀');
    assert((await evaluate('window.SBWarUI.getGame().players[3].body.sharpen')) === 1, '丁的本体应代为使用磨刀');
    assert((await evaluate('window.SBWarUI.getGame().players[0].body.sharpen')) === 0, '甲自己不算使用该技能');
    assert(
      (await evaluate("document.getElementById('log').textContent")).includes('由 丁 代为使用'),
      '战斗记录应出现第四名玩家的反噬'
    );
    await screenshot('13-multiplayer-backlash.png');

    // 14. 多人模式：普通攻击按“全体对手本体 / 全体对手替身”分组
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙', '丙', '丁'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        const seq = [0.9, 0.9];
        g.rng = () => (seq.length ? seq.shift() : 0.9);
        g.summonStandin(g.players[3].body);
        window.SBWarUI.render();
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await waitUntil("!document.getElementById('targetOverlay').classList.contains('hidden')", 6000);
    const groupIds = await evaluate("Array.from(document.querySelectorAll('#targetList [data-target]')).map(n => n.getAttribute('data-target'))");
    assert(groupIds.length === 2 && groupIds.includes('bodies') && groupIds.includes('standins'), '多人目标面板应只有本体组与替身组两项');
    const groupMembers = await evaluate("document.querySelector('[data-target=\"bodies\"] .target-members').textContent");
    assert(groupMembers.includes('乙') && groupMembers.includes('丙') && groupMembers.includes('丁'), '本体组应列出全部对手');
    assert((await evaluate("document.querySelectorAll('[data-target=\"bodies\"] .target-member').length")) === 3, '本体组应包含 3 名对手');
    assert((await evaluate("document.querySelectorAll('[data-target=\"standins\"] .target-member').length")) === 1, '替身组只包含丁的替身');
    await screenshot('14-multiplayer-target.png');
    await evaluate("document.querySelector('[data-target=\"bodies\"]').click();");
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy', 9000);
    const bodyHp = await evaluate("window.SBWarUI.getGame().players.map(p => p.body.hp)");
    assert(bodyHp[1] === 4 && bodyHp[2] === 4 && bodyHp[3] === 4, `攻击全体本体应让每名对手各掉 1 点：${JSON.stringify(bodyHp)}`);
    assert(bodyHp[0] === 5, '四人局本体生命上限应为 5');

    // 15. 多人模式：多枚硬币由多位玩家分别确认
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙', '丙', '丁'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        g.rng = () => 0.1;
        g.players[1].body.curse = 1;
        g.players[3].body.curse = 1;
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await waitUntil("!document.getElementById('coinOverlay').classList.contains('hidden')", 6000);
    assert((await evaluate("document.querySelectorAll('#coinList .coin-card').length")) === 2, '硬币面板应展示两位对手的诅咒币');
    assert(
      await evaluate("!document.getElementById('coinConfirm1').classList.contains('hidden') && !document.getElementById('coinConfirm3').classList.contains('hidden')"),
      '持币的第二、四名玩家都需要确认'
    );
    await screenshot('15-multiplayer-coins.png');
    await evaluate("document.getElementById('coinConfirm1').click(); document.getElementById('coinConfirm3').click();");
    await waitUntil("document.getElementById('coinOverlay').classList.contains('hidden')");
    await waitUntil('window.SBWarUI.getGame().turn === 2 && !window.SBWarUI.getGame().busy', 9000);

    // 16. 多人模式：电脑席位会轮流行动
    await evaluate("window.SBWarUI.start(['人类', '电脑二', '电脑三'], { firstPlayer: 1, aiPlayerIndexes: [1, 2] }); true");
    await waitUntil("document.querySelector('#actionArea .ai-turn') !== null", 3000);
    await waitUntil('window.SBWarUI.getGame().current === 0 && !window.SBWarUI.getGame().busy', 30000);
    assert((await evaluate('window.SBWarUI.getGame().turn')) > 1, '两个电脑席位应依次完成行动');
    assert(
      (await evaluate("document.getElementById('panel1').textContent")).includes('电脑'),
      '电脑席位应有标记'
    );
    await screenshot('16-multiplayer-ai.png');

    // 17. 多人模式战报：淘汰两人后才分出胜负
    await evaluate(`
      (async () => {
        window.SBWarUI.start(['甲', '乙', '丙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        await g.eliminate(g.players[2].body);
        window.SBWarUI.render();
        const seq = [0.9, 0.1];
        g.rng = () => (seq.length ? seq.shift() : 0.9);
        g.players[1].body.hp = 1;
        document.querySelector('[data-skill="0"]').click();
        return true;
      })()
    `);
    await waitUntil("!document.getElementById('victoryOverlay').classList.contains('hidden')", 12000);
    const battleReport = await evaluate("document.getElementById('victoryReport').textContent");
    assert((await evaluate("document.querySelectorAll('#victoryReport .report-col').length")) === 3, '战报应展示每位玩家');
    assert(battleReport.includes('胜者'), '战报应标出胜者');
    assert(battleReport.includes('退场'), '战报应标出已退场的玩家');
    await screenshot('17-multiplayer-report.png');

    // 17.5 多人战报排版：弹窗要更宽、每列要够宽，避免“造成伤害 12”错误换行
    const battleReportLayout = await evaluate(`(() => {
      const modal = document.querySelector('.victory-modal');
      const cols = Array.from(document.querySelectorAll('#victoryReport .report-col'));
      const cells = Array.from(document.querySelectorAll('#victoryReport .report-stats span'));
      return {
        modalW: Math.round(modal.getBoundingClientRect().width),
        isBattle: modal.classList.contains('is-battle'),
        colW: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
        wrappedCells: cells.filter((cell) => cell.getBoundingClientRect().height > 26).length
      };
    })()`);
    assert(battleReportLayout.isBattle, '多人战报应给弹窗加上 is-battle 宽版样式');
    assert(battleReportLayout.modalW >= 900, `多人战报弹窗应更宽：${battleReportLayout.modalW}px`);
    for (const colW of battleReportLayout.colW) {
      assert(colW >= 220, `战报列过窄会导致文字换行：${colW}px`);
    }
    assert(battleReportLayout.wrappedCells === 0, `战报统计项不应换行：${battleReportLayout.wrappedCells} 项异常`);

    // 18. 移动端布局（四人混战，检查面板不会横向溢出）
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true
    });
    let reloaded = false;
    cdp.on('Page.loadEventFired', () => {
      reloaded = true;
    });
    await cdp.send('Page.navigate', { url: `${pathToFileURL(path.join(ROOT, 'index.html')).href}?demo=battle` });
    for (let i = 0; i < 100 && !reloaded; i += 1) await sleep(100);
    await sleep(400);
    await waitUntil(
      "window.SBWarUI && window.SBWarUI.getGame() && document.getElementById('rollStage').classList.contains('hidden')",
      7000
    );
    assert((await evaluate("document.querySelectorAll('.player-panel').length")) === 4, '移动端四人混战应显示 4 块面板');
    const metrics = await evaluate(`(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      board: document.getElementById('board').scrollWidth,
      panel: Math.round(document.getElementById('panel0').getBoundingClientRect().width),
      topbar: Math.round(document.querySelector('.topbar').getBoundingClientRect().width)
    }))()`);
    await screenshot('18-mobile-battle.png');
    assert(
      metrics.document <= metrics.viewport + 1,
      `移动端出现横向溢出：viewport=${metrics.viewport}, document=${metrics.document}, board=${metrics.board}, panel=${metrics.panel}, topbar=${metrics.topbar}`
    );

    // 18.5 窄屏排布：左右两列并排，且都在战斗记录上方
    const mobileLayout = await evaluate(`(() => {
      const left = document.getElementById('sideLeft');
      const right = document.getElementById('sideRight');
      const log = document.querySelector('.log-card');
      const rect = (node) => {
        const r = node.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) };
      };
      return {
        left: rect(left),
        right: rect(right),
        log: rect(log),
        leftPanels: left.querySelectorAll('.player-panel').length,
        rightPanels: right.querySelectorAll('.player-panel').length
      };
    })()`);
    assert(mobileLayout.leftPanels === 2 && mobileLayout.rightPanels === 2, `窄屏应两列各 2 块面板：${JSON.stringify(mobileLayout)}`);
    assert(
      mobileLayout.right.left > mobileLayout.left.left,
      `窄屏右栏应排在左栏右侧：left=${mobileLayout.left.left}, right=${mobileLayout.right.left}`
    );
    assert(
      mobileLayout.right.top < mobileLayout.log.top,
      `窄屏右栏不应被排到战斗记录下方：right.top=${mobileLayout.right.top}, log.top=${mobileLayout.log.top}`
    );
    assert(
      Math.abs(mobileLayout.left.top - mobileLayout.right.top) <= 1 && mobileLayout.right.left >= mobileLayout.left.right,
      `窄屏两侧面板应并排且不重叠：${JSON.stringify(mobileLayout)}`
    );

    // 19. 战斗记录条目不应被面板样式挤压（曾经 .slot 类名串扰把日志压成 24px 竖条）
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        g.log('甲 让本体使用【磨刀】', 'skill');
        g.log('甲 的技能槽记录了【磨刀】（1/4）', 'slot');
        g.log('甲 磨刀，下次伤害 +1（当前 1 层）', 'effect');
        window.SBWarUI.render();
        return true;
      })()
    `);
    const logLayout = await evaluate(`(() => {
      const entries = Array.from(document.querySelectorAll('#log .log-entry'));
      return entries.map((entry) => {
        const text = entry.querySelector('.log-text');
        return {
          w: Math.round(entry.getBoundingClientRect().width),
          textW: Math.round(text.getBoundingClientRect().width),
          textH: Math.round(text.getBoundingClientRect().height)
        };
      });
    })()`);
    for (const entry of logLayout) {
      assert(entry.w >= 300, `战斗记录条目被压窄：${entry.w}px`);
      assert(entry.textW >= 100 && entry.textH <= 40, `战斗记录文本换行异常：textW=${entry.textW}, textH=${entry.textH}`);
    }

    // 20. 动画不应绑定渲染频率：重复 render 不应重建节点，循环动画要挂在稳定节点上
    const animState = await evaluate(`(() => {
      const chipBefore = document.querySelector('.turn-chip');
      window.SBWarUI.render();
      window.SBWarUI.render();
      const chipAfter = document.querySelector('.turn-chip');
      const panel = document.querySelector('.player-panel.is-active');
      return {
        stable: chipBefore === chipAfter,
        breathe: panel ? getComputedStyle(panel, '::after').animationName : null
      };
    })()`);
    assert(animState.stable, '重复 render 不应重建行动区节点（否则 CSS 动画会不断重播）');
    assert(animState.breathe === 'chip-breathe', `呼吸动画应挂在不会被重建的面板节点上：${animState.breathe}`);

    // 21. 多人战报数据准备（弹窗排版的断言在 17.5，弹窗需要真正打开）
    await evaluate(`
      (() => {
        window.SBWarUI.start(['甲', '乙', '丙', '丁'], { firstPlayer: 0 });
        const g = window.SBWarUI.getGame();
        for (let i = 1; i < 4; i += 1) g.stats[i].damageDealt = 1234;
        window.SBWarUI.render();
        return true;
      })()
    `);
    await sleep(200);
    assert(errors.length === 0, `页面出现错误：${errors.join(' | ')}`);

    console.log(`UI 冒烟测试通过，截图目录：${SCREEN_DIR}`);
  } finally {
    if (cdp && cdp.ws) {
      try {
        cdp.ws.close();
      } catch (error) {
        /* ignore */
      }
    }
    if (!chrome.killed) {
      spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    for (let i = 0; i < 10; i += 1) {
      try {
        fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
        break;
      } catch (error) {
        await sleep(250);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
