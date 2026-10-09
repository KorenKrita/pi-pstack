# Step 2 independent review

Reviewer: `local-responses/gpt-6-astra` (xhigh), no session context, on commit `8aaae3d`.
Fixed in the commit that adds this file. Per the project rule, the fixes are not re-reviewed.

## Disposition

| # | Severity | Finding | Valid | Fix | Regression |
|---|---|---|---|---|---|
| 1 | major | State changes mid-run do not reach the prompt | yes | `context_with_system` handler re-syncs the pstack sections on every model request | `same-run requests reflect read activation and off without another before_agent_start` |
| 2 | major | Budget not applied by `pstack_config write` | yes | `runConfigTool` maps roles through `applyBudget` before validation; unmappable entries refuse the write | `write maps the chosen budget…`, `write refuses unmappable budget entries…` |
| 3 | major | Task gate and rule loader parse frontmatter differently | yes | both use the strict YAML `parseAlwaysApplyRule` | `Task gate and rule loader agree on malformed, duplicate and commented YAML`, `frontmatter uses rule loader semantics…` |
| 4 | major | Stale ownership lets `/pstack off` disable another extension's tool | yes | ownership is recomputed from `getAllTools()` `sourceInfo.path` at each apply | `late tool takeover is not disabled by /pstack off and is reported` |
| 5 | major | arena/swarm/interrogate hard-code `~/.pi/pstack/rules` | yes | rules rewrite those reads to `pstack_config` `read` | `arena, swarm, interrogate read config through pstack_config…` |
| 6 | minor | Repeated `/pstack on`/`off` does not re-apply tools | yes | `setState` skips only the duplicate entry, always re-applies tools | `repeated /pstack on re-applies the tool set even when state is unchanged` |
| 7 | minor | Budget mapping drops a valid `off` | yes | explicit `:off` kept; `off` counts as a level at or below the target | `explicit :off on a reasoning model is kept…`, updated `no supported level…` |
| 8 | minor | realpath match does not check containment | yes | own SKILL.md realpaths must lie under the skills root and be named `SKILL.md` | `an own SKILL.md symlinked to a file outside the package does not count as own` |
| 9 | minor | `/how` forwarding has no real-Pi regression | yes | new real-Pi RPC smoke compares `/how ARGS` with `/skill:how ARGS` user messages | `tests/smoke/step2-forward.sh` (queued path is unit-tested only) |
| 10 | minor | Smoke assertions not bound to phase / error kind | yes | tool set checked at the `/skill:how` Task call; unknown-model check correlates `toolCallId` and asserts `Unknown model`, `Available models`, not the setup error | `tests/smoke/step2.sh` |

Verification after fixes: `bun test` 102 pass; `bunx tsc --noEmit`; `bun run check` 0 findings; `bun run sync` no drift; `tests/smoke/step2.sh` 9/9 and `tests/smoke/step2-forward.sh` 2/2 against real Pi 1.1.0 (`local-openai/glm-5.3-flash`).

## Reviewer findings (verbatim)

**发现 10 项问题：5 major、5 minor，无 blocker。建议修正 major 项后再进入 Step 3。** 以下路径相对 `/Users/korenkrita/Coding/pi-pstack`。

1. **major — `extensions/pstack/index.ts:282–285`：运行中的状态变化不会及时更新提示词。**  
   Pi 1.1.0 不会在连续工具调用之间重新触发 `before_agent_start`。真实 SDK 复现：`read SKILL.md` 激活后，下一次请求已有工具却没有 adapter note；运行中 `/pstack off` 后，下一次请求仍包含 poteto reminder 和自治授权。  
   **修复：**在后续模型请求边界同步或删除本插件的 sections，保留首次 `before_agent_start` 注入；增加连续请求中的激活、关闭回归测试。

2. **major — `extensions/pstack/index.ts:459–461`：预算转换没有接入真实配置流程。**  
   `applyBudget` 只有测试调用，`write` 直接序列化原始 roles。以内存替代文件 I/O 调用真实 `runConfigTool`，`budget: "small"` 配合 `p/m:max` 返回 `Validation: ok`，序列化结果仍为 `p/m:max`。首次 setup 也先对空表应用预算，再让用户选模型，没有明确再次映射。  
   **修复：**把预算映射接入实际 setup／配置写入流程，确认前展示最终映射表；未解决的 `needsChoice` 阻止写入。测试最终序列化值，而不仅测试 helper。

