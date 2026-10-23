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

    let loaded = false;
    cdp.on('Page.loadEventFired', () => {
      loaded = true;
    });

    const url = `${pathToFileURL(path.join(ROOT, 'index.html')).href}?demo=1`;
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 100 && !loaded; i += 1) await sleep(100);
    await sleep(500);

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

    // 1. 开局界面（演示入口会先播放先手动画）
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
    assert((await evaluate("document.querySelector('#panel0 .effect-token').getBoundingClientRect().height")) >= 56, '效果图标应足够大');
    assert(
      (await evaluate("document.querySelector('#panel1 .effect-token[data-effect=\"tenacity\"] .effect-value').textContent")) === '2',
      '韧性图标应显示记录伤害'
    );
    assert(
      await evaluate("document.querySelector('#panel0 .effect-token.effect-pop') !== null"),
      '新生效的效果应有弹出动画'
    );
    await screenshot('02-effects.png');

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
    await screenshot('05-target.png');
    await evaluate("document.querySelector('[data-target=\"p1s\"]').click();");
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

    // 13. 移动端布局
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
    await cdp.send('Page.reload');
    for (let i = 0; i < 100 && !reloaded; i += 1) await sleep(100);
    await sleep(400);
    await waitUntil(
      "window.SBWarUI && window.SBWarUI.getGame() && document.getElementById('rollStage').classList.contains('hidden')",
      7000
    );
    const metrics = await evaluate(`(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      board: document.getElementById('board').scrollWidth,
      panel: Math.round(document.getElementById('panel0').getBoundingClientRect().width),
      topbar: Math.round(document.querySelector('.topbar').getBoundingClientRect().width)
    }))()`);
    await screenshot('13-mobile.png');
    assert(
      metrics.document <= metrics.viewport + 1,
      `移动端出现横向溢出：viewport=${metrics.viewport}, document=${metrics.document}, board=${metrics.board}, panel=${metrics.panel}, topbar=${metrics.topbar}`
    );

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
