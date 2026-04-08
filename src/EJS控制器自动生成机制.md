# Evolution World — EJS 控制器自动生成机制详解

> 本文档面向**开发者和高级配置者**，详细说明 EW 插件如何从 AI 返回的 JSON 自动生成 EJS 控制器条目，以及控制器在运行时如何工作。

---

## 一、控制器是什么？为什么需要它？

在 SillyTavern 中，世界书条目有两种激活方式：

1. **关键词触发**（默认）——ST 扫描聊天内容，匹配到关键词就激活
2. **EJS 脚本激活**——在条目内容中写 EJS 代码，通过 `getwi()` 主动拉取其他条目

EW 选择了第二种方式。工作流写入的 `EW/Dyn/` 条目**始终禁用**（红灯），不参与 ST 关键词扫描。取而代之的是，EW 为每个工作流生成一个 `EW/Controller/` 条目（绿灯），由它在运行时决定加载哪些 `EW/Dyn/` 条目到 AI 上下文。

```
┌──────────────────────────────────────────────────────┐
│  EW/Controller/角色更新       ← 蓝灯，ST 自动渲染    │
│  ┌──────────────────────────────────────────────────┐ │
│  │ <%- await getwi(null, 'EW/Dyn/小雪') %>         │ │
│  │ <%- await getwi(null, 'EW/Dyn/主时间线') %>      │ │
│  └──────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│  EW/Dyn/小雪                  ← 红灯，不主动激活     │
│  EW/Dyn/主时间线              ← 红灯，不主动激活     │
│  EW/Dyn/过期NPC               ← 红灯，不被加载 = 不可见│
└──────────────────────────────────────────────────────┘
```

这种设计的好处：

- **精确控制**：只有 AI 认为应该加载的条目才会出现在上下文中
- **零冗余**：不需要为每个条目手动配关键词
- **动态适应**：每次工作流执行都会更新控制器，反映最新状态

---

## 二、完整生命周期

```
用户发消息
     │
     ▼
EW 拦截生成事件
     │
     ▼
执行工作流 → AI 返回 JSON
     │         ├── operations.worldbook.desired_entries  (要写入的条目)
     │         └── operations.controller_model            (控制器模型)
     ▼
merger.ts 合并多个工作流结果
     │  ├── 按优先级解决条目名冲突
     │  ├── 为每个工作流分配 EW/Controller/{流名} 条目名
     │  └── 给 fallback_entries 等条目名自动加 EW/Dyn/ 前缀
     ▼
controller-renderer.ts 将 ControllerModel → EJS 代码
     │
     ▼
transaction.ts 原子提交到世界书
     │  ├── 备份旧 Controller 内容
     │  ├── 写入 EW/Dyn/ 条目（红灯）
     │  ├── 写入 EW/Controller/ 条目（绿灯）
     │  └── 标记楼层快照（用于回滚）
     ▼
ST 渲染上下文时执行 EJS
     │  └── getwi() 拉取指定的 EW/Dyn/ 条目内容
     ▼
AI 收到包含动态条目的上下文
```

---

## 三、ControllerModel 完整字段说明

AI 在 JSON 中返回的 `operations.controller_model` 对象遵循以下 schema：

### 必填

| 字段 | 类型 | 说明 |
|---|---|---|
| `template_id` | `"entry_selector_v1"` | 固定值，当前唯一模板 |
| `fallback_entries` | `string[]` | 默认加载的条目名列表（裸名即可） |

### 条件加载

| 字段 | 类型 | 说明 |
|---|---|---|
| `variables` | `Array<{name, path, default}>` | 从酒馆变量读取值供 rules 使用 |
| `rules` | `Array<{when, include_entries}>` | 条件分支——`when` 为 JS 表达式 |

### 角色检测

| 字段 | 类型 | 说明 |
|---|---|---|
| `char_detection.alias_map` | `Record<别名, 正式名>` | 别名到正式名的映射 |
| `char_detection.scene_var` | `string?` | 酒馆变量路径，值为对象（键=角色名） |
| `char_detection.scan_messages` | `number` | 扫描最近 N 轮消息，默认 1 |
| `char_detection.entry_patterns` | `string[]` | 实际加载的条目模式，`{name}` 替换为角色名 |

### 通用循环

| 字段 | 类型 | 说明 |
|---|---|---|
| `for_each[].list_var` | `string` | 酒馆变量路径（值为数组） |
| `for_each[].entry_prefix` | `string` | 条目名前缀 |
| `for_each[].entry_suffix` | `string` | 条目名后缀 |

### 进阶

| 字段 | 类型 | 说明 |
|---|---|---|
| `decorators` | `string[]` | 顶部装饰器（如 `@@preprocessing`） |
| `skip_floor_zero` | `boolean` | 第一条消息时跳过控制器 |
| `set_variables` | `Array<{key, value, scope}>` | 设置酒馆变量 |
| `activate_entries` | `Array<{entry, world?}>` | 激活非 EW 管理的世界书条目 |
| `inject_text` | `string[]` | 直接注入纯文本到上下文 |

---

## 四、生成的 EJS 代码结构

`controller-renderer.ts` 按以下顺序拼接 EJS 模板：

```
1. decorators       — @@preprocessing 等装饰器
2. scriptlet        — getvar() 变量声明 + setvar() 赋值
3. inject_text      — 纯文本注入
4. activate_entries  — activewi() 调用（激活外部条目）
5. char_detection   — 角色名检测 + 动态 getwi() 循环
6. for_each         — 列表变量循环 + getwi()
7. rules/fallback   — 条件分支 或 无条件 getwi()
```

