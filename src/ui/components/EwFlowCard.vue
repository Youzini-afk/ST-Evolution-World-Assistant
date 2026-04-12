<template>
  <article class="ew-flow-card" :data-enabled="flow.enabled ? '1' : '0'" :data-expanded="expanded ? '1' : '0'">
    <header class="ew-flow-card__header">
      <div class="ew-flow-card__summary">
        <strong class="ew-flow-card__name">{{ flow.name || `工作流 ${index + 1}` }}</strong>
        <div class="ew-flow-card__chips">
          <span class="ew-flow-card__chip">{{ flow.enabled ? '启用' : '停用' }}</span>
          <span class="ew-flow-card__chip">{{ floorIntervalLabel }}</span>
          <span class="ew-flow-card__chip">优先级 {{ flow.priority }}</span>
          <span class="ew-flow-card__chip">超时 {{ flow.timeout_ms }}ms</span>
          <span class="ew-flow-card__chip">API {{ presetLabel }}</span>
          <span class="ew-flow-card__chip">提示词 {{ flow.prompt_items.length }}</span>
        </div>
        <p class="ew-flow-card__endpoint">接口: {{ endpointSummary }}</p>
      </div>

      <div class="ew-flow-card__actions">
        <div class="ew-toggle-item ew-flow-card__enabled-toggle">
          <button
            type="button"
            class="ew-switch"
            role="switch"
            :aria-checked="flow.enabled ? 'true' : 'false'"
            :title="flow.enabled ? '点击停用工作流' : '点击启用工作流'"
            @click="toggleEnabled"
          >
            <span class="ew-switch__track" :data-enabled="flow.enabled ? '1' : '0'">
              <span class="ew-switch__thumb" />
            </span>
          </button>
          <span class="ew-toggle-item__label">启用</span>
        </div>
        <button
          type="button"
          class="ew-flow-card__action ew-flow-card__action--primary"
          :disabled="busy"
          :title="flow.enabled ? '手动执行当前工作流' : '手动执行当前工作流（即使当前为停用）'"
          @click="$emit('execute')"
        >
          {{ executing ? '执行中…' : '执行' }}
        </button>
        <button type="button" class="ew-flow-card__action" @click="$emit('toggle-expand')">
          {{ expanded ? '收起' : '编辑' }}
        </button>
        <button type="button" class="ew-flow-card__action" @click="$emit('duplicate')">复制</button>
        <button type="button" class="ew-flow-card__action" @click="$emit('export')">导出</button>
        <button type="button" class="ew-flow-card__action" @click="openFlowFilePicker">导入</button>
        <input
          ref="flowFileInput"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onImportFile"
        />
        <button type="button" class="ew-flow-card__action ew-flow-card__action--danger" @click="$emit('remove')">
          删除
        </button>
      </div>
    </header>

    <transition name="ew-expand">
      <div v-if="hasBeenExpanded" v-show="expanded" class="ew-flow-card__body">
        <section class="ew-flow-card__section">
          <h4>基础信息</h4>
          <div class="ew-grid ew-grid--two">
            <EwFieldRow label="名称" :help="help('flow.name')">
              <input :value="flow.name" type="text" @input="setText('name', $event)" />
            </EwFieldRow>
            <EwFieldRow label="工作流ID" :help="help('flow.id')">
              <input :value="flow.id" type="text" @input="setText('id', $event)" />
            </EwFieldRow>
            <EwFieldRow label="执行时机">
              <select :value="flow.timing" @change="setTiming">
                <option value="default">跟随全局（{{ timingLabel }}）</option>
                <option value="after_reply">回复后更新</option>
                <option value="before_reply">回复前拦截</option>
              </select>
            </EwFieldRow>
            <EwFieldRow label="API配置预设" :help="help('flow.api_preset_id')">
              <select :value="flow.api_preset_id" @change="setApiPresetId">
                <option v-if="apiPresets.length === 0" value="">无可用API配置</option>
                <option v-for="preset in apiPresets" :key="preset.id" :value="preset.id">
                  {{ preset.name || preset.id }}
                </option>
              </select>
            </EwFieldRow>
            <EwFieldRow label="优先级" :help="help('flow.priority')">
              <input
                :value="flow.priority"
                type="number"
                min="-9999"
                max="9999"
                step="1"
                @input="setFlowNumber('priority', $event)"
              />
            </EwFieldRow>
            <EwFieldRow label="每多少个对应楼层自动执行一次" :help="help('flow.run_every_n_floors')">
              <input
                :value="flow.run_every_n_floors"
                type="number"
                min="1"
                step="1"
                @input="setFlowNumber('run_every_n_floors', $event)"
              />
            </EwFieldRow>
            <EwFieldRow label="超时(ms)" :help="help('flow.timeout_ms')">
              <input
                :value="flow.timeout_ms"
                type="number"
                min="1000"
                step="500"
                @input="setFlowNumber('timeout_ms', $event)"
              />
            </EwFieldRow>
            <EwFieldRow label="上下文楼层数" :help="help('flow.context_turns')">
              <input
                :value="flow.context_turns"
                type="number"
                min="1"
                step="1"
                @input="setFlowNumber('context_turns', $event)"
              />
            </EwFieldRow>
          </div>
        </section>

        <section class="ew-flow-card__section">
          <div class="ew-flow-card__section-head">
            <h4>生成参数</h4>
          </div>

          <div v-if="deferredAdvancedReady" class="ew-grid ew-grid--two">
            <EwFieldRow label="解锁上下文长度">
              <label class="ew-switch ew-switch--field">
                <input
                  :checked="flow.generation_options.unlock_context_length"
                  type="checkbox"
                  @change="setGenerationBool('unlock_context_length', $event)"
                />
                <span class="ew-switch__slider"></span>
                <span class="ew-switch__label">{{
                  flow.generation_options.unlock_context_length ? '已启用' : '已关闭'
                }}</span>
              </label>
            </EwFieldRow>
            <EwFieldRow label="流式传输">
              <label class="ew-switch ew-switch--field">
                <input
                  :checked="flow.generation_options.stream"
                  type="checkbox"
                  @change="setGenerationBool('stream', $event)"
                />
                <span class="ew-switch__slider"></span>
                <span class="ew-switch__label">{{ flow.generation_options.stream ? '已启用' : '已关闭' }}</span>
              </label>
            </EwFieldRow>
            <EwFieldRow label="上下文长度（词符）">
              <div class="ew-range">
                <input
                  :value="flow.generation_options.max_context_tokens"
                  type="range"
                  min="16000"
                  max="500000"
                  step="1000"
                  :disabled="!flow.generation_options.unlock_context_length"
                  @input="setGenerationNumber('max_context_tokens', $event)"
                />
                <input
                  :value="flow.generation_options.max_context_tokens"
                  type="number"
                  min="16000"
                  step="1000"
                  :disabled="!flow.generation_options.unlock_context_length"
                  @input="setGenerationNumber('max_context_tokens', $event)"
                />
              </div>
            </EwFieldRow>
            <EwFieldRow label="最大回复长度（词符）">
              <input
                :value="flow.generation_options.max_reply_tokens"
                type="number"
                min="1"
                step="32"
                @input="setGenerationNumber('max_reply_tokens', $event)"
              />
            </EwFieldRow>
            <EwFieldRow label="备选回复数">
              <input
                :value="flow.generation_options.n_candidates"
                type="number"
                min="1"
                step="1"
                @input="setGenerationNumber('n_candidates', $event)"
              />
            </EwFieldRow>
            <EwFieldRow label="温度">
              <div class="ew-range">
                <input
                  :value="flow.generation_options.temperature"
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  @input="setGenerationNumber('temperature', $event)"
                />
                <input
                  :value="flow.generation_options.temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.01"
                  @input="setGenerationNumber('temperature', $event)"
                />
              </div>
            </EwFieldRow>
            <EwFieldRow label="频率惩罚">
              <div class="ew-range">
                <input
                  :value="flow.generation_options.frequency_penalty"
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  @input="setGenerationNumber('frequency_penalty', $event)"
                />
                <input
                  :value="flow.generation_options.frequency_penalty"
                  type="number"
                  min="0"
                  max="2"
                  step="0.01"
                  @input="setGenerationNumber('frequency_penalty', $event)"
                />
              </div>
            </EwFieldRow>
            <EwFieldRow label="存在惩罚">
              <div class="ew-range">
                <input
                  :value="flow.generation_options.presence_penalty"
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  @input="setGenerationNumber('presence_penalty', $event)"
                />
                <input
                  :value="flow.generation_options.presence_penalty"
                  type="number"
                  min="0"
                  max="2"
                  step="0.01"
                  @input="setGenerationNumber('presence_penalty', $event)"
                />
              </div>
            </EwFieldRow>
            <EwFieldRow label="Top P">
              <div class="ew-range">
                <input
                  :value="flow.generation_options.top_p"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  @input="setGenerationNumber('top_p', $event)"
                />
                <input
                  :value="flow.generation_options.top_p"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  @input="setGenerationNumber('top_p', $event)"
                />
              </div>
            </EwFieldRow>
          </div>
          <div v-else class="ew-flow-card__deferred-placeholder">正在加载生成参数编辑器…</div>
        </section>
        <section class="ew-flow-card__section">
          <div class="ew-flow-card__section-head">
            <h4>行为参数</h4>
          </div>

          <div v-if="deferredAdvancedReady">
            <!-- Selects row -->
            <div class="ew-grid ew-grid--two">
              <EwFieldRow label="角色名称行为">
                <select
                  :value="flow.behavior_options.name_behavior"
                  @change="setBehaviorSelectByEvent('name_behavior', $event)"
                >
                  <option value="none">无</option>
                  <option value="default">默认</option>
                  <option value="complete_target">补全对象</option>
                  <option value="message_content">消息内容</option>
                </select>
              </EwFieldRow>
              <EwFieldRow label="推理强度">
                <select
                  :value="flow.behavior_options.reasoning_effort"
                  @change="setBehaviorSelectByEvent('reasoning_effort', $event)"
                >
                  <option value="auto">自动</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </EwFieldRow>
              <EwFieldRow label="详细程度">
                <select
                  :value="flow.behavior_options.verbosity"
                  @change="setBehaviorSelectByEvent('verbosity', $event)"
                >
                  <option value="auto">自动</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </EwFieldRow>
              <EwFieldRow label="结构化输出" :help="help('flow.structured_output')">
                <select
                  :value="flow.behavior_options.structured_output"
                  @change="setBehaviorSelectByEvent('structured_output', $event)"
                >
                  <option value="off">关闭</option>
                  <option value="json_object">JSON对象</option>
                </select>
              </EwFieldRow>
            </div>

            <!-- Toggle switches grid -->
            <div class="ew-toggle-grid">
              <div class="ew-toggle-item">
                <button
                  type="button"
                  class="ew-switch"
                  role="switch"
                  :aria-checked="flow.behavior_options.continue_prefill ? 'true' : 'false'"
                  @click="setBehaviorToggle('continue_prefill')"
                >
                  <span class="ew-switch__track" :data-enabled="flow.behavior_options.continue_prefill ? '1' : '0'">
                    <span class="ew-switch__thumb" />
                  </span>
                </button>
                <span class="ew-toggle-item__label">继续预填充</span>
              </div>
              <div class="ew-toggle-item">
                <button
                  type="button"
                  class="ew-switch"
                  role="switch"
                  :aria-checked="flow.behavior_options.squash_system_messages ? 'true' : 'false'"
                  @click="setBehaviorToggle('squash_system_messages')"
                >
                  <span
                    class="ew-switch__track"
                    :data-enabled="flow.behavior_options.squash_system_messages ? '1' : '0'"
                  >
                    <span class="ew-switch__thumb" />
                  </span>
                </button>
                <span class="ew-toggle-item__label">压缩系统消息</span>
              </div>
              <div class="ew-toggle-item">
                <button
                  type="button"
                  class="ew-switch"
                  role="switch"
                  :aria-checked="flow.behavior_options.enable_function_calling ? 'true' : 'false'"
                  @click="setBehaviorToggle('enable_function_calling')"
                >
                  <span
                    class="ew-switch__track"
                    :data-enabled="flow.behavior_options.enable_function_calling ? '1' : '0'"
                  >
                    <span class="ew-switch__thumb" />
                  </span>
                </button>
                <span class="ew-toggle-item__label">启用函数调用</span>
              </div>
              <div class="ew-toggle-item">
                <button
                  type="button"
                  class="ew-switch"
                  role="switch"
                  :aria-checked="flow.behavior_options.send_inline_media ? 'true' : 'false'"
                  @click="setBehaviorToggle('send_inline_media')"
                >
                  <span class="ew-switch__track" :data-enabled="flow.behavior_options.send_inline_media ? '1' : '0'">
                    <span class="ew-switch__thumb" />
                  </span>
                </button>
                <span class="ew-toggle-item__label">发送内联媒体</span>
              </div>
              <div class="ew-toggle-item">
                <button
                  type="button"
                  class="ew-switch"
                  role="switch"
                  :aria-checked="flow.behavior_options.request_thinking ? 'true' : 'false'"
                  @click="setBehaviorToggle('request_thinking')"
                >
                  <span class="ew-switch__track" :data-enabled="flow.behavior_options.request_thinking ? '1' : '0'">
                    <span class="ew-switch__thumb" />
                  </span>
                </button>
                <span class="ew-toggle-item__label">请求思维链</span>
              </div>
            </div>
          </div>
          <div v-else class="ew-flow-card__deferred-placeholder">正在加载行为参数编辑器…</div>
        </section>

        <section class="ew-flow-card__section ew-flow-card__section--deferred">
          <h4>上下文规则</h4>
          <p class="ew-flow-card__desc">在聊天消息发送给工作流 AI 之前，依次进行：正则处理 → 文本切片。</p>

          <template v-if="deferredContextReady">
            <div class="ew-flow-card__subsection">
              <h5>正则处理</h5>
              <div class="ew-toggle-item">
                <button
                  type="button"
                  class="ew-switch"
                  role="switch"
                  :aria-checked="flow.use_tavern_regex ? 'true' : 'false'"
                  @click="patch({ use_tavern_regex: !flow.use_tavern_regex })"
                >
                  <span class="ew-switch__track" :data-enabled="flow.use_tavern_regex ? '1' : '0'">
                    <span class="ew-switch__thumb" />
                  </span>
                </button>
                <span class="ew-toggle-item__label">使用酒馆已启用的正则</span>
              </div>
              <p class="ew-flow-card__hint-text">
                开启后，聊天消息会先经过酒馆当前激活的正则脚本处理（全局 + 角色卡正则）。
              </p>
              <button type="button" class="ew-mini-btn ew-mini-btn--info" @click="openRegexPreview">
                查看当前正则
              </button>

              <div class="ew-flow-card__custom-regex-head">
                <h6>自定义正则</h6>
                <button type="button" class="ew-mini-btn" @click="addCustomRegex">新增</button>
              </div>
              <div v-if="flow.custom_regex_rules.length === 0" class="ew-empty">暂无自定义正则。</div>
              <transition-group v-else name="ew-list" tag="div" class="ew-regex-list">
                <article v-for="(rule, ruleIndex) in flow.custom_regex_rules" :key="rule.id" class="ew-regex-item">
                  <header class="ew-regex-item__head">
                    <label class="ew-checkbox"
                      ><input :checked="rule.enabled" type="checkbox" @change="setRegexEnabled(ruleIndex, $event)"
                    /></label>
                    <span class="ew-regex-item__name" :title="rule.name">{{
                      rule.name || `规则 ${ruleIndex + 1}`
                    }}</span>
                    <button type="button" class="ew-mini-btn ew-mini-btn--danger" @click="removeCustomRegex(ruleIndex)">
                      删除
                    </button>
                  </header>
                  <div class="ew-regex-item__body">
                    <EwFieldRow label="名称"
                      ><input
                        :value="rule.name"
                        type="text"
                        placeholder="起个名字..."
                        @input="patchRegexText(ruleIndex, 'name', $event)"
                    /></EwFieldRow>
                    <EwFieldRow label="正则表达式"
                      ><input
                        :value="rule.find_regex"
                        type="text"
                        placeholder="/pattern/gi"
                        @input="patchRegexText(ruleIndex, 'find_regex', $event)"
                    /></EwFieldRow>
                    <EwFieldRow label="替换文本"
                      ><input
                        :value="rule.replace_string"
                        type="text"
                        placeholder="留空则删除"
                        @input="patchRegexText(ruleIndex, 'replace_string', $event)"
                    /></EwFieldRow>
                  </div>
                </article>
              </transition-group>
            </div>

            <div class="ew-flow-card__subsection">
              <h5>文本切片</h5>
              <div class="ew-grid ew-grid--two">
                <section>
                  <div class="ew-subhead"><h6>提取规则</h6></div>
                  <p class="ew-flow-card__hint-text">只保留 start～end 之间的文本发给 AI（如：只提取正文）。</p>
                  <EwRulesEditor
                    title="提取规则"
                    :model-value="flow.extract_rules"
                    @update:model-value="value => patch({ extract_rules: value })"
                  />
                </section>
                <section>
                  <div class="ew-subhead"><h6>排除规则</h6></div>
                  <p class="ew-flow-card__hint-text">删掉 start～end 之间的文本（如：去掉思考标记）。</p>
                  <EwRulesEditor
                    title="排除规则"
                    :model-value="flow.exclude_rules"
                    @update:model-value="value => patch({ exclude_rules: value })"
                  />
                </section>
              </div>
            </div>
          </template>
          <div v-else class="ew-flow-card__deferred-placeholder">正在加载上下文规则编辑器…</div>
        </section>

        <section class="ew-flow-card__section ew-flow-card__section--deferred">
          <div class="ew-flow-card__section-head">
            <h4>系统提示词</h4>
            <div class="ew-flow-card__action-group">
              <button
                type="button"
                class="ew-mini-btn ew-mini-btn--info"
                @click="patch({ system_prompt: DEFAULT_WORKFLOW_SYSTEM_PROMPT })"
              >
                恢复默认
              </button>
            </div>
          </div>
          <textarea
            v-if="deferredPostReady"
            :value="flow.system_prompt"
            rows="5"
            :placeholder="'留空则不追加系统提示词\n\n默认值：\n' + DEFAULT_WORKFLOW_SYSTEM_PROMPT"
            @input="(e: Event) => patch({ system_prompt: (e.target as HTMLTextAreaElement).value })"
          />
          <div v-else class="ew-flow-card__deferred-placeholder">正在加载系统提示词编辑器…</div>
        </section>

        <section class="ew-flow-card__section ew-flow-card__section--deferred">
          <div class="ew-flow-card__section-head">
            <h4>提示词编排</h4>
          </div>
          <EwPromptOrderList
            v-if="deferredPromptOrderReady"
            :prompt-order="flow.prompt_order"
            @update:prompt-order="updatePromptOrder"
          />
          <div v-else class="ew-flow-card__deferred-placeholder">正在加载提示词编排编辑器…</div>
        </section>

        <EwFieldRow v-if="deferredPostReady" label="请求模板(JSON merge)" :help="help('flow.request_template')">
          <textarea
            :value="requestTemplateDraft"
            rows="4"
            :placeholder="help('flow.request_template')?.placeholder"
            @input="setRequestTemplateDraft"
          />
        </EwFieldRow>
        <div v-else class="ew-flow-card__deferred-placeholder">正在加载请求模板编辑器…</div>

        <section class="ew-flow-card__section ew-flow-card__section--deferred">
          <div class="ew-flow-card__section-head">
            <h4>Dyn 写入配置</h4>
            <button type="button" class="ew-flow-card__mini-toggle" @click="toggleDynWriteOpen">
              {{ dynWriteOpen ? '收起' : '展开' }}
            </button>
          </div>
          <p class="ew-flow-card__hint-text">
            当前：{{ dynWriteModeLabel }} / {{ dynActivationModeLabel }}
          </p>
          <template v-if="dynWriteOpen && deferredPostReady">
            <div class="ew-grid ew-grid--two">
              <EwFieldRow label="写入模式" :help="help('flow.dyn_write.mode')">
                <select :value="flow.dyn_write.mode" @change="setDynWriteMode">
                  <option value="overwrite">覆盖</option>
                  <option value="add">只增</option>
                  <option value="add_remove">增减</option>
                </select>
              </EwFieldRow>
              <EwFieldRow label="Dyn 模式" :help="help('flow.dyn_write.activation_mode')">
                <select :value="flow.dyn_write.activation_mode" @change="setDynActivationMode">
                  <option value="controller_only">控制器仓库</option>
                  <option value="worldbook_direct">直接世界书激活</option>
                </select>
              </EwFieldRow>
            </div>

            <p class="ew-flow-card__hint-text" v-if="flow.dyn_write.activation_mode === 'controller_only'">
              当前为仓库型 Dyn。条目会保持红灯，关键词和概率等配置只作为元数据保存，真正注入仍由 Controller `getwi()`
              完成。
            </p>
            <p class="ew-flow-card__hint-text" v-else>
              当前为直接激活型 Dyn。条目会保持启用，并按下面的世界书配置直接参与酒馆世界书激活。
            </p>

            <div class="ew-flow-card__subsection">
              <h5>基本设置</h5>
              <div class="ew-grid ew-grid--two">
                <EwFieldRow label="备注说明" :help="help('flow.dyn_write.profile.comment')">
                  <input
                    :value="flow.dyn_write.profile.comment"
                    type="text"
                    placeholder="给自己看的备注，不会直接写进正文"
                    @input="setDynComment"
                  />
                </EwFieldRow>
                <EwFieldRow label="触发方式" :help="help('flow.dyn_write.profile.strategy.type')">
                  <input
                    :value="flow.dyn_write.profile.strategy.type"
                    type="text"
                    placeholder="例如：constant（常驻）"
                    @input="setDynStrategyType"
                  />
                </EwFieldRow>
                <EwFieldRow label="扫描范围" :help="help('flow.dyn_write.profile.strategy.scan_depth')">
                  <input
                    :value="String(flow.dyn_write.profile.strategy.scan_depth)"
                    type="text"
                    placeholder="same_as_global（跟随全局）"
                    @input="setDynScanDepth"
                  />
                </EwFieldRow>
                <EwFieldRow label="命中概率(%)" :help="help('flow.dyn_write.profile.probability')">
                  <input
                    :value="flow.dyn_write.profile.probability"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    @input="setDynProbability"
                  />
                </EwFieldRow>
              </div>
              <p class="ew-flow-card__hint-text">
                常用写法：`constant` 表示常驻条目；`same_as_global` 表示扫描范围跟随酒馆全局设置。
              </p>
            </div>

            <div class="ew-flow-card__subsection">
              <h5>注入位置</h5>
              <div class="ew-grid ew-grid--two">
                <EwFieldRow label="位置代码" :help="help('flow.dyn_write.profile.position.type')">
                  <select :value="flow.dyn_write.profile.position.type" @change="setDynPositionType">
                    <option v-for="option in dynPositionTypeOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </EwFieldRow>
                <EwFieldRow label="注入身份" :help="help('flow.dyn_write.profile.position.role')">
                  <select :value="flow.dyn_write.profile.position.role" @change="setDynPositionRole">
                    <option value="system">系统(system)</option>
                    <option value="user">用户(user)</option>
                    <option value="assistant">助手(assistant)</option>
                  </select>
                </EwFieldRow>
                <EwFieldRow label="插入深度" :help="help('flow.dyn_write.profile.position.depth')">
                  <input
                    :value="flow.dyn_write.profile.position.depth"
                    type="number"
                    min="0"
                    step="1"
                    @input="setDynPositionDepth"
                  />
                </EwFieldRow>
                <EwFieldRow label="排序权重" :help="help('flow.dyn_write.profile.position.order')">
                  <input
                    :value="flow.dyn_write.profile.position.order"
                    type="number"
                    step="1"
                    @input="setDynPositionOrder"
                  />
                </EwFieldRow>
              </div>
              <p class="ew-flow-card__hint-text">
                常用位置：`before_character_definition` 表示插在角色卡前面；身份一般选“系统(system)”。
              </p>
            </div>

            <div class="ew-flow-card__subsection">
              <h5>触发词与分组</h5>
              <div class="ew-grid ew-grid--two">
                <EwFieldRow label="主触发词" :help="help('flow.dyn_write.profile.strategy.keys')">
                  <textarea
                    :value="flow.dyn_write.profile.strategy.keys.join(', ')"
                    rows="3"
                    placeholder="逗号或换行分隔"
                    @input="setDynPrimaryKeys"
                  />
                </EwFieldRow>
                <EwFieldRow label="辅助触发词" :help="help('flow.dyn_write.profile.strategy.keys_secondary.keys')">
                  <textarea
                    :value="flow.dyn_write.profile.strategy.keys_secondary.keys.join(', ')"
                    rows="3"
                    placeholder="逗号或换行分隔"
                    @input="setDynSecondaryKeys"
                  />
                </EwFieldRow>
                <EwFieldRow label="辅助词匹配规则" :help="help('flow.dyn_write.profile.strategy.keys_secondary.logic')">
                  <select :value="flow.dyn_write.profile.strategy.keys_secondary.logic" @change="setDynSecondaryLogic">
                    <option value="and_any">包含任一(and_any)</option>
                    <option value="and_all">包含全部(and_all)</option>
                    <option value="not_any">排除任一(not_any)</option>
                    <option value="not_all">全部排除(not_all)</option>
                  </select>
                </EwFieldRow>
                <EwFieldRow label="分组名" :help="help('flow.dyn_write.profile.extra.group')">
                  <input :value="flow.dyn_write.profile.extra.group" type="text" @input="setDynGroup" />
                </EwFieldRow>
                <EwFieldRow label="分组权重" :help="help('flow.dyn_write.profile.extra.groupWeight')">
                  <input
                    :value="flow.dyn_write.profile.extra.groupWeight"
                    type="number"
                    step="1"
                    @input="setDynGroupWeight"
                  />
                </EwFieldRow>
              </div>
            </div>

            <div class="ew-flow-card__subsection">
              <h5>持续效果与匹配细节</h5>
              <div class="ew-grid ew-grid--two">
                <EwFieldRow label="持续轮数" :help="help('flow.dyn_write.profile.effect.sticky')">
                  <input
                    :value="nullableNumberInput(flow.dyn_write.profile.effect.sticky)"
                    type="number"
                    min="0"
                    step="1"
                    @input="setDynEffectSticky"
                  />
                </EwFieldRow>
                <EwFieldRow label="冷却轮数" :help="help('flow.dyn_write.profile.effect.cooldown')">
                  <input
                    :value="nullableNumberInput(flow.dyn_write.profile.effect.cooldown)"
                    type="number"
                    min="0"
                    step="1"
                    @input="setDynEffectCooldown"
                  />
                </EwFieldRow>
                <EwFieldRow label="延迟生效轮数" :help="help('flow.dyn_write.profile.effect.delay')">
                  <input
                    :value="nullableNumberInput(flow.dyn_write.profile.effect.delay)"
                    type="number"
                    min="0"
                    step="1"
                    @input="setDynEffectDelay"
                  />
                </EwFieldRow>
              </div>

              <div class="ew-toggle-grid">
                <div class="ew-toggle-item">
                  <button
                    type="button"
                    class="ew-switch"
                    role="switch"
                    :aria-checked="flow.dyn_write.profile.extra.caseSensitive ? 'true' : 'false'"
                    @click="toggleDynExtra('caseSensitive')"
                  >
                    <span class="ew-switch__track" :data-enabled="flow.dyn_write.profile.extra.caseSensitive ? '1' : '0'">
                      <span class="ew-switch__thumb" />
                    </span>
                  </button>
                  <span class="ew-toggle-item__label">大小写敏感</span>
                </div>
                <div class="ew-toggle-item">
                  <button
                    type="button"
                    class="ew-switch"
                    role="switch"
                    :aria-checked="flow.dyn_write.profile.extra.matchWholeWords ? 'true' : 'false'"
                    @click="toggleDynExtra('matchWholeWords')"
                  >
                    <span class="ew-switch__track" :data-enabled="flow.dyn_write.profile.extra.matchWholeWords ? '1' : '0'">
                      <span class="ew-switch__thumb" />
                    </span>
                  </button>
                  <span class="ew-toggle-item__label">全词匹配</span>
                </div>
                <div class="ew-toggle-item">
                  <button
                    type="button"
                    class="ew-switch"
                    role="switch"
                    :aria-checked="flow.dyn_write.profile.extra.groupOverride ? 'true' : 'false'"
                    @click="toggleDynExtra('groupOverride')"
                  >
                    <span class="ew-switch__track" :data-enabled="flow.dyn_write.profile.extra.groupOverride ? '1' : '0'">
                      <span class="ew-switch__thumb" />
                    </span>
                  </button>
                  <span class="ew-toggle-item__label">覆盖分组</span>
                </div>
                <div class="ew-toggle-item">
                  <button
                    type="button"
                    class="ew-switch"
                    role="switch"
                    :aria-checked="flow.dyn_write.profile.extra.useGroupScoring ? 'true' : 'false'"
                    @click="toggleDynExtra('useGroupScoring')"
                  >
                    <span class="ew-switch__track" :data-enabled="flow.dyn_write.profile.extra.useGroupScoring ? '1' : '0'">
                      <span class="ew-switch__thumb" />
                    </span>
                  </button>
                  <span class="ew-toggle-item__label">启用分组评分</span>
                </div>
              </div>
            </div>
          </template>
          <div v-else-if="dynWriteOpen" class="ew-flow-card__deferred-placeholder">正在加载 Dyn 写入配置编辑器…</div>
        </section>

        <section class="ew-flow-card__section ew-flow-card__section--deferred">
          <h4>响应后处理</h4>
          <template v-if="deferredPostReady">
            <EwFieldRow label="移除正则" :help="help('flow.response_remove_regex')">
              <input
                :value="flow.response_remove_regex"
                type="text"
                placeholder="示例: <thinking>[\s\S]*?</thinking>"
                @input="setText('response_remove_regex', $event)"
              />
            </EwFieldRow>
            <EwFieldRow label="提取正则" :help="help('flow.response_extract_regex')">
              <input
                :value="flow.response_extract_regex"
                type="text"
                placeholder="示例: <content>([\s\S]*?)</content>"
                @input="setText('response_extract_regex', $event)"
              />
            </EwFieldRow>
          </template>
          <div v-else class="ew-flow-card__deferred-placeholder">正在加载响应后处理编辑器…</div>
        </section>
      </div>
    </transition>

    <!-- 正则预览弹窗 -->
    <transition name="ew-modal">
      <div v-if="showRegexModal" class="ew-modal-overlay" @click.self="showRegexModal = false">
        <div class="ew-modal ew-modal--regex">
          <header class="ew-modal__header">
            <h3>当前正则脚本一览</h3>
            <button type="button" class="ew-modal__close" @click="showRegexModal = false">✕</button>
          </header>
          <div class="ew-modal__body">
            <p v-if="regexPreviewList.length === 0" class="ew-empty">没有收集到任何已启用的正则脚本。</p>
            <div v-for="(script, i) in regexPreviewList" :key="script.id" class="ew-regex-preview-item">
              <div class="ew-regex-preview-item__head">
                <span class="ew-regex-preview-item__index">#{{ i + 1 }}</span>
                <span class="ew-regex-preview-item__name">{{ script.scriptName || '未命名' }}</span>
                <span
                  v-if="script.isBeautification"
                  class="ew-regex-preview-item__badge ew-regex-preview-item__badge--beauty"
                  >美化 → 清空</span
                >
                <span v-else class="ew-regex-preview-item__badge ew-regex-preview-item__badge--transform">转义</span>
                <span v-if="script.markdownOnly" class="ew-regex-preview-item__badge ew-regex-preview-item__badge--skip"
                  >跳过(MD)</span
                >
              </div>
              <div class="ew-regex-preview-item__details">
                <div class="ew-regex-preview-item__row">
                  <span class="ew-regex-preview-item__label">查找</span><code>{{ script.findRegex }}</code>
                </div>
                <div class="ew-regex-preview-item__row">
                  <span class="ew-regex-preview-item__label">替换</span><code>{{ script.effectiveReplace }}</code>
                </div>
                <div class="ew-regex-preview-item__row">
                  <span class="ew-regex-preview-item__label">作用域</span><span>{{ script.placementLabel }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </article>
</template>

<script setup lang="ts">
import { DEFAULT_WORKFLOW_SYSTEM_PROMPT } from '../../runtime/dispatcher';
import { simpleHash } from '../../runtime/helpers';
import { collectAllRegexScripts, isBeautificationReplace } from '../../runtime/regex-engine';
import type { EwApiPreset, EwFlowConfig, EwPromptOrderEntry } from '../../runtime/types';
import { EwFlowConfigSchema } from '../../runtime/types';
import { convertStPresetToFlow, isSillyTavernPreset } from '../convertStPreset';
import { getFieldHelp } from '../help-meta';
import EwFieldRow from './EwFieldRow.vue';

import { useEwStore } from '../store';
import EwPromptOrderList from './EwPromptOrderList.vue';
import EwRulesEditor from './EwRulesEditor.vue';

const ewStore = useEwStore();
type FlowNumberKey = 'priority' | 'timeout_ms' | 'context_turns' | 'run_every_n_floors';
type GenerationNumberKey =
  | 'max_context_tokens'
  | 'max_reply_tokens'
  | 'n_candidates'
  | 'temperature'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'top_p';
type GenerationBoolKey = 'unlock_context_length' | 'stream';
type BehaviorBoolKey =
  | 'continue_prefill'
  | 'squash_system_messages'
  | 'enable_function_calling'
  | 'send_inline_media'
  | 'request_thinking';
type BehaviorSelectKey = 'name_behavior' | 'reasoning_effort' | 'verbosity' | 'structured_output';

const props = defineProps<{
  modelValue: EwFlowConfig;
  apiPresets: EwApiPreset[];
  index: number;
  expanded: boolean;
  busy: boolean;
  executing: boolean;
}>();
const emit = defineEmits<{
  (event: 'toggle-expand'): void;
  (event: 'execute'): void;
  (event: 'duplicate'): void;
  (event: 'remove'): void;
  (event: 'export'): void;
  (event: 'update:modelValue', value: EwFlowConfig): void;
}>();

const flow = computed(() => props.modelValue);

// "已展开过"模式：首次展开后保持 DOM 存活（v-show）
// 避免后续切换时重新挂载的开销。
const hasBeenExpanded = ref(props.expanded);
const deferredAdvancedReady = ref(props.expanded);
const deferredContextReady = ref(props.expanded);
const deferredPromptOrderReady = ref(props.expanded);
const deferredPostReady = ref(props.expanded);
const requestTemplateDraft = ref(props.modelValue.request_template);
let deferredMountFrameA: number | null = null;
let deferredMountFrameB: number | null = null;
let deferredMountFrameC: number | null = null;
let requestTemplateTimer: number | null = null;
let deferredPromptTimeout: number | null = null;
let deferredPostIdleId: number | null = null;

function clearDeferredMountFrames() {
  if (deferredMountFrameA !== null) {
    cancelAnimationFrame(deferredMountFrameA);
    deferredMountFrameA = null;
  }
  if (deferredMountFrameB !== null) {
    cancelAnimationFrame(deferredMountFrameB);
    deferredMountFrameB = null;
  }
  if (deferredMountFrameC !== null) {
    cancelAnimationFrame(deferredMountFrameC);
    deferredMountFrameC = null;
  }
  if (requestTemplateTimer !== null) {
    window.clearTimeout(requestTemplateTimer);
    requestTemplateTimer = null;
  }
  if (deferredPromptTimeout !== null) {
    window.clearTimeout(deferredPromptTimeout);
    deferredPromptTimeout = null;
  }
  if (deferredPostIdleId !== null) {
    if (typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(deferredPostIdleId);
    } else {
      window.clearTimeout(deferredPostIdleId);
    }
    deferredPostIdleId = null;
  }
}

function scheduleDeferredPostMount() {
  const run = () => {
    deferredPostIdleId = null;
    if (props.expanded) {
      deferredPostReady.value = true;
    }
  };

  if (typeof window.requestIdleCallback === 'function') {
    deferredPostIdleId = window.requestIdleCallback(run, { timeout: 240 });
    return;
  }

  deferredPostIdleId = window.setTimeout(run, 80);
}

function scheduleDeferredEditorsMount() {
  if (
    deferredAdvancedReady.value &&
    deferredContextReady.value &&
    deferredPromptOrderReady.value &&
    deferredPostReady.value
  )
    return;

  clearDeferredMountFrames();
  deferredMountFrameA = requestAnimationFrame(() => {
    deferredMountFrameA = null;
    if (props.expanded) {
      deferredAdvancedReady.value = true;
    }
    deferredMountFrameB = requestAnimationFrame(() => {
      deferredMountFrameB = null;
      if (props.expanded) {
        deferredContextReady.value = true;
      }
      deferredMountFrameC = requestAnimationFrame(() => {
        deferredMountFrameC = null;
        deferredPromptTimeout = window.setTimeout(() => {
          deferredPromptTimeout = null;
          if (props.expanded) {
            deferredPromptOrderReady.value = true;
          }
        }, 40);
        scheduleDeferredPostMount();
      });
    });
  });
}

watch(
  () => props.expanded,
  val => {
    if (!val) return;
    hasBeenExpanded.value = true;
    scheduleDeferredEditorsMount();
  },
);

watch(
  () => flow.value.request_template,
  value => {
    if (value !== requestTemplateDraft.value) {
      requestTemplateDraft.value = value;
    }
  },
);

onBeforeUnmount(() => {
  clearDeferredMountFrames();
});

const selectedPreset = computed(() => props.apiPresets.find(preset => preset.id === flow.value.api_preset_id) ?? null);
const endpointSummary = computed(() => {
  const preset = selectedPreset.value;
  if (!preset) {
    return '未绑定API配置';
  }
  const endpoint = preset.api_url.trim();
  const model = preset.model.trim() || '未选模型';
  if (!endpoint && !model) {
    return '未配置';
  }
  if (!endpoint) {
    return `URL未配置 / ${model}`;
  }
  const merged = `${endpoint} / ${model}`;
  return merged.length <= 72 ? merged : `${merged.slice(0, 69)}...`;
});
const presetLabel = computed(() => selectedPreset.value?.name?.trim() || '未绑定');
const floorIntervalLabel = computed(() => {
  const interval = Math.max(1, Math.trunc(Number(flow.value.run_every_n_floors ?? 1) || 1));
  return interval <= 1 ? '每个对应楼层都会自动执行' : `每 ${interval} 个对应楼层自动执行一次`;
});
const dynWriteOpen = ref(false);
const dynWriteModeLabel = computed(() => {
  if (flow.value.dyn_write.mode === 'add') {
    return '只增写入';
  }
  if (flow.value.dyn_write.mode === 'add_remove') {
    return '增减同步';
  }
  return '覆盖写入';
});
const dynActivationModeLabel = computed(() => {
  return flow.value.dyn_write.activation_mode === 'worldbook_direct' ? '直接世界书激活' : '控制器仓库';
});
const dynPositionTypeOptions = computed(() => {
  const defaults = [
    { value: 'before_character_definition', label: '放在角色设定前（最常用）' },
    { value: 'after_character_definition', label: '放在角色设定后' },
    { value: 'before_example_messages', label: '放在示例对话前' },
    { value: 'after_example_messages', label: '放在示例对话后' },
    { value: 'before_author_note', label: '放在作者注前' },
    { value: 'after_author_note', label: '放在作者注后' },
    { value: 'at_depth', label: '按聊天深度插入' },
    { value: 'at_depth_as_system', label: '按聊天深度插入（系统身份）' },
    { value: 'at_depth_as_assistant', label: '按聊天深度插入（助手身份）' },
    { value: 'at_depth_as_user', label: '按聊天深度插入（用户身份）' },
  ];
  const current = String(flow.value.dyn_write.profile.position.type ?? '').trim();
  if (!current || defaults.some(option => option.value === current)) {
    return defaults;
  }
  return [{ value: current, label: `当前自定义值：${current}` }, ...defaults];
});

function help(key: string) {
  return getFieldHelp(key);
}
function toggleDynWriteOpen() {
  dynWriteOpen.value = !dynWriteOpen.value;
}
function patch(partial: Partial<EwFlowConfig>) {
  emit('update:modelValue', { ...flow.value, ...partial });
}
function patchGeneration(partial: Partial<EwFlowConfig['generation_options']>) {
  patch({ generation_options: { ...flow.value.generation_options, ...partial } });
}
function patchBehavior(partial: Partial<EwFlowConfig['behavior_options']>) {
  patch({ behavior_options: { ...flow.value.behavior_options, ...partial } });
}
function patchDynWrite(partial: Partial<EwFlowConfig['dyn_write']>) {
  patch({ dyn_write: { ...flow.value.dyn_write, ...partial } });
}
function patchDynProfile(partial: Partial<EwFlowConfig['dyn_write']['profile']>) {
  patchDynWrite({ profile: { ...flow.value.dyn_write.profile, ...partial } });
}
function patchDynPosition(partial: Partial<EwFlowConfig['dyn_write']['profile']['position']>) {
  patchDynProfile({ position: { ...flow.value.dyn_write.profile.position, ...partial } });
}
function patchDynStrategy(partial: Partial<EwFlowConfig['dyn_write']['profile']['strategy']>) {
  patchDynProfile({ strategy: { ...flow.value.dyn_write.profile.strategy, ...partial } });
}
function patchDynSecondaryKeys(partial: Partial<EwFlowConfig['dyn_write']['profile']['strategy']['keys_secondary']>) {
  patchDynStrategy({
    keys_secondary: {
      ...flow.value.dyn_write.profile.strategy.keys_secondary,
      ...partial,
    },
  });
}
function patchDynEffect(partial: Partial<EwFlowConfig['dyn_write']['profile']['effect']>) {
  patchDynProfile({ effect: { ...flow.value.dyn_write.profile.effect, ...partial } });
}
function patchDynExtra(partial: Partial<EwFlowConfig['dyn_write']['profile']['extra']>) {
  patchDynProfile({ extra: { ...flow.value.dyn_write.profile.extra, ...partial } });
}
function updatePromptOrder(order: EwPromptOrderEntry[]) {
  patch({ prompt_order: order });
}
function toNumber(raw: string, fallback: number) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function toNullableInteger(raw: string, fallback: number | null) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(parsed));
}
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
function parseKeywordList(raw: string) {
  return raw
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}
function nullableNumberInput(value: number | null) {
  return value === null ? '' : String(value);
}
function toggleEnabled() {
  patch({ enabled: !flow.value.enabled });
}
function setText(
  key: 'name' | 'id' | 'request_template' | 'response_extract_regex' | 'response_remove_regex',
  event: Event,
) {
  patch({ [key]: (event.target as HTMLInputElement | HTMLTextAreaElement).value } as Partial<EwFlowConfig>);
}
function setRequestTemplateDraft(event: Event) {
  requestTemplateDraft.value = (event.target as HTMLTextAreaElement).value;
  if (requestTemplateTimer !== null) {
    window.clearTimeout(requestTemplateTimer);
  }
  requestTemplateTimer = window.setTimeout(() => {
    requestTemplateTimer = null;
    patch({ request_template: requestTemplateDraft.value });
  }, 160);
}
function setFlowNumber(key: FlowNumberKey, event: Event) {
  if (key === 'run_every_n_floors') {
    return patch({
      run_every_n_floors: Math.max(1, Math.trunc(toNumber((event.target as HTMLInputElement).value, 1))),
    });
  }
  patch({
    [key]: Math.trunc(toNumber((event.target as HTMLInputElement).value, flow.value[key] as number)),
  } as Partial<EwFlowConfig>);
}
function setApiPresetId(event: Event) {
  patch({ api_preset_id: (event.target as HTMLSelectElement).value });
}
function setTiming(event: Event) {
  patch({ timing: (event.target as HTMLSelectElement).value as 'default' | 'after_reply' | 'before_reply' });
}
const timingLabel = computed(() => {
  const global = ewStore.settings.workflow_timing;
  return global === 'before_reply' ? '回复前拦截' : '回复后更新';
});
function setGenerationNumber(key: GenerationNumberKey, event: Event) {
  const raw = toNumber((event.target as HTMLInputElement).value, flow.value.generation_options[key]);
  if (key === 'max_context_tokens') return patchGeneration({ max_context_tokens: Math.max(16000, Math.trunc(raw)) });
  if (key === 'max_reply_tokens') return patchGeneration({ max_reply_tokens: Math.max(1, Math.trunc(raw)) });
  if (key === 'n_candidates') return patchGeneration({ n_candidates: Math.max(1, Math.trunc(raw)) });
  if (key === 'temperature') return patchGeneration({ temperature: Number(clamp(raw, 0, 2).toFixed(4)) });
  if (key === 'frequency_penalty') return patchGeneration({ frequency_penalty: Number(clamp(raw, 0, 2).toFixed(4)) });
  if (key === 'presence_penalty') return patchGeneration({ presence_penalty: Number(clamp(raw, 0, 2).toFixed(4)) });
  return patchGeneration({ top_p: Number(clamp(raw, 0, 1).toFixed(4)) });
}
function setGenerationBool(key: GenerationBoolKey, event: Event) {
  patchGeneration({ [key]: (event.target as HTMLInputElement).checked } as Partial<EwFlowConfig['generation_options']>);
}
function setBehaviorToggle(key: BehaviorBoolKey) {
  patchBehavior({ [key]: !flow.value.behavior_options[key] } as Partial<EwFlowConfig['behavior_options']>);
}
function setBehaviorSelectByEvent(key: BehaviorSelectKey, event: Event) {
  patchBehavior({
    [key]: (event.target as HTMLSelectElement).value as EwFlowConfig['behavior_options'][typeof key],
  } as Partial<EwFlowConfig['behavior_options']>);
}
function setDynWriteMode(event: Event) {
  patchDynWrite({
    mode: (event.target as HTMLSelectElement).value as EwFlowConfig['dyn_write']['mode'],
  });
}
function setDynActivationMode(event: Event) {
  patchDynWrite({
    activation_mode: (event.target as HTMLSelectElement).value as EwFlowConfig['dyn_write']['activation_mode'],
  });
}
function setDynComment(event: Event) {
  patchDynProfile({ comment: (event.target as HTMLInputElement).value });
}
function setDynStrategyType(event: Event) {
  patchDynStrategy({ type: (event.target as HTMLInputElement).value });
}
function setDynScanDepth(event: Event) {
  patchDynStrategy({
    scan_depth: (event.target as HTMLInputElement).value as EwFlowConfig['dyn_write']['profile']['strategy']['scan_depth'],
  });
}
function setDynProbability(event: Event) {
  patchDynProfile({
    probability: Math.round(clamp(toNumber((event.target as HTMLInputElement).value, flow.value.dyn_write.profile.probability), 0, 100)),
  });
}
function setDynPositionType(event: Event) {
  patchDynPosition({ type: (event.target as HTMLInputElement).value });
}
function setDynPositionRole(event: Event) {
  patchDynPosition({
    role: (event.target as HTMLSelectElement).value as EwFlowConfig['dyn_write']['profile']['position']['role'],
  });
}
function setDynPositionDepth(event: Event) {
  patchDynPosition({
    depth: Math.max(0, Math.trunc(toNumber((event.target as HTMLInputElement).value, flow.value.dyn_write.profile.position.depth))),
  });
}
function setDynPositionOrder(event: Event) {
  patchDynPosition({
    order: Math.trunc(toNumber((event.target as HTMLInputElement).value, flow.value.dyn_write.profile.position.order)),
  });
}
function setDynPrimaryKeys(event: Event) {
  patchDynStrategy({ keys: parseKeywordList((event.target as HTMLTextAreaElement).value) });
}
function setDynSecondaryKeys(event: Event) {
  patchDynSecondaryKeys({ keys: parseKeywordList((event.target as HTMLTextAreaElement).value) });
}
function setDynSecondaryLogic(event: Event) {
  patchDynSecondaryKeys({
    logic: (event.target as HTMLSelectElement).value as EwFlowConfig['dyn_write']['profile']['strategy']['keys_secondary']['logic'],
  });
}
function setDynGroup(event: Event) {
  patchDynExtra({ group: (event.target as HTMLInputElement).value });
}
function setDynGroupWeight(event: Event) {
  patchDynExtra({
    groupWeight: toNumber((event.target as HTMLInputElement).value, flow.value.dyn_write.profile.extra.groupWeight),
  });
}
function setDynEffectSticky(event: Event) {
  patchDynEffect({
    sticky: toNullableInteger((event.target as HTMLInputElement).value, flow.value.dyn_write.profile.effect.sticky),
  });
}
function setDynEffectCooldown(event: Event) {
  patchDynEffect({
    cooldown: toNullableInteger((event.target as HTMLInputElement).value, flow.value.dyn_write.profile.effect.cooldown),
  });
}
function setDynEffectDelay(event: Event) {
  patchDynEffect({
    delay: toNullableInteger((event.target as HTMLInputElement).value, flow.value.dyn_write.profile.effect.delay),
  });
}
function toggleDynExtra(
  key: 'caseSensitive' | 'matchWholeWords' | 'groupOverride' | 'useGroupScoring',
) {
  patchDynExtra({ [key]: !flow.value.dyn_write.profile.extra[key] } as Partial<EwFlowConfig['dyn_write']['profile']['extra']>);
}

