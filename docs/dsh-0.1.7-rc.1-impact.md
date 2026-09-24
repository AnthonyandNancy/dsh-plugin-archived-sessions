# DSH 0.1.7-rc.1 对本插件的影响（调查 + 执行记录）

> 状态：已修复并验证（构建 / 类型 / 79 项测试 / profile 装配 / 主机准入）。
> 剩余仅"真实 UI 冒烟"需要在下一次启动 dsh 时确认（本机当时没有在跑的 dsh 服务）。

## 1. 根因（唯一真正的破坏点）

0.1.7 起，Typert codec 贡献从 `schema:` 改为 `create: () => TypertSchema` 工厂
（上游 `feat(typert): materialize generated schemas on first use`）。
`dsh-typert-loader` 改为校验工厂：

```js
if (typeof codec.create !== 'function') throw new Error(`typert-loader: ${pkgName} ${subject} has no create() factory`)
```

本插件的 `lib/typert.host.js` / `lib/typert.remote-client.js` 是**生成物**，其形状由
`@deepseek-ai/dsh-typert-generator` + 被 vendored 的协议构建共同决定。协议仍停在
`0.1.0-rc.5` 时生成的是 `schema:`，于是：

1. loader 校验失败即抛错；
2. 该 fiber 的**全部** strict 注册被一并回滚（不止本插件的 4 个端点）；
3. 内置 `directoryPicker/list`、`agentPresets/list`、`pluginInventory/list` 开始报
   `its strict definition was withdrawn and SRC fallback is forbidden`；
4. 归档会话设置页只剩 SRC 回退报错。

## 2. 0.1.7-rc.1 的其他装配面变化

| 面 | 0.1.5 及以前 | 0.1.7-rc.1 | 处理 |
|---|---|---|---|
| 协议 codec | `schema:` | `create:` 工厂 | 协议包升到 `0.1.7-rc.1`，重建产物 |
| Client 基座 | `@deepseek-ai/dsh-client-runtime`、`dsh-client-web-react` | **已删除**；client 插件直接 type 到 Cordis `Context` | 改类型来源 + `inject` 列表 |
| Client 服务拥有者 | 运行时统一注入 | 由 `dsh-api-*` / `dsh-client-ui-*` 各自合并 `Context` | type-only 引入 5 个 `*/client` |
| Client baseline | 不固定 | 固定 = React 家族 + `cordis`、`client-store`、`ui-dockkit`、`ui-primitives`、`ui-slots` | 本插件只需 baseline，`dsh.client.external` 无需声明 |
| `RiskConfirmation` | `closeLabel` 必填 | 同 | 补 prop + 中英词条 |
| `SessionPersistence` | `listSnapshots()` / `readFrom()` | `list()` / `open(id,'read')` + handle；live session 用 `snapshotEvents()` | `typeof` 双路径探测（优先新面） |
| bundle 准入 | 无 | bundle 自身也要过 peer 检查，不匹配则整层 skip | peer 范围 `^0.1.7-rc.1` 匹配 `0.1.7-rc.1`，无需豁免 |

## 3. 遗留项（本轮不改，单独决策）

+ **永久删除仍不可用**：`SessionPersistence.delete` 在 `0.1.5-rc.1` 与 `0.1.7-rc.1`
  都不存在，整个区间没有新增；host 侧也没有 `deleteSession` 远程端点。因此 delete 能力
  恒为 `unsupported`（按钮禁用 + `delete-unsupported`）。这不是 0.1.7 引入的回归，而是
  需求与 harness API 的差异：要实现"永久删除"必须换用官方提供的其它端点或等待官方能力。
+ **cordis 编译面与运行时面不一致**：本仓 vendored `cordis 4.0.1 / cosmokit 1.8.2`，
  0.1.7-rc.1 官方 vendor 为 `4.0.4 / 1.8.5`。已核对 4.0.1→4.0.4 源码差异仅
  `Fiber.update` 返回值、logger exporter 计数、`internal/update` 事件签名收窄，均不在本插件
  使用面上；准入检查也显式跳过 `@deepseek-ai/cordis`。后续升 vendor 时可一并对齐。
+ **`dsh.client.inject` 的弱项**：`dsh-client-ui-renderer` 只被 type-only 引用，
  `dsh-client-ui-slots` 只在运行期通过 `ui-renderer` 的合并取到；两者仍留在 inject 里是为了
  保持装配顺序显式。若将来 profile 停用 renderer 行，需要重新评估。

## 4. 验证记录（本机 0.1.7-rc.1）

