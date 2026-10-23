# 杀币战争 · AI 交接文档

> 面向接手本项目的其他 AI / 开发者。当前版本已经可玩：双人同屏、单人 vs 电脑、完整技能与硬币流程、动画、战报和自动化测试。
>
> 最后更新时间：2026-10-23

---

## 1. 项目定位

纯前端本地对战游戏，基于 [`杀币战争.txt`](杀币战争.txt) 的规则实现。

- 无构建工具、无第三方运行时依赖。
- 直接双击 [`index.html`](index.html) 即可运行；也可 `pnpm start` 启动零依赖静态服务器。
- 规则引擎与 DOM 解耦，可单独用 Node.js 测试；AI 也是纯逻辑模块。
- 中文 UI；代码注释与 README 使用中文。

## 2. 快速开始

```bash
# 直接打开
index.html

# 本地服务器（可选）
pnpm start          # http://127.0.0.1:4173

# 规则 + AI 测试
pnpm test           # node tests/all.test.cjs

# 可选：无头 Chrome 界面冒烟测试
pnpm test:ui        # 需要本机 Chrome 或 Edge
```

当前测试规模：**51 项**（23 核心规则 + 21 边界规则 + 7 AI 策略）。

## 3. 文件职责

| 文件 | 职责 |
| --- | --- |
| `index.html` | 页面骨架、规则手册、设置、硬币/目标/战报弹层 |
| `styles.css` | 深色主题、响应式布局、动画、效果图标、战报样式 |
| `js/engine.js` | 纯规则引擎（UMD）：状态、技能、判定、伤害、硬币、复活、统计 |
| `js/ai.js` | 简单启发式 AI（UMD）：选人、选技能、选目标、硬币策略 |
| `js/ui.js` | 渲染、事件、弹层、动画调度、AI 回合调度、战报 |
| `tests/engine.test.cjs` | 核心规则测试 |
| `tests/engine.edge.test.cjs` | 边界/交互规则测试 |
| `tests/ai.test.cjs` | AI 策略测试 |
| `tests/all.test.cjs` | 单进程运行全部测试 |
| `scripts/serve.cjs` | 零依赖静态服务器 |
| `scripts/ui-smoke.cjs` | 无头 Chrome + CDP 冒烟测试（截图写入 `.ui-screens/`） |
| `docs/` | README 使用的界面截图 |
| `HANDOFF.md` | 本文件 |

## 4. 引擎架构

### 4.1 创建与启动

```js
const game = new SBWar.Game({
  rng: Math.random,   // 可注入，测试用
  io: { /* 见 4.4 */ }
});

game.start(['玩家一', '玩家二'], { firstPlayer: 0 });
```

- `firstPlayer` 可省略：引擎会用 `rng()` 随机决定先手。
- UI 的正常开局会先播放先手动画，再把结果作为 `firstPlayer` 传入。
- 引擎不依赖浏览器 API，可在 Node 中直接运行。

### 4.2 实体模型

每名玩家有：

```js
player = {
  index: 0,
  name: '甲',
  body: Entity,
  standin: Entity | null
}
```

`Entity` 主要字段：

```js
{
  id, name, owner, isStandin,
  hp, maxHp, alive,
  slotCap, slots: [skillId...],
  shield, sharpen, thorns,
  tenacity, tenacityRecord,
  split: { total, remaining } | null,
  hetero, thief, lucky, curse
}
```

效果字段与技能的对应关系集中写在 `effectChips(entity)`（`js/engine.js`）。新增效果时必须同步：

- `makeEntity`
- `effectChips`
- `clearEffects`
- `stealableEffects` / `removeEffect` / `attachEffect`（若可被偷取）
- 复活/复活清理逻辑

### 4.3 关键公开方法

```js
game.start(names, opts)
game.act(playerIdx, actorId, skillId)   // async，完整一回合行动
game.pass(playerIdx)                    // async
game.getActors(playerIdx)
game.getSkillsFor(actor)
game.canUseSkill(actor, skillId)
game.getEntity(id)
game.describe(entity)
game.damage(source, target, amount, opts) // async，伤害链
game.stats                               // 战报统计
game.logs
```

UI 和 AI **不要直接修改** `hp`、`slots`、效果字段来推进对局；通过 `act/pass/damage` 等公开方法，避免绕过判定、复活、统计和动画。当前 UI 只在测试/演示状态构造时直接改字段，属于调试行为。

