export type TabKey = 'overview' | 'api' | 'global' | 'flows' | 'debug' | 'history';

export type TabMeta = {
  key: TabKey;
  label: string;
};

export type FieldHelpMeta = {
  key: string;
  label: string;
  shortHelp: string;
  detailHelp: string;
  placeholder?: string;
  isAdvanced?: boolean;
};

export const PANEL_TABS: TabMeta[] = [
  { key: 'overview', label: '总览' },
  { key: 'api', label: 'API配置' },
  { key: 'global', label: '全局配置' },
  { key: 'flows', label: '工作流配置' },
  { key: 'history', label: '历史' },
  { key: 'debug', label: '调试' },
];

const FIELD_HELP_LIST: FieldHelpMeta[] = [
  {
    key: 'enabled',
    label: '总开关',
    shortHelp: '关闭后不拦截发送，不执行动态世界工作流。',
    detailHelp: '建议先在单聊天内开启验证。出现异常可先关闭总开关快速回退。',
  },
  {
    key: 'dispatch_mode',
    label: '调度模式',
    shortHelp: '并行会同时请求所有工作流，串行会按顺序执行。',
    detailHelp: '串行模式下后续工作流可读取前序结果；并行模式更快，但冲突由优先级和顺序合并。',
  },
  {
    key: 'workflow_chat_context_mode',
    label: '工作流聊天上下文',
    shortHelp: '决定工作流聊天记录优先读取宿主加工结果，还是直接读取原始聊天。',
    detailHelp:
      '“兼容宿主处理”会优先沿用酒馆当前 getChatMessages 结果，但一旦检测到聊天压缩包装，会自动回退到原始 ctx.chat；“原始聊天优先”则默认直接读取原始聊天，更适合和压缩相邻消息等脚本共存。',
  },
  {
    key: 'after_reply_delay_seconds',
    label: '回复后延迟',
    shortHelp: 'AI 回复完成后，等待多少秒再开始这一轮 EW 工作流。',
    detailHelp: '仅对“回复后更新”链路生效。可用于降低 3 条工作流同时打满接口时的瞬时压力，支持小数秒。',
    placeholder: '0',
    isAdvanced: true,
  },
  {
    key: 'strip_workflow_image_blocks',
    label: '屏蔽图片块',
    shortHelp: '发送聊天历史到工作流 AI 前，自动剥离文生图插件插入的 <image>…</image> 块。',
    detailHelp:
      '仅影响发给工作流 AI 的上下文副本，不会修改酒馆里的原始消息显示。建议保持开启；若你的工作流确实需要读取这类图片块原文，再关闭。',
    isAdvanced: true,
  },
  {
    key: 'auto_reroll_max_attempts',
    label: '自动重roll次数',
    shortHelp: '工作流失败后，最多再自动重roll多少次。',
    detailHelp:
      '仅在失败策略选择“自动重roll”时生效，表示首次失败后还会额外补跑多少次。设为 1 等价于旧版“失败重试一次”；设为 3 则最多会尝试 1 次首跑 + 3 次自动重roll。',
    placeholder: '1',
    isAdvanced: true,
  },
  {
    key: 'auto_reroll_interval_seconds',
    label: '自动重roll间隔',
    shortHelp: '两次自动重roll之间额外等待多少秒。',
    detailHelp:
      '仅在失败策略选择“自动重roll”时生效。设为 0 表示失败后立即重roll；设为 5 则每次失败后等待 5 秒再进行下一次自动重roll，用于给模型或网关一点缓冲时间。',
    placeholder: '0',
    isAdvanced: true,
  },
  {
    key: 'parallel_dispatch_interval_seconds',
    label: '并行错峰间隔',
    shortHelp: '并行模式下，同一批次里的第 2、3... 条工作流要不要故意晚几秒再发。',
    detailHelp:
      '这不是自动重roll，也不是重复执行，而是同一轮里多条工作流的错峰发出间隔。0 表示真正同时发出；例如设为 1，则第 1 条立即发、第 2 条 1 秒后发、第 3 条 2 秒后发。默认建议保持 0，只有接口需要削峰时再调大。',
    placeholder: '0',
    isAdvanced: true,
  },
  {
    key: 'serial_dispatch_interval_seconds',
    label: '串行发出间隔',
    shortHelp: '串行模式下，每条工作流完成后到下一条发出前再额外等待多少秒。',
    detailHelp: '适合严格限速的接口。该间隔只加在串行相邻两条之间，首条仍按“回复后延迟”或立即执行。',
    placeholder: '0',
    isAdvanced: true,
  },
  {
    key: 'total_timeout_ms',
    label: '总超时',
    shortHelp: '整轮工作流的最大耗时上限（毫秒）。',
    detailHelp: '超过该时间视为失败并中止本轮发送。建议不小于所有启用工作流超时的最大值。',
  },
  {
    key: 'gate_ttl_ms',
    label: '门控时效',
    shortHelp: '发送链路去重与防重入的有效期（毫秒）。',
    detailHelp: '用于防止快速连点或重复事件触发同一轮工作流，设置过短可能导致重复执行。',
  },
  {
    key: 'dynamic_entry_prefix',
    label: '动态条目前缀',
    shortHelp: '动态条目写入时使用的命名前缀。',
    detailHelp: '外部返回的 upsert/toggle/delete 条目通常应落在该前缀下，便于识别与清理。',
    placeholder: 'EW/Dyn/',
  },
  {
    key: 'controller_entry_prefix',
    label: '控制器条目前缀',
    shortHelp: '控制器 EJS 条目的命名前缀，每个工作流会生成前缀+工作流名称的条目。',
    detailHelp:
      '例如前缀为"EW/Controller/"时，名为"环境检测"的工作流会写入"EW/Controller/环境检测"条目。多个工作流各自独立，互不覆盖。',
    placeholder: 'EW/Controller/',
  },
  {
    key: 'floor_binding_enabled',
    label: '楼层绑定',
    shortHelp: '开启后，工作流写入的条目会与当前聊天楼层绑定。',
    detailHelp: '删除楼层时，该楼层绑定的 EW/Dyn/ 条目将被自动清理，实现“删楼层 = 回滚修改”。',
  },
  {
    key: 'auto_cleanup_orphans',
    label: '自动清理孤儿条目',
    shortHelp: '切换聊天时自动检测并清理无主的 EW/Dyn/ 条目。',
    detailHelp: '开启后，在 CHAT_CHANGED 事件触发时会扫描世界书，移除不再与任何楼层关联的孤儿条目。',
  },
  {
    key: 'snapshot_storage',
    label: '快照存储方式',
    shortHelp: '控制楼层工件保存在消息 data 字段里，还是外置到服务器文件里。',
    detailHelp:
      '文件模式会把楼层快照、执行记录和重推导胶囊外置到服务器文件，消息本体只保留轻量引用与摘要；更适合长聊天和大量工作流。消息数据模式更直观，排查时更容易直接在消息数据里看到完整内容。切换后可点击“同步快照”迁移当前聊天已有数据。',
  },
  {
    key: 'hide_settings.affect_workflow_context',
    label: '隐藏限制工作流上下文',
    shortHelp: '控制“保留最新 N 条”是否同时限制工作流读取到的聊天楼层。',
    detailHelp:
      '关闭时，隐藏只作用于主回复 AI，不限制工作流的上下文楼层数；例如工作流配置 8 层、隐藏设置 4 层时，工作流仍可读取 8 层。开启后，工作流会和主回复一样，只能读取未隐藏的最近楼层。',
  },
  {
    key: 'failure_policy',
    label: '失败策略',
    shortHelp: '工作流失败时的处理方式。',
    detailHelp:
      '失败即中止：停止 AI 生成并提示错误。静默继续：显示警告但 AI 照常生成。自动重roll：按配置的次数与间隔自动补跑，仍失败则中止。仅通知：仅弹出提示，不影响生成。',
    isAdvanced: true,
  },
  {
    key: 'workflow_timing',
    label: '执行时机',
    shortHelp: '选择在 AI 回复前执行工作流，还是在 AI 回复后再更新动态世界。',
    detailHelp:
      '回复后更新：默认模式，先让主回复返回，再根据最新 assistant 消息执行 EW 工作流，不阻塞对话。回复前拦截：沿用旧链路，在发给 AI 前先执行工作流，并结合原消息放行策略决定是否继续发送原始用户消息。',
    isAdvanced: true,
  },
  {
    key: 'reroll_scope',
    label: '重roll范围',
    shortHelp: '控制重roll按钮是重跑当前楼全部、当前楼失败部分，还是批量重跑当前聊天里所有失败楼层。',
    detailHelp:
      '全部工作流：从头重跑当前楼关联的全部工作流，结果最完整也最稳。仅失败工作流：保留当前楼上次成功的结果，只重试失败部分；如果该楼没有失败记录，按钮会直接提示无需重跑。失败队列：批量扫描当前聊天里所有仍记录为失败的回复后楼层，并依次只重试它们失败的部分，适合长队列跑完后统一补救。',
    isAdvanced: true,
  },
  {
    key: 'intercept_release_policy',
    label: '原消息放行策略',
    shortHelp: '被 EW 拦截的原始用户消息，在工作流结束后是否自动继续发送。',
    detailHelp:
      '仅成功时放行：默认选项，只有工作流成功后才继续把原始用户消息发给 AI。始终放行：无论工作流成功或失败，都继续发送原消息。永不自动放行：EW 完成处理后不自动发送，保留给你手动决定。',
    isAdvanced: true,
  },
  {
    key: 'api_preset.name',
    label: 'API配置名称',
    shortHelp: '用于在工作流里识别和选择该 API 配置。',
    detailHelp: '建议按用途命名，例如“剧情抽取API”“关系更新API”。',
  },
  {
    key: 'api_preset.mode',
    label: 'API模式',
    shortHelp: '选择“自定义API”或“酒馆连接器”模式。',
    detailHelp:
      '自定义API模式需要你填写 URL/Key/模型；酒馆连接器模式会直接使用酒馆当前主API与当前模型，不需要额外配置。',
  },
  {
    key: 'api_preset.api_url',
    label: 'API URL',
    shortHelp: '自定义API模式下使用的接口地址。',
    detailHelp: '填写你的自定义 API 基础地址后，可点击“加载模型列表”获取可用模型。',
    placeholder: 'https://example.com/flow',
  },
  {
    key: 'api_preset.api_key',
    label: 'API Key',
    shortHelp: '可选鉴权字段，会放入 Authorization 请求头。',
    detailHelp: '仅在你的服务端要求时填写。前端以密码框显示，但仍建议使用受限密钥。',
  },
  {
    key: 'api_preset.model',
    label: '模型',
    shortHelp: '自定义API模式下，指定要调用的模型名称。',
    detailHelp: '可手动输入，也可先填 URL/Key 后点击“加载模型列表”自动选择。',
    placeholder: 'gpt-4o-mini',
  },
  {
    key: 'api_preset.headers_json',
    label: '额外请求头',
    shortHelp: '可附加自定义 HTTP 头（JSON 对象）。',
    detailHelp: '用于网关鉴权或路由标识。格式错误会在调度前被视为配置异常。',
    placeholder: '{"X-Token":"value"}',
  },
  {
    key: 'flow.enabled',
    label: '工作流开关',
    shortHelp: '仅启用的工作流会参与调度。',
    detailHelp: '关闭后该工作流配置会保留，但不会请求外部 API，也不会参与合并。',
  },
  {
    key: 'flow.name',
    label: '名称',
    shortHelp: '仅用于你在界面里识别这条工作流。',
    detailHelp: '建议使用有语义的名称，例如“剧情抽取”“关系更新”。',
  },
  {
    key: 'flow.id',
    label: '工作流ID',
    shortHelp: '请求体中的 flow.id，需在当前工作流配置中唯一。',
    detailHelp: '返回体会带 flow_id 与其对应。重复 ID 会导致调试与合并定位困难。',
  },
  {
    key: 'flow.api_preset_id',
    label: 'API配置预设',
    shortHelp: '选择该工作流要使用的 API 配置预设。',
    detailHelp: '工作流只负责业务参数，接口地址/鉴权/请求头统一从预设读取。',
  },
  {
    key: 'flow.priority',
    label: '优先级',
    shortHelp: '用于多工作流结果合并冲突决策。',
    detailHelp: '按优先级降序合并；同优先级按工作流顺序后者覆盖前者。',
  },
  {
    key: 'flow.run_every_n_floors',
    label: '自动执行楼层间隔',
    shortHelp: '控制该工作流每隔多少个对应楼层自动执行一次，1 表示每个对应楼层都执行。',
    detailHelp:
      '只对自动触发生效，手动运行、重roll、历史重推导都不会参与这个间隔判断。回复后更新时按 AI 回复楼计数；回复前拦截时按用户楼计数。例如设为 3，则只会在第 3、6、9 个对应楼层自动执行。',
  },
  {
    key: 'flow.timeout_ms',
    label: '超时',
    shortHelp: '单条工作流请求最大耗时（毫秒）。',
    detailHelp: '超时会导致该工作流失败。失败策略固定为中止发送，因此请设置合理值。',
  },
  {
    key: 'flow.context_turns',
    label: '上下文楼层数',
    shortHelp: '发送给该工作流的历史消息楼层数量。',
    detailHelp: '数值越大上下文更完整，但 payload 也更大。建议按模型上下文成本调优。',
  },
  {
    key: 'flow.dyn_write.mode',
    label: 'Dyn 写入模式',
    shortHelp: '决定这次返回的内容是整段替换，还是按列表追加/对齐。',
    detailHelp:
      '覆盖：直接用这次结果替换旧内容。只增：只把新列表项追加进去，不删旧项。增减：把这次返回的列表当成目标状态，多的删掉，缺的补上。',
  },
  {
    key: 'flow.dyn_write.activation_mode',
    label: 'Dyn 激活模式',
    shortHelp: '决定 Dyn 是只存着给 Controller 用，还是自己直接生效。',
    detailHelp:
      '控制器仓库：条目保持红灯，只当数据仓库，真正注入仍走 Controller。直接世界书激活：条目会直接启用，并按下面的关键词、位置、概率等规则参与酒馆世界书匹配。',
  },
  {
    key: 'flow.dyn_write.profile.comment',
    label: 'Dyn 注释',
    shortHelp: '给自己看的备注说明。',
    detailHelp: '这部分主要用于标记条目用途、来源工作流或人工备注，方便你以后排查，不影响正文内容本身。',
  },
  {
    key: 'flow.dyn_write.profile.strategy.type',
    label: '策略类型',
    shortHelp: '条目用什么触发方式参与世界书。',
    detailHelp: '这里填写酒馆世界书识别的策略代码。最常见的是 `constant`，表示常驻；其它值按你当前酒馆支持的规则填写。',
  },
  {
    key: 'flow.dyn_write.profile.strategy.scan_depth',
    label: '扫描深度',
    shortHelp: '控制这个条目扫描多深，或是否跟随全局。',
    detailHelp: '最常用的是 `same_as_global`，表示跟着酒馆全局设置走。你也可以填写数字或其它酒馆支持的值。',
  },
  {
    key: 'flow.dyn_write.profile.probability',
    label: '概率',
    shortHelp: '这个条目命中的概率百分比。',
    detailHelp: '100 表示总是允许命中。只在“直接世界书激活”模式下真的参与触发判断；仓库模式下只是保存下来。',
  },
  {
    key: 'flow.dyn_write.profile.position.type',
    label: '位置类型',
    shortHelp: '决定这条 Dyn 大致插在提示词的哪个位置。',
    detailHelp:
      '最常用的是“放在角色设定前”，也就是在角色卡正文前面插入。其余选项主要用于插到示例对话附近、作者注附近，或按聊天深度塞进历史里。',
  },
  {
    key: 'flow.dyn_write.profile.position.role',
    label: '注入角色',
    shortHelp: '这段世界书内容会以什么身份注入。',
    detailHelp: '通常选 `system` 最稳，也可以按需要改成 `user` 或 `assistant`。',
  },
  {
    key: 'flow.dyn_write.profile.position.depth',
    label: '注入深度',
    shortHelp: '控制插入时离当前消息有多深。',
    detailHelp: '一般保持 0 就够用。只有你明确知道自己在调酒馆世界书的深度行为时，才需要改这个值。',
  },
  {
    key: 'flow.dyn_write.profile.position.order',
    label: '注入顺序',
    shortHelp: '同一位置下，多个条目的先后顺序。',
    detailHelp: '数值越容易用来区分先后。你可以把它理解成“排序权重”，用于稳定多个 Dyn 的注入顺序。',
  },
  {
    key: 'flow.dyn_write.profile.strategy.keys',
    label: '主关键词',
    shortHelp: '主要触发词，命中时最优先参考这里。',
    detailHelp: '支持逗号或换行分隔。保存后会自动整理成关键词数组。',
  },
  {
    key: 'flow.dyn_write.profile.strategy.keys_secondary.keys',
    label: '次关键词',
    shortHelp: '辅助触发词，用来补充更细的命中条件。',
    detailHelp: '当主触发词还不够精细时，可以在这里补充辅助词，再通过下面的匹配规则决定它们如何生效。',
  },
  {
    key: 'flow.dyn_write.profile.strategy.keys_secondary.logic',
    label: '次关键词逻辑',
    shortHelp: '辅助触发词之间按什么规则判断。',
    detailHelp: '`and_any` 表示命中任一即可，`and_all` 表示必须全中，`not_any` 表示命中任一就排除，`not_all` 表示全部命中才排除。',
  },
  {
    key: 'flow.dyn_write.profile.extra.group',
    label: '分组',
    shortHelp: '给这个条目指定一个分组名。',
    detailHelp: '分组可以让一批同类 Dyn 在酒馆里一起参与评分、联动或互斥。如果你暂时不用分组，留空即可。',
  },
  {
    key: 'flow.dyn_write.profile.extra.groupWeight',
    label: '分组权重',
    shortHelp: '这个条目在分组评分中的权重。',
    detailHelp: '只有启用了分组评分时才真的会影响命中结果；否则只是保存这个配置，不直接起作用。',
  },
  {
    key: 'flow.dyn_write.profile.effect.sticky',
    label: 'Sticky',
    shortHelp: '命中后还要继续保留多少轮。',
    detailHelp: '留空表示不设置。你可以把它理解成“持续轮数”，只在直接世界书激活模式下生效。',
  },
  {
    key: 'flow.dyn_write.profile.effect.cooldown',
    label: 'Cooldown',
    shortHelp: '命中后要冷却多少轮，期间不再重复触发。',
    detailHelp: '留空表示不设置。适合那些不希望连续多轮重复出现的 Dyn 条目。',
  },
  {
    key: 'flow.dyn_write.profile.effect.delay',
    label: 'Delay',
    shortHelp: '满足条件后延迟多少轮才真正生效。',
    detailHelp: '留空表示不设置。适合需要过几轮再出现的 Dyn 条目。',
  },
  {
    key: 'flow.generation',
    label: '生成参数',
    shortHelp: '配置该工作流发送给外部模型的核心采样参数。',
    detailHelp: '这组参数只属于当前工作流。用于对不同工作流设置不同的回复长度、采样和流式策略。',
  },
  {
    key: 'flow.generation.unlock_context_length',
    label: '解锁上下文长度',
    shortHelp: '开启后可手动设置上下文词符上限。',
    detailHelp: '关闭时沿用模型默认上下文长度；开启后请确保设置值在你的模型服务允许范围内。',
  },
  {
    key: 'flow.generation.max_context_tokens',
    label: '上下文长度（词符）',
    shortHelp: '该工作流可见的最大上下文词符数。',
    detailHelp: '值越大历史信息越完整，但请求成本和延迟也会增加。',
  },
  {
    key: 'flow.generation.max_reply_tokens',
    label: '最大回复长度（词符）',
    shortHelp: '限制该工作流单次生成的最大输出长度。',
    detailHelp: '可用于防止抽取任务输出过长，建议按任务目标设置更紧凑的上限。',
  },
  {
    key: 'flow.generation.n_candidates',
    label: '备选回复数',
    shortHelp: '每次请求让模型返回的候选回复数量。',
    detailHelp: '大于 1 时请求成本更高；首版链路通常使用 1，保证稳定和低延迟。',
  },
  {
    key: 'flow.generation.stream',
    label: '流式传输',
    shortHelp: '是否按流式方式接收外部模型输出。',
    detailHelp: '开启后服务端可以边生成边返回；关闭则等待完整结果后一次性返回。',
  },
  {
    key: 'flow.generation.temperature',
    label: '温度',
    shortHelp: '控制输出随机性，越高越发散。',
    detailHelp: '抽取类任务建议中低温度；创意扩写类任务可以适当提高。',
  },
  {
    key: 'flow.generation.frequency_penalty',
    label: '频率惩罚',
    shortHelp: '降低模型重复使用同一词汇的倾向。',
    detailHelp: '值越高越抑制重复，适用于长文本重复问题明显的工作流。',
  },
  {
    key: 'flow.generation.presence_penalty',
    label: '存在惩罚',
    shortHelp: '鼓励模型引入新词或新内容。',
    detailHelp: '适当提高可减少原地重复，但过高可能降低输出稳定性。',
  },
  {
    key: 'flow.generation.top_p',
    label: 'Top P',
    shortHelp: '核采样阈值，控制候选词概率覆盖范围。',
    detailHelp: '通常与温度搭配调节；值越低越保守，越高越开放。',
  },
  {
    key: 'flow.behavior',
    label: '行为参数',
    shortHelp: '配置消息拼装策略和模型额外行为开关。',
    detailHelp: '用于控制名称行为、系统消息处理、思维链请求等模型侧行为。',
  },
  {
    key: 'flow.behavior.name_behavior',
    label: '角色名称行为',
    shortHelp: '控制消息中角色名称的拼接方式。',
    detailHelp: '不同模型对角色前缀敏感度不同，建议按你使用的模型逐项验证。',
  },
  {
    key: 'flow.behavior.reasoning_effort',
    label: '推理强度',
    shortHelp: '设置模型推理力度（若模型支持）。',
    detailHelp: '自动通常最稳；提高强度可能增加耗时与成本。',
  },
  {
    key: 'flow.behavior.verbosity',
    label: 'Verbosity',
    shortHelp: '控制输出详细程度（若模型支持）。',
    detailHelp: '高详细度更啰嗦，低详细度更紧凑。抽取任务通常用 auto 或 low。',
  },
  {
    key: 'flow.prompt_items',
    label: '提示词配置',
    shortHelp: '按条目管理工作流提示词，可独立启停与排序。',
    detailHelp: '每条提示词可指定角色、触发器、插入位置和文本内容，最终由外部工作流按顺序消费。',
  },
  {
    key: 'flow.prompt_item.name',
    label: '提示词名称',
    shortHelp: '用于识别该提示词条目的显示名称。',
    detailHelp: '建议使用任务语义名称，例如“剧情抽取规则”“阶段判定提示”。',
  },
  {
    key: 'flow.prompt_item.role',
    label: '提示词角色',
    shortHelp: '决定该提示词在消息数组中的角色类型。',
    detailHelp: '一般规则提示使用 system，辅助样例或追问可用 user/assistant。',
  },
  {
    key: 'flow.prompt_item.position',
    label: '插入位置',
    shortHelp: '决定提示词以“相对”或“聊天中”方式插入。',
    detailHelp: '相对模式更适合稳定的全局约束；聊天中模式更适合随对话动态变化的提示。',
  },
  {
    key: 'flow.prompt_item.trigger_types',
    label: '触发器',
    shortHelp: '限制该提示词在什么触发类型下生效。',
    detailHelp: '默认 All types 表示所有触发都生效，也可以按发送、继续、重试等类型单独限制。',
  },
  {
    key: 'flow.prompt_item.content',
    label: '提示词内容',
    shortHelp: '该条提示词的正文内容。',
    detailHelp: '建议保持单条职责清晰，避免把所有约束堆在同一条目里。',
  },
  {
    key: 'flow.extract_rules',
    label: '提取规则',
    shortHelp: '按起止标签从文本中提取片段。',
    detailHelp: '每条规则都包含 start/end，提取结果会进入工作流请求的 context 构建流程。',
  },
  {
    key: 'flow.exclude_rules',
    label: '排除规则',
    shortHelp: '按起止标签剔除不应发送的片段。',
    detailHelp: '常用于去掉 thinking 或系统中间内容，减少噪声并降低泄漏风险。',
  },
  {
    key: 'flow.request_template',
    label: '请求模板',
    shortHelp: '对标准请求体进行 JSON merge 扩展。',
    detailHelp: '用于补充额外字段。请确保合并后仍满足外部工作流预期结构。',
    placeholder: '{"context":{"turns":{{context.turns}}}}',
  },
  {
    key: 'flow.response_remove_regex',
    label: '移除正则',
    shortHelp: 'AI 响应后处理：移除匹配的内容（如思考过程标签）。',
    detailHelp: '在 JSON 解析前执行。使用正则表达式全局匹配并删除。留空则不做移除处理。',
    placeholder: '<thinking>[\\s\\S]*?</thinking>',
  },
  {
    key: 'flow.response_extract_regex',
    label: '提取正则',
    shortHelp: 'AI 响应后处理：从响应中提取特定标签内的内容。',
    detailHelp: '在移除正则之后执行。使用第一个捕获组 (group 1) 的内容。留空则不做提取处理。',
    placeholder: '<content>([\\s\\S]*?)</content>',
  },
  {
    key: 'manual_message',
    label: '手动运行输入',
    shortHelp: '调试模式手动执行时的输入内容。',
    detailHelp: '留空时默认使用最新楼层文本，适合快速复现实战场景。',
  },
  {
    key: 'import_text',
    label: '导入配置',
    shortHelp: '粘贴完整 JSON 后应用到当前脚本配置。',
    detailHelp: '导入后会立即校验并覆盖当前设置。建议先导出备份再导入。',
  },
];

export const FIELD_HELP: Record<string, FieldHelpMeta> = Object.fromEntries(
  FIELD_HELP_LIST.map(meta => [meta.key, meta]),
);

export function getFieldHelp(key: string): FieldHelpMeta | undefined {
  return FIELD_HELP[key];
}
