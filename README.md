# ST-Evolution-World-Assistant

SillyTavern 第三方扩展版的 Evolution World Assistant。

## 当前能力

- 单角色聊天场景下的工作流调度
- `before_reply` 主拦截链路和事件回退链路
- `after_reply` 工作流、当前楼重跑、控制器回滚
- 角色卡工作流读写
- 世界书写入、控制器编译、楼层绑定和快照恢复
- 插件面板、魔法棒菜单入口、FAB 悬浮球入口

## 当前明确限制

- 当前只支持单角色聊天
- 当前不支持 `group chat`

进入群聊时，Assistant 会显式提示当前上下文不受支持，并阻止会写入世界书的流程继续执行。

## 运行时行为

### before_reply

- 首选走 manifest `generate_interceptor` 主拦截链路
- 如果宿主未命中主拦截器，但仍发出后续生成事件，则由 `GENERATION_AFTER_COMMANDS` 回退链路接管
- 主链路与回退链路都会带去重守卫，避免同一轮生成重复执行

### after_reply

- 在最新 assistant 回复后执行
- 支持当前楼工作流重跑
- 支持控制器回滚

### 设置命名空间

- Assistant 只写 `evolution_world_assistant`
- 如果检测到旧的 `evolution_world` 设置桶且新桶不存在，会在首次启动时迁移
- 迁移后不再回写旧桶，避免和旧 EW 仓库互相覆盖

## UI 入口

- 扩展面板
- 扩展菜单中的魔法棒入口
- 可开关的 FAB 悬浮球入口

FAB 开关支持运行中即时关闭和重新开启，无需刷新页面。

## 开发

```bash
npm install
npm run build
```

构建产物输出到 `dist/`。