### 4.4 `io` 钩子（UI 与引擎的契约）

```js
{
  chooseCoinIntervention(payload), // 返回 { coinId } 或 { done: true }
  chooseTarget(payload),           // 返回目标 entity id
  animateRoll(payload),            // await；播放随机数动画
  pause(ms),                       // await；效果连锁间隔
  onEffect(payload),               // 技能效果生效提示
  onRoll(payload),                 // 随机数最终结果（当前 UI 未使用）
  onLog(entry),
  changed(),
  onGameOver(result)
}
```

默认实现都在 `DEFAULT_IO`，测试无需提供全部钩子。

#### 硬币干预 payload

```js
{
  roller: describe(entity),
  label: '普通攻击判定',
  value: 0 | 1 | 1..sides,
  sides,
  isCheck,
  kind: 'check' | 'die',
  display: '成功' | '失败' | '点数 2',
  coins: [{
    id: 'p0:lucky',
    coin: 'lucky' | 'curse',
    holderId,
    holderName,
    playerIdx,
    holder: describe(entity)
  }],
  meta: { type:'steal', choices:[...] } | null
}
```

规则：

- 所有可用硬币一次性放入 `coins`。
- UI 返回 `{coinId}` 后引擎消费该硬币、重掷、再次调用本钩子。
- UI 返回 `{done:true}` 后结果生效。
- 硬币用尽后引擎不再调用本钩子。
- AI 模式下，AI 的硬币由 `js/ai.js` 自动决定；人类面板只显示/确认人类硬币。

#### 目标 payload

```js
{
  playerIdx: 行动者 owner,
  actor: describe(actor),
  purpose: '选择普通攻击的目标',
  candidates: [describe(entity), ...]
}
```

AI 行动时 `playerIdx === aiPlayerIndex`，UI 自动选择，不弹面板。

### 4.5 回合与异步流程

一次 `act` 大致是：

1. 校验行动者与技能槽。
2. 记录技能使用统计。
3. `rollCheck` → `animateRoll` → 硬币干预。
4. 成功：占槽 + `resolveSkill`；失败：普通攻击自伤，其他技能按规则反用。
5. 技能效果/伤害链中多次 `beat()`（刷新 UI + `pause`）。
6. `endTurn`（韧性结算）→ 切换玩家。

重要：整个流程是 `async` 的。任何在引擎内新增的异步步骤都必须 `await`，否则状态会在动画/弹层之前推进。

## 5. 规则实现的当前约定

这些约定同时写在游戏内「规则 → 本实现的约定」和 README 表格中。修改规则时三处要同步。

| 议题 | 当前行为 |
| --- | --- |
| 普通攻击失败 | 自伤 1 点，不由对方承接；自伤触发磨刀、护盾、韧性、反甲等，反甲打向对方本体；小偷不从自己身上偷。 |
| 失败反用 | 本体失败 → 对方本体；替身失败 → 对方替身；没有对应实体则落空。 |
| 真实伤害 | 无视护盾、反甲、韧性、小偷；不增幅也不消耗磨刀；正常触发复活。 |
| 拆分 | 成功保住当前阶段；非最后阶段失败（含**负生命惩罚判定失败**）只失去当前阶段并进入下一阶段；最后阶段失败才出局；最后阶段复活成功解除拆分，生命值 1/3。 |
| 韧性 | 拥有者自己的回合结束时结算一半（四舍五入）；再次获得时立即结算全部。 |
| 小偷 | 伤害结算后触发；护盾/反甲/复活先结算，再偷剩余效果。 |
| 硬币 | 一次性展示所有可用硬币；只有持有可用硬币的玩家需要确认；硬币用尽自动关闭；以最后一次结果为准；复活/惩罚判定同样适用。 |
| 先手 | 随机；UI 有先手动画。 |
| 替身 | 每位玩家最多一个；本体死亡即失败；替身独立生命/槽/效果/复活。 |
| 伤害连锁 | 反甲链最多递归 16 层。 |

近期修复：**拆分状态下负生命惩罚判定失败**现在与阶段复活失败一致，只失去当前阶段，不会直接出局。回归测试在 `tests/engine.edge.test.cjs`。

## 6. UI 结构

### 6.1 渲染

`render()`：

1. 处理回合切换后的默认行动者。
2. `prepareEffectChanges()`：对比上一次效果快照，标记新生效/变化的 token（用于 `effect-pop` 动画）。
3. 渲染状态栏、双方面板、行动区、战斗日志。
4. 游戏结束 → 520ms 后 `showVictory()`。
5. `scheduleAITurn()`。