function addCustomRegex() {
  const nextRules = [
    ...flow.value.custom_regex_rules,
    {
      id: `regex_${simpleHash(`${flow.value.id}-${flow.value.custom_regex_rules.length}-${Date.now()}`)}`,
      name: '',
      enabled: true,
      find_regex: '',
      replace_string: '',
    },
  ];
  patch({ custom_regex_rules: nextRules });
}
function removeCustomRegex(index: number) {
  patch({ custom_regex_rules: flow.value.custom_regex_rules.filter((_, i) => i !== index) });
}
function setRegexEnabled(index: number, event: Event) {
  const nextRules = flow.value.custom_regex_rules.map((rule, i) =>
    i === index ? { ...rule, enabled: (event.target as HTMLInputElement).checked } : rule,
  );
  patch({ custom_regex_rules: nextRules });
}
function patchRegexText(index: number, key: 'name' | 'find_regex' | 'replace_string', event: Event) {
  const nextRules = flow.value.custom_regex_rules.map((rule, i) =>
    i === index ? { ...rule, [key]: (event.target as HTMLInputElement).value } : rule,
  );
  patch({ custom_regex_rules: nextRules });
}

// ── 单工作流导入 ──
const flowFileInput = ref<HTMLInputElement | null>(null);

function openFlowFilePicker() {
  flowFileInput.value?.click();
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    // 支持格式：EW 封装格式、ST 预设、或原始 flow 对象
    let validated: EwFlowConfig;
    if (parsed?.ew_flow_export === true && Array.isArray(parsed.flows)) {
      if (parsed.flows.length === 0) {
        toastr.warning('导出文件中没有工作流', 'Evolution World');
        return;
      }
      validated = EwFlowConfigSchema.parse(parsed.flows[0]);
    } else if (isSillyTavernPreset(parsed)) {
      const flowName = file.name.replace(/\.json$/i, '');
      const raw = convertStPresetToFlow(parsed, flowName);
      validated = EwFlowConfigSchema.parse(raw);
      toastr.info(`已识别为酒馆预设「${flowName}」并转换`, 'Evolution World');
    } else {
      validated = EwFlowConfigSchema.parse(parsed);
    }
    // 保留当前 flow 的 ID，以便就地覆盖
    validated.id = flow.value.id;
    emit('update:modelValue', validated);
    toastr.success('工作流已导入覆盖', 'Evolution World');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toastr.error(`导入失败: ${message}`, 'Evolution World');
  } finally {
    if (input) input.value = '';
  }
}