3. **major — `extensions/pstack/config.ts:237–242`：配置门禁与规则加载使用不同的 frontmatter 语义。**  
   已复现：非法 YAML、重复 `alwaysApply` 均可通过 Task 配置门禁，却被规则加载器跳过；反过来，合法的 `alwaysApply: true # enabled` 可以注入，却被门禁拒绝。  
   **修复：**共用严格 YAML/frontmatter 解析，要求 mapping 且 `alwaysApply === true`，将解析错误纳入 validation report；测试两条入口对同一文件的一致性。

4. **major — `extensions/pstack/index.ts:154–158,185–195`：工具所有权记录会过期，`/off` 能停用其他扩展的工具。**  
   `ownedTools` 只记录“曾注册过的名称”。真实 SDK 复现：加载顺序靠前的扩展稍后注册 `Task`，Pi 的有效实现变为该扩展；pstack 仍认为自己拥有这个名字，执行 `/pstack off` 会移除别人的 `Task`。  
   **修复：**切换工具前用 `getAllTools()` 的 source metadata 核对当前所有者；发生归属变化时报告 collision，不再增删该名称。补动态注册场景测试。

5. **major — `scripts/rules.ts:20–21,164–168`：`PSTACK_HOME` 尚未贯穿所有生成指令。**  
   新规则只修正了 setup 文本；`arena`、`swarm`、`interrogate` 仍要求读取 `~/.pi/pstack/rules/pstack-models.mdc`。设置覆盖路径后，skill 指令与 runtime 使用不同文件，可能读取旧配置或误走默认值。  
   **修复：**统一配置读取指令到 `pstack_config read`，或统一为明确支持默认值的环境路径；通过 `scripts/rules.ts` 和 `sync` 生成，不手改 skills。

6. **minor — `extensions/pstack/index.ts:162–166`：重复 `/on`、`/off` 不会重新协调工具集合。**  
   状态相同就直接返回。已复现：off 状态下通过另一工具管理器启用自有 `AskQuestion`，再执行 `/pstack off`，它仍保持启用；on 状态下缺失的自有工具也不会恢复。  
   **修复：**仅跳过重复的状态持久化，仍执行经过所有权核验的 `applyTools()`。

7. **minor — `extensions/pstack/config.ts:186–191`：预算映射错误地排除了合法的 `off`。**  
   对支持 `off` 的 reasoning model，`applyBudgetToValue("p/m:off", "unlimited", …)` 返回需要重新选择，违反保留已有 level 的要求；`off` 作为最高受支持且不超过目标的档位也被忽略。  
   **修复：**在完整支持档位中选择，保留显式 `:off`，并修正当前把此行为当作预期的测试。

8. **minor — `extensions/pstack/index.ts:133–137`：realpath 相等检查没有验证目标仍在包内。**  
   如果包内 `SKILL.md` 是指向外包文件的 symlink，外部目标也会进入 `ownSkillFiles`；直接读取那个外部文件便能激活 pstack，不满足 R1 的真实路径归属限制。  
   **修复：**规范化 skills 根目录后检查目标 realpath 的包含关系及 `SKILL.md` 文件名；保留整个包目录 symlink 的支持，补指向包外文件的反例。

9. **minor — `tests/extension.test.ts:264–268`：skill 展开测试没有证明真实 Pi 展开行为。**  
   测试只检查 fake `sendUserMessage` 收到字符串；smoke 又直接调用 `/skill:how`，因此没有覆盖 R2 明确要求的 `/how` 转发契约。此次 SDK 检查确认当前非排队路径确实等价，但仓库没有回归保护。  
   **修复：**使用真实 Pi 会话比较两种入口产生的 skill block 和参数，覆盖非空参数及排队路径。

10. **minor — `tests/smoke/step2.sh:54–70`：部分 JSON 断言未锁定阶段或错误类型。**  
    “after `/skill:how`”只检查最终工具集合；unknown-model 检查只要求错误包含两个字符串，配置门禁错误包含这些字符串时也能通过。现有 transcript 正确，不代表这些断言能阻止相关回归。  
    **修复：**按 user prompt／请求边界检查工具集合，关联 `toolCallId` 与参数；明确断言 `Unknown model`、`Available models`，并排除配置门禁错误。

**验证结果**
- `bun run sync && git status --porcelain`：通过，0 写入，工作区干净。
- `bun run check`：通过，0 findings。
- `bun test`：**92 pass，0 fail**。
- `bunx tsc --noEmit`：通过。
- 未重跑 smoke；核验了现有 `tests/smoke/out/20261009-135455/session.jsonl`：依次记录 Task setup error、成功 config write、Task unknown-model error。真实交互 UI 未验证。
- 未修改仓库文件；额外 SDK 验证使用内存状态。

**下一步：优先修复第 1–5 项，并把上述复现加入回归测试。**