`actionHTML()` 的三个特殊分支：

- `game.over` → 结算卡。
- 当前是 AI → `AI TURN` 思考面板（人类不能操作）。
- 正常人类 → 技能按钮。

### 6.2 弹层

| 弹层 | 行为 |
| --- | --- |
| 掷币/随机数 | `rollStage`，z-index 70，无背景模糊；结果停留 ≥1s |
| 硬币干预 | 底部停靠 `coinOverlay`，无模糊；只显示持币玩家的确认按钮 |
| 目标选择 | 底部停靠 `targetOverlay`，无模糊 |
| 规则 / 战报 | 居中，半透明背景，无模糊 |

z-index 约定：普通 overlay 60，掷币动画 70，效果提示 80。

### 6.3 效果提示

- 引擎 `applyEffect` 结束调用 `io.onEffect`。
- UI `showEffectToast`：顶部浮动提示“技能名 / 实体 · 技能发动”。
- `prepareEffectChanges` 对比效果签名；变化的效果 token 加 `.effect-pop`。
- `prefers-reduced-motion` 下提示保持静态可见，不播放动画。

新增效果动画时，优先复用 `io.onEffect`，不要从 UI 直接解析日志文本。

### 6.4 战报

引擎在关键节点累计 `game.stats`：

```js
{
  damageDealt, damageTaken, skillsUsed,
  checks, successes, failures,
  revives, coins, steals, summons
}
```

- 只在**实际扣 HP**时累计伤害；护盾完全抵挡/韧性记录不算“造成伤害”，韧性结算时算受到伤害。
- `showVictory()` 调用 `victoryReportHTML()`，渲染双方统计和最近 10 条日志。
- 新增统计项时：引擎累计 + `victoryReportHTML` 展示 + 战报测试。

## 7. AI

### 7.1 接入方式

- 开局勾选 `#aiToggle` → 玩家二由 AI 控制。
- `startGame` 设置 `aiPlayerIndex`；`SBWarUI.start` 也可传 `{aiPlayerIndex: 1}` 供测试。
- AI 是玩家二（UI 层面固定；若扩展到 AI 先手/双方 AI，`aiPlayerIndex` 已支持 0/1）。
- AI 决策纯逻辑在 `js/ai.js`：

```js
SBWarAI.chooseAction(game, playerIdx, rng)
SBWarAI.chooseTarget(candidates)
SBWarAI.chooseCoin(payload, aiPlayerIndex)
```

### 7.2 策略摘要

- 本体 1 血且存在替身 → 替身行动。
- 濒死优先护盾/韧性；对方本体 1 血 → 普攻补刀。
- 无替身时优先召唤；之后按概率使用磨刀、护盾、韧性、反甲、小偷、幸运、诅咒、异质、拆分。
- 普通攻击兜底。
- 目标：先补 1 血目标，否则打本体。
- 硬币：自己判定失败用幸运币，对方判定成功用诅咒币；随机偷取不干预。
- AI 硬币自动处理；人类持币时显示 AI 硬币为“电脑保留”。

### 7.3 调度与并发

- `render()` 末尾 `scheduleAITurn()`；`aiScheduled/aiActing` 防止重复。
- 延迟 900ms（减少动态效果时 350ms）。
- 规则弹层打开时暂停 AI，关闭后恢复。
- `cancelAITurn()` 在开新局/返回设置时清除 timer。
- timer 捕获 `instance = game`，切换对局后旧 timer 自动失效。

新增 AI 行为时，不要直接在 UI 里操作 `game.players`；调用 `game.act/pass`，否则会绕过判定和动画。

## 8. 测试与调试

### 8.1 规则测试

```bash
pnpm test
```

- `tests/engine.test.cjs`：基础状态、判定、技能、复活、硬币、统计。
- `tests/engine.edge.test.cjs`：替身、拆分边界、小偷、硬币顺序、自伤、真实伤害等。
- `tests/ai.test.cjs`：AI 选人/技能/目标/硬币。
- 测试使用注入 `rng`，不要依赖 `Math.random`。
- 断言日志时用 `game.logs.map(l => l.text).join('\n')`。

### 8.2 UI 冒烟

```bash
pnpm test:ui
```