// ── 正则预览弹窗 ──
const showRegexModal = ref(false);

interface RegexPreviewItem {
  id: string;
  scriptName: string;
  findRegex: string;
  effectiveReplace: string;
  isBeautification: boolean;
  markdownOnly: boolean;
  placementLabel: string;
}

const regexPreviewList = ref<RegexPreviewItem[]>([]);

function openRegexPreview() {
  try {
    const placementNames: Record<number, string> = {
      0: '用户消息',
      1: 'AI消息',
      2: '斜杠命令',
      3: '世界书',
      4: '推理内容',
    };
    const scripts = collectAllRegexScripts();
    console.log('[EW] openRegexPreview collected', scripts.length, 'scripts');
    regexPreviewList.value = scripts.map(s => {
      const isBeau = isBeautificationReplace(s.replaceString);
      return {
        id: s.id,
        scriptName: s.scriptName,
        findRegex: s.findRegex,
        effectiveReplace: isBeau ? '（美化正则，EW中替换为空）' : s.replaceString || '（空 — 删除匹配内容）',
        isBeautification: isBeau,
        markdownOnly: s.markdownOnly,
        placementLabel: s.placement.map(p => placementNames[p] ?? `#${p}`).join(', ') || '无',
      };
    });
    showRegexModal.value = true;
  } catch (e) {
    console.error('[EW] openRegexPreview error:', e);
    toastr.error(`正则预览失败: ${e instanceof Error ? e.message : String(e)}`, 'Evolution World');
  }
}
</script>

