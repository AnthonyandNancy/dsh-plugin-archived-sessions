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