```text
npm run build      # clean → host → check:typert → client → check:typert   ✅
npm run typecheck  ✅
npm test           # 79 pass / 0 fail                                    ✅

产物：lib/typert.host.js create:=7 schema:=0
      lib/typert.remote-client.js create:=7 schema:=0
      lib/client.js require 仅 react / react/jsx-runtime / ui-primitives（全 baseline）

主机侧（直接用 dsh-app-boot 0.1.7-rc.1 的导出复算）：
  getDshRuntimeVersion() = 0.1.7-rc.1
  evaluatePluginCompatibility(插件 manifest) = undefined      → 准入 PASS
  prepareProfileEntries(真实 profileContext + archived-sessions 行) → 未被 disable
  loadProfile('web') = 7 层全部加载（含 dsh-plugin-archived-sessions）
  composeEntries = 182 行，archived-sessions 行存在且 enabled
```

尚未执行（需要真实启动 dsh web）：设置页"归档会话"区块的渲染与恢复/删除交互冒烟；
重启后 stderr 不再出现 `skipping profile bundle` 与 typert withdrawal 相关报错。

## 5. 白屏排查（2026-09-24 第二轮）

> 触发问题：更新本插件后 dsh 打开白屏。结论：**在干净复现中 dsh 完整启动，本插件不是白屏原因**；
> 无任何 boot 审计失败、无 typert withdrawal、无 client bundle 缺失。

### 复现与证据（随包 dsh 0.1.7-rc.1 + 全新浏览器 profile）

- 启动：`dsh-node.exe <app>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --patch <app>/config/windows-directory-picker.patch.yml --no-open --host 127.0.0.1 --port 51235`；
  8 次独立启动的 stdout 只有 ready 行，无 `skipping profile bundle` / `client bundle not found` / typert 报错。
- 页面（CDP，`.claude/probe.mjs`）：`#root` 33982 字符完整 UI、boot 图 68 条、`[data-dsh-boot]` 不存在、无未捕获异常、无 console error。
- Host 契约：用运行时自带 `dsh-typert-loader#validateTypertManifest` 校验 `lib/typert.*.js` → PASS，6 个 invocation（含 `details`），全部 schema 工厂可物化。
- 客户端产物：`lib/client.js` 仅 require 基线模块（react / react/jsx-runtime / ui-primitives），注册与 factory 物化均正常。
- 端到端功能：设置 → 归档会话 → 展开分组 → `POST /api/archivedSessions/details` 200，17 行标题折出（列表为头行 `loaded=false`，详情后 `loaded=true`，0 条空标题）。

### 本轮排除的环境性解释

- 无 service worker（shell bundle 中 `serviceWorker` 出现 0 次）；
- 桌面端不使用 `dshDesktopBoot` / `__DSH_BOOT_READY__` 注入路径（app `src/`、`assets/` 中不存在），即与浏览器同一条 boot 路径；
- 应用 Chromium 的 Local Storage 仅含普通 UI 状态；
- 页面打开期间改动 `lib/client.js` 的 rev（触发 HMR reload）后，页面仍完整存活。

### 白屏唯一已知机制（复发时按此抓取）

客户端 boot 审计是全有全无的：`@deepseek-ai/dsh-web-frontend` 的 `run()` → `tE()`（`loader.entries.start` → `await loader.await()` → `nE()`）——
任一 loader 入口不是 active 就 `throw new Error("web boot: N entries did not activate
<id>: pending (waiting for service: …) | import failed | failed")`，
`run()` 的 catch 只渲染 boot 卡片，整个应用不挂载（表现为白屏）。抓取方式：
`chrome --remote-debugging-port=9222` 后 `node .claude/probe.mjs "<带 token 的 URL>" "http://127.0.0.1:9222"`，看 console error 里的 `web boot:` 行。
同一 boot 中的任一 client 条目（本插件或同 profile 的其它 5 个本地插件）都会触发同一结果。

### 本轮代码改动

- `scripts/check-typert-contract.mjs`：`REQUIRED_ENDPOINTS` 增加 `details`（此前新端点无任何构建期校验）；`npm run build` / `typecheck` / `npm test`（118 pass）通过。

### 仍遗留（未改，待决策）

- **`zod` 未声明为运行时依赖**：`lib/typert.host.js` 与 `lib/typert.remote-client.js` 均 `import { z } from 'zod'`，而 `zod` 只在 `devDependencies`。本机靠 pnpm workspace link 可解析；任何裁掉 devDeps 的安装会让 `./typert` import 失败，
  从而触发第 1 节的整 fiber strict 回滚机制。修复为一行（`dependencies: { "zod": "^4.4.3" }`）。
- **`details` 冷读较慢**：17 条归档会话日志一次折价实测 `time_total≈17.5s`（约 1s/条），期间 UI 显示骨架条（设计内中间态）。
  如需改善可调 `DETAILS_BATCH_SIZE`（64）与首屏可见行数，或把折价改为逐条流式回报；本轮未改以免扩大范围。