<style scoped>
.ew-flow-card {
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 20%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 5%, rgba(10, 14, 20, 0.4));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  overflow: visible;
  transition:
    box-shadow 0.3s ease,
    border-color 0.3s ease,
    transform 0.3s ease;
}

.ew-flow-card:focus-within,
.ew-flow-card:hover {
  border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 35%, transparent);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  transform: translateY(-2px);
}

.ew-flow-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 1rem 1.1rem;
  border-radius: 12px 12px 0 0;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 10%, transparent);
}

.ew-flow-card__summary {
  min-width: 0;
  flex: 1 1 200px; /* Allow summary to shrink and wrap */
}

.ew-flow-card__name {
  display: block;
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1.25;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 98%, transparent);
  letter-spacing: 0.01em;
}

.ew-flow-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.5rem;
}

.ew-flow-card__chip {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 45%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 85%, transparent);
  font-size: 0.72rem;
  font-weight: 500;
  padding: 0.15rem 0.6rem;
}

.ew-flow-card__endpoint {
  margin: 0.5rem 0 0;
  font-size: 0.76rem;
  line-height: 1.35;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 65%, transparent);
  word-break: break-all;
}

.ew-flow-card__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.5rem;
  flex-shrink: 0; /* Prevent action buttons from being compressed */
}