- 需要 Chrome/Edge；`CHROME_PATH` 可覆盖。
- 覆盖：先手动画、普通攻击、技能提示、规则、硬币面板（双方/单方/用尽关闭）、偷取动画、复活硬币、AI 行动、战报、移动端横向溢出。
- 截图输出到 `.ui-screens/`（gitignore）。
- 使用 CDP 的 `Runtime.evaluate`；多语句脚本要用 IIFE，避免 `const` 重复声明。
- 当前 headless 环境可能默认 `prefers-reduced-motion: reduce`；UI 对减少动态效果有静态兜底。

### 8.3 调试入口

`window.SBWarUI`：

```js
SBWarUI.start(names, { firstPlayer: 0, aiPlayerIndex: null })
SBWarUI.getGame()
SBWarUI.render()
SBWarUI.reset()
```

可在浏览器控制台直接改 `game.players[0].body.hp` 等做状态构造，但仅限调试。

## 9. 常见坑

1. **异步取消**：`startSequence`、`activeRoll`、`pendingCoin`、`aiTimer` 是四套独立取消机制，改动开局/重开逻辑时不要只清其中一套。
2. **效果提示钩子位置**：`onEffect` 必须放在 `applyEffect` 的尾部，不能放进 `attachEffect`（曾因此出现 `skillId is not defined`）。
3. **硬币面板**：不要重新引入“硬币用尽后空面板”；引擎在无硬币时不会调用 `chooseCoinIntervention`。
4. **AI 硬币与人类面板**：AI 硬币由 AI 自动决定，人类面板的 `coinPlayers` 只应包含人类；AI 硬币显示为“电脑保留”。
5. **效果 token 动画**：`changedEffects` 依赖 `prepareEffectChanges` 在 `renderPanels` 前执行；不要在渲染函数内部再次调用 `render()`。
6. **CSS 动画与减少动态效果**：全局 `prefers-reduced-motion` 会压缩动画；新提示类需要检查静态可见性。
7. **日志自动滚动**：`renderLog()` 每次都滚到底部，这是产品要求；不要改回“仅在底部时滚动”。
8. **z-index**：新增全屏 overlay 时确认没有盖住掷币动画/效果提示。
9. **`color-mix`**：CSS 使用了 `color-mix`，现代 Chrome/Edge/Firefox 支持；若要兼容旧浏览器需补 fallback。

## 10. 扩展建议

### 加一个新技能

1. `SKILLS` 增加条目（id、icon、name、desc、short、accent）。
2. 若是被动/持续效果：在 `applyEffect` 增加 case，并补实体字段/`effectChips`/`clearEffects`。
3. 若可被偷：补 `stealableEffects`、`removeEffect`、`attachEffect`。
4. 更新规则手册、README 表格、UI 测试。
5. 加引擎测试，至少覆盖成功/失败反用/复活清理/小偷交互。

### 加一个新的界面动画

- 优先用 `io.onEffect`、`io.animateRoll`、`io.pause` 三个钩子，不要在 UI 里解析日志。
- 动画必须 `pointer-events:none`，不得阻塞行动。
- 不要给背景加模糊，产品要求观察战局。

### 联机化

- 引擎是纯逻辑，可直接在服务端运行。
- 需要把 `io.chooseCoinIntervention / chooseTarget / animateRoll / pause` 改成网络 RPC；同时处理双方异步确认、断线重连、硬币双方确认。
- 状态同步建议以 `game.describe()` + `game.logs` 增量传输；不要直接传实体引用。
- 注意 `Game` 内部使用 `this` 状态和 async；联机时建议每局一个实例，串行化行动队列。

## 11. 当前待办 / 可继续做的方向

- 音效与技能释放演出。
- AI 难度分级或更长期规划。
- 完整战报导出/分享、回放。
- 移动端更紧凑的面板（当前可用但信息密度较高）。
- 联机服务器与断线重连。
- 速度选项（当前单次判定 + 效果连锁节奏偏慢）。
- 规则自定义开关（当前歧义约定是写死的）。

## 12. 交接检查清单

- [x] `pnpm test` 51 项通过
- [x] `pnpm test:ui` 通过
- [x] 双人同屏可玩
- [x] 单人 vs 电脑可玩
- [x] 硬币干预、复活、拆分、小偷、AI、战报均已覆盖
- [x] README 与本交接文档同步
- [ ] 声音/美术/联机等由后续接手者继续

---

如有规则歧义，优先在 `README.md` 的「规则实现中的取舍」和本文件第 5 节记录；不要把未记录的特殊行为直接写进 UI。