如果 `skip_floor_zero` 为 true，第 3~7 部分会被包裹在 `if (!_ewIsFloorZero) { ... }` 中。

### 示例：最简 fallback_entries

AI 返回：
```json
{
  "template_id": "entry_selector_v1",
  "fallback_entries": ["小雪", "主时间线"]
}
```

生成的 EJS：
```ejs
<%- await getwi(null, 'EW/Dyn/小雪') %>
<%- await getwi(null, 'EW/Dyn/主时间线') %>
```

### 示例：条件分支

AI 返回：
```json
{
  "template_id": "entry_selector_v1",
  "variables": [
    { "name": "phase", "path": "story_phase", "default": "early" }
  ],
  "rules": [
    { "when": "phase === 'late'", "include_entries": ["终章时间线"] }
  ],
  "fallback_entries": ["主时间线"]
}
```

生成的 EJS：
```ejs
<%_
if (typeof phase === 'undefined') var phase = getvar('story_phase', { defaults: "early" });
_%>

<%_ if (phase === 'late') { _%>
<%- await getwi(null, 'EW/Dyn/终章时间线') %>
<%_ } else { _%>
<%- await getwi(null, 'EW/Dyn/主时间线') %>
<%_ } _%>
```

### 示例：角色检测

AI 返回：
```json
{
  "template_id": "entry_selector_v1",
  "char_detection": {
    "alias_map": { "殷冬雪": "殷冬雪", "冬雪": "殷冬雪", "卫疏影": "卫疏影" },
    "scene_var": "stat_data.在场人物",
    "scan_messages": 1,
    "entry_patterns": ["{name}", "{name}_记忆"]
  },
  "fallback_entries": ["主时间线"]
}
```

生成的 EJS（简化展示）：
```ejs
<%
// === EW 角色检测 ===
var _ewDetected = new Set();
var _ewAliasMap = {"殷冬雪":"殷冬雪","冬雪":"殷冬雪","卫疏影":"卫疏影"};
var _ewScene = getvar('stat_data.在场人物', { defaults: {} });
if (_ewScene && typeof _ewScene === 'object') {
  for (var _k of Object.keys(_ewScene)) {
    _ewDetected.add(_ewAliasMap[_k] || _k);
  }
}
var _ewUserMsgs = getChatMessages(-1, -1, 'user');
var _ewUserText = _ewUserMsgs.length > 0 ? String(_ewUserMsgs[_ewUserMsgs.length - 1] || '') : '';
var _ewCharMsgs = getChatMessages(-1, -1, 'assistant');
var _ewCharText = _ewCharMsgs.length > 0 ? String(_ewCharMsgs[_ewCharMsgs.length - 1] || '') : '';
var _ewScanText = _ewUserText + '\n' + _ewCharText;
for (var _alias of Object.keys(_ewAliasMap)) {
  if (_ewScanText.includes(_alias)) _ewDetected.add(_ewAliasMap[_alias]);
}
var _ewChars = Array.from(_ewDetected);
%>

<% for (const _ewName of _ewChars) { %>
<%- await getwi(null, 'EW/Dyn/' + _ewName) %>
<%- await getwi(null, 'EW/Dyn/' + _ewName + '_记忆') %>
<% } %>
<%- await getwi(null, 'EW/Dyn/主时间线') %>
```

---

## 五、多工作流控制器

每个工作流生成独立的控制器条目：

- 工作流 "角色更新" → `EW/Controller/角色更新`
- 工作流 "增强记忆" → `EW/Controller/增强记忆`

合并规则：
- **条目名冲突**（`desired_entries`）：高优先级覆盖低优先级
- **删除 vs 写入冲突**：`remove_entries` 优先级 ≥ `desired_entries` 时删除生效
- **控制器无冲突**：每个工作流对应自己的 `EW/Controller/` 条目，互不干扰

---

## 六、安全机制

| 机制 | 说明 |
|---|---|
| **EJS 语法校验** | 生成后调用 `validateEjsTemplate()` 校验，语法错误会报错 |
| **条目名白名单** | 只允许操作 `EW/Dyn/` 和 `EW/Controller/` 前缀的条目 |
| **控制器备份** | 每次提交前备份旧 Controller 内容（最多 10 条 LRU） |
| **Dyn 强制红灯** | `EW/Dyn/` 条目始终 `enabled=false`，不会被关键词扫描意外激活 |
| **楼层快照** | 开启楼层绑定后，每层记录完整快照用于回滚 |
| **原子提交** | 所有条目变更在一次 `replaceWorldbook()` 调用中完成 |

---

## 七、对工作流提示词编写者的影响

作为工作流配置者，你**不需要**理解 EJS 语法。你只需要：

1. 在提示词中告诉 AI 输出 `controller_model.fallback_entries`，列出要加载的条目名
2. 如果需要条件加载，使用 `variables` + `rules`
3. 如果需要角色检测，使用 `char_detection`

**插件会自动：**
- 给条目名加 `EW/Dyn/` 前缀
- 生成 EJS 代码
- 校验语法
- 写入世界书
- 在 ST 渲染时执行

你写的 JSON 只是声明"我想加载哪些条目"，EJS 代码生成完全由插件透明处理。