.ew-flow-card__enabled {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 40%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  padding: 0.25rem 0.65rem;
}

.ew-flow-card__action {
  border-radius: 0.7rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 45%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 20%, transparent);

  .ew-flow-card__section--deferred {
    content-visibility: auto;
    contain-intrinsic-size: 320px;
  }

  color: var(--SmartThemeBodyColor, #edf2f9);
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.ew-flow-card__action:hover,
.ew-flow-card__action:focus-visible {
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 25%, transparent);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--ew-accent-glow);
  outline: none;
}

.ew-flow-card__action--primary {
  border-color: color-mix(in srgb, var(--ew-success) 40%, transparent);
  background: color-mix(in srgb, var(--ew-success) 14%, transparent);
  color: color-mix(in srgb, var(--ew-success) 92%, #fff);
}

.ew-flow-card__action--primary:hover,
.ew-flow-card__action--primary:focus-visible {
  border-color: var(--ew-success);
  background: color-mix(in srgb, var(--ew-success) 26%, transparent);
  color: #fff;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--ew-success) 28%, transparent);
}

.ew-flow-card__action[disabled] {
  opacity: 0.56;
  cursor: not-allowed;
  pointer-events: none;
  transform: none;
  box-shadow: none;
}

.ew-flow-card__action--danger {
  border-color: color-mix(in srgb, var(--ew-danger) 45%, transparent);
  background: color-mix(in srgb, var(--ew-danger) 15%, transparent);
  color: color-mix(in srgb, var(--ew-danger) 90%, #fff);
}

.ew-flow-card__action--danger:hover,
.ew-flow-card__action--danger:focus-visible {
  background: color-mix(in srgb, var(--ew-danger) 80%, transparent);
  border-color: var(--ew-danger);
  color: #fff;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--ew-danger) 30%, transparent);
}

.ew-flow-card__mini-toggle {
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 36%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 14%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 86%, transparent);
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.28rem 0.72rem;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    color 0.2s ease,
    transform 0.2s ease;
}

.ew-flow-card__mini-toggle:hover,
.ew-flow-card__mini-toggle:focus-visible {
  outline: none;
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 24%, transparent);
  color: #fff;
  transform: translateY(-1px);
}

.ew-flow-card__body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0 1.1rem 1.1rem;
  margin-top: 1rem;
}

.ew-flow-card__section {
  padding: 0.5rem 0 1rem;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 8%, transparent);
}

.ew-flow-card__section:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.ew-flow-card__section h4 {
  margin: 0 0 0.8rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 65%, transparent);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ew-flow-card__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  margin-bottom: 0.65rem;
}

.ew-flow-card__desc {
  margin: 0 0 0.65rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 70%, transparent);
}

.ew-flow-card__hint-text {
  margin: 0.3rem 0 0.5rem;
  font-size: 0.76rem;
  line-height: 1.4;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 65%, transparent);
}

.ew-flow-card__deferred-placeholder {
  border-radius: 0.82rem;
  border: 1px dashed color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 30%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 8%, rgba(8, 12, 18, 0.18));
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 62%, transparent);
  font-size: 0.78rem;
  padding: 0.8rem 0.9rem;
}

.ew-flow-card__subsection {
  border-radius: 0.8rem;
  border: 1px dashed color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 30%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 5%, rgba(0, 0, 0, 0.05));
  padding: 0.65rem 0.75rem;
  margin-bottom: 0.65rem;
}

.ew-flow-card__subsection h5 {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 90%, transparent);
}

.ew-flow-card__custom-regex-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0.6rem 0 0.4rem; /* Reduced top margin and added bottom space */
}

.ew-flow-card__custom-regex-head h6 {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 85%, transparent);
}

.ew-regex-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  position: relative;
}

.ew-regex-item {
  border-radius: 0.8rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 30%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 8%, rgba(0, 0, 0, 0.15));
  padding: 0.6rem 0.7rem;
}

.ew-regex-item__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.ew-regex-item__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 95%, transparent);
}

.ew-regex-item__body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.ew-grid {
  display: grid;
  gap: 0.75rem;
}

.ew-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* Toggle grid for behavior switches */
.ew-toggle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.65rem;
  margin-top: 0.85rem;
  padding: 0.75rem 0.85rem;
  border-radius: 0.85rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 20%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 5%, rgba(0, 0, 0, 0.08));
}

.ew-toggle-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.ew-toggle-item__label {
  font-size: 0.82rem;
  font-weight: 500;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 88%, transparent);
  white-space: nowrap;
}

/* Switch toggle — duplicated from App.vue because scoped CSS can't pierce child components */
.ew-switch {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  flex-shrink: 0;
}

.ew-switch__track {
  width: 2.8rem;
  height: 1.6rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 58%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 18%, rgba(7, 10, 15, 0.4));
  box-shadow:
    inset 0 1px 4px rgba(0, 0, 0, 0.35),
    0 0 0 1px rgba(255, 255, 255, 0.06);
  display: inline-flex;
  align-items: center;
  padding: 0.15rem;
  transition:
    border-color 0.3s ease,
    background 0.3s ease,
    box-shadow 0.3s ease;
}

.ew-switch__track[data-enabled='1'] {
  border-color: color-mix(in srgb, var(--ew-success) 65%, transparent);
  background: color-mix(in srgb, var(--ew-success) 45%, rgba(7, 10, 15, 0.4));
  box-shadow:
    inset 0 1px 4px rgba(0, 0, 0, 0.2),
    0 0 10px color-mix(in srgb, var(--ew-success) 25%, transparent);
}

.ew-switch__thumb {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--SmartThemeBodyColor, #eef3f9) 90%, transparent);
  box-shadow:
    0 2px 5px rgba(0, 0, 0, 0.45),
    0 0 0 1px rgba(0, 0, 0, 0.1);
  transform: translateX(0);
  transition:
    transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
    background 0.3s ease;
}

.ew-switch__track[data-enabled='1'] .ew-switch__thumb {
  transform: translateX(1.15rem);
  background: #ffffff;
}

.ew-switch:hover .ew-switch__track,
.ew-switch:focus-visible .ew-switch__track {
  border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 85%, transparent);
}

.ew-switch:focus-visible {
  outline: none;
}

/* ── Field-level slide toggle (slider variant) ── */
.ew-switch--field {
  gap: 0.6rem;
}
.ew-switch--field input {
  display: none;
}
.ew-switch__slider {
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.12);
  position: relative;
  transition: background 0.2s;
  flex-shrink: 0;
}
.ew-switch__slider::after {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #888;
  top: 2px;
  left: 2px;
  transition:
    transform 0.2s,
    background 0.2s;
}
.ew-switch--field input:checked + .ew-switch__slider {
  background: var(--ew-accent, #8b5cf6);
}
.ew-switch--field input:checked + .ew-switch__slider::after {
  transform: translateX(16px);
  background: #fff;
}
.ew-switch__label {
  font-size: 0.82rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 80%, transparent);
  user-select: none;
}

.ew-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 90%, transparent);
}

.ew-radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.ew-radio {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 40%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
}

.ew-range {
  display: grid;
  grid-template-columns: 1fr 6.4rem;
  align-items: center;
  gap: 0.6rem;
}

.ew-check-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.2rem 0;
}

.ew-subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.ew-subhead h5 {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 95%, transparent);
}

.ew-subhead h6 {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 90%, transparent);
}

.ew-inline {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

.ew-empty {
  border-radius: 0.8rem;
  border: 1px dashed color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 45%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 10%, rgba(8, 12, 18, 0.2));
  padding: 0.65rem 0.75rem;
  font-size: 0.82rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 80%, transparent);
}

.ew-prompt-list {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  position: relative;
}

.ew-prompt-item {
  border-radius: 0.85rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 35%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 8%, rgba(0, 0, 0, 0.18));
  padding: 0.6rem;
}

.ew-prompt-item__head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto auto;
  align-items: center;
  gap: 0.5rem;
}

.ew-prompt-item__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 98%, transparent);
}

.ew-prompt-item__body {
  margin-top: 0.65rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.ew-mini-btn {
  border-radius: 0.6rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 45%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
  color: var(--SmartThemeBodyColor, #edf2f9);
  font-size: 0.7rem;
  padding: 0.2rem 0.5rem;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.ew-mini-btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.ew-mini-btn:hover:not([disabled]) {
  border-color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 25%, transparent);
  color: #fff;
  transform: translateY(-1px);
}

.ew-mini-btn--danger {
  border-color: color-mix(in srgb, var(--ew-danger) 45%, transparent);
  background: color-mix(in srgb, var(--ew-danger) 15%, transparent);
}

.ew-mini-btn--danger:hover:not([disabled]) {
  background: color-mix(in srgb, var(--ew-danger) 80%, transparent);
  border-color: var(--ew-danger);
  color: #fff;
}

.ew-expand-enter-active,
.ew-expand-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  transform-origin: top center;
}

.ew-expand-enter-from,
.ew-expand-leave-to {
  opacity: 0;
  transform: translateY(-8px) scaleY(0.98);
}

@supports not ((backdrop-filter: blur(1px))) {
  .ew-flow-card__header {
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #2f4158) 18%, rgba(10, 14, 20, 0.98));
  }
}

@media (max-width: 1200px) {
  .ew-prompt-item__head {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .ew-prompt-item__controls {
    grid-column: 1 / -1;
    margin-top: 0.5rem;
  }
}

@media (max-width: 900px) {
  .ew-flow-card {
    transition:
      box-shadow 0.3s ease,
      border-color 0.3s ease,
      margin 0.35s cubic-bezier(0.4, 0, 0.2, 1),
      border-radius 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .ew-flow-card__header {
    flex-direction: column;
  }
  .ew-flow-card__actions {
    width: 100%;
    justify-content: flex-start;
  }
  /* 展开时左右撑满 — 跳出父容器 0.9rem padding */
  .ew-flow-card[data-expanded='1'] {
    margin-left: -0.9rem;
    margin-right: -0.9rem;
    width: calc(100% + 1.8rem);
    border-radius: 4px;
    border-left: none;
    border-right: none;
  }
  .ew-flow-card[data-expanded='1']:hover,
  .ew-flow-card[data-expanded='1']:focus-within {
    transform: none;
  }
  .ew-grid--two {
    grid-template-columns: 1fr;
  }
  .ew-range {
    grid-template-columns: 1fr;
  }
  .ew-toggle-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 0.5rem;
    padding: 0.55rem 0.65rem;
  }
  .ew-flow-card__body {
    padding: 0 0.65rem 0.65rem;
  }
  .ew-flow-card__subsection {
    padding: 0.5rem 0.55rem;
  }
  .ew-flow-card__action {
    font-size: 0.72rem;
    padding: 0.3rem 0.55rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ew-flow-card,
  .ew-flow-card__action,
  .ew-mini-btn,
  .ew-expand-enter-active,
  .ew-expand-leave-active {
    transition: none;
  }
}

.ew-mini-btn--info {
  border-color: color-mix(in srgb, var(--ew-accent) 50%, transparent);
  color: var(--ew-accent);
  background: color-mix(in srgb, var(--ew-accent) 12%, transparent);
}

.ew-mini-btn--info:hover {
  background: color-mix(in srgb, var(--ew-accent) 25%, transparent);
  color: #fff;
}
</style>

<!-- 弹窗样式需要 unscoped，因为 Teleport 渲染在 body 下 -->
<style>
.ew-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}

.ew-modal--regex {
  width: min(640px, 90vw);
  max-height: 80vh;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 30%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 8%, rgba(12, 16, 24, 0.95));
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ew-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 15%, transparent);
}

.ew-modal__header h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 95%, transparent);
}

.ew-modal__close {
  border: none;
  background: none;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 60%, transparent);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  transition:
    background 0.2s,
    color 0.2s;
}

.ew-modal__close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.ew-modal__body {
  padding: 0.85rem 1rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ew-regex-preview-item {
  border-radius: 0.7rem;
  border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 22%, transparent);
  background: color-mix(in srgb, var(--SmartThemeQuoteColor, #7f92ab) 6%, rgba(0, 0, 0, 0.12));
  padding: 0.55rem 0.7rem;
}

.ew-regex-preview-item__head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  margin-bottom: 0.35rem;
}

.ew-regex-preview-item__index {
  font-size: 0.72rem;
  font-weight: 700;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 50%, transparent);
  min-width: 1.6rem;
}

.ew-regex-preview-item__name {
  font-size: 0.82rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 92%, transparent);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ew-regex-preview-item__badge {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  white-space: nowrap;
}

.ew-regex-preview-item__badge--transform {
  background: color-mix(in srgb, var(--ew-success) 20%, transparent);
  color: var(--ew-success);
  border: 1px solid color-mix(in srgb, var(--ew-success) 35%, transparent);
}

.ew-regex-preview-item__badge--beauty {
  background: color-mix(in srgb, #f59e0b 20%, transparent);
  color: #f59e0b;
  border: 1px solid color-mix(in srgb, #f59e0b 35%, transparent);
}

.ew-regex-preview-item__badge--skip {
  background: color-mix(in srgb, #6b7280 20%, transparent);
  color: #9ca3af;
  border: 1px solid color-mix(in srgb, #6b7280 30%, transparent);
}

.ew-regex-preview-item__details {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.ew-regex-preview-item__row {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  font-size: 0.76rem;
  line-height: 1.4;
}

.ew-regex-preview-item__label {
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 55%, transparent);
  min-width: 2.5rem;
  flex-shrink: 0;
}

.ew-regex-preview-item__row code {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: rgba(255, 255, 255, 0.06);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  word-break: break-all;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #edf2f9) 80%, transparent);
}

/* Modal transition */
.ew-modal-enter-active,
.ew-modal-leave-active {
  transition: opacity 0.25s ease;
}
.ew-modal-enter-active .ew-modal--regex,
.ew-modal-leave-active .ew-modal--regex {
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ew-modal-enter-from,
.ew-modal-leave-to {
  opacity: 0;
}
.ew-modal-enter-from .ew-modal--regex {
  transform: scale(0.92) translateY(10px);
}
.ew-modal-leave-to .ew-modal--regex {
  transform: scale(0.96) translateY(5px);
}

/* 弹窗移动端适配 */
@media (max-width: 640px) {
  .ew-modal--regex {
    width: 100vw;
    max-height: 100vh;
    border-radius: 0;
    border: none;
  }
  .ew-modal__header {
    padding: 0.7rem 0.85rem;
  }
  .ew-modal__header h3 {
    font-size: 0.88rem;
  }
  .ew-modal__body {
    padding: 0.65rem 0.75rem;
  }
  .ew-regex-preview-item__row {
    flex-direction: column;
    gap: 0.15rem;
  }
  .ew-regex-preview-item__row code {
    font-size: 0.68rem;
  }
}
</style>
