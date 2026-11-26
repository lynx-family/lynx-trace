# Lynx Trace 内存分析原型

本文定义 Lynx Trace 内存分析的功能，覆盖内存分析 Skill、Query API、主报告，以及与 `js-memory-analyzer` 的协作。

**源码准备与交付决策约束：** 内存分析入口及最终交付均遵守
[source-preparation](../references/source-preparation.md)。Agent 为业务与 Lynx 分别保存准备
结果或用户原话，使用 `--source-preparation` 传入 CLI。缺少 Lynx 输入时先自动解析 Trace
版本、查询远端并构建；失败后询问缺少的源码／revision，不能只在报告中写“未准备”。
成功准备不额外征求构建许可。

**Trace 版本下限为 `4.5.0`：** 相关 Trace 内存分析能力从 Lynx 4.5 才加入。Trace 读取到的
版本小于 `4.5.0` 时，一律认为非法，即使拼接的 tag 存在，也按 tag 不存在进入源码／revision
恢复交互。不得因此自动升级、构建旧 tag 或默认放弃源码辅助。`4.5.0` 本身可用，版本按数字
比较；这条下限适用于 Trace 自动选择，用户明确提供的源码／revision 仍优先。

快照绑定发现前端实际冲突时，诊断 config 中环境变量、条件分支和构建参数并展示依据，
随后等待用户选择终止、放弃受影响产物辅助或提供明确产物地址。替换仍失败则继续这一循环。
独立提供工程与产物时默认不构建，始终按 Trace → 指定 JS → map → 指定原始工程定位。
缺 location、map、未引用变体等证据缺口与明确冲突分开处理。

决策由 Trace 调用方负责；`js-memory-analyzer` 只返回预检事实，
不得由“忽略源码继续分析”、`unresolved`、`skipped` 或最终报告免责声明替代用户选择。
预报告用于快照检查，定稿与导入必须检查准备记录、manifest digest 与已复核快照哈希。

页面 BTS 泄漏分析使用 **销毁页面的 BTS residual 快照序列**。BTS 堆大小图展示 slot 内存分布，VM 整体分析包括销毁状态和 GC 后 Accumulate 趋势。图形分析展示页面 Graphic 组件内存分项、Canvas 资源计数，以及进程级 Krypton 资源内存和计数。

目录：

- [1. 文档定位与职责](#1-文档定位与职责)
- [2. 概念与统一约定](#2-概念与统一约定)
- [3. Trace 数据协议](#3-trace-数据协议)
- [4. 分析入口与数据准备](#4-分析入口与数据准备)
- [5. 页面内存分析](#5-页面内存分析)
- [6. 趋势判定](#6-趋势判定)
- [7. BTS 虚拟机整体观察](#7-bts-虚拟机整体观察)
- [8. 销毁页面的 BTS residual 分析](#8-销毁页面的-bts-residual-分析)
- [9. 报告与用户交互](#9-报告与用户交互)
- [10. Query API 与报告数据契约](#10-query-api-与报告数据契约)
- [11. 验收场景](#11-验收场景)

## 1. 文档定位与职责

### 1.1 维护关系

后续功能变更按以下关系维护：

1. **原型文档**定义问题、数据语义、分析规则、交互、输出和验收条件。
2. **内存分析 Skill**定义 Agent 的执行流程、命令调用、结论解释和必要的用户交互。
3. **Query API**完成确定性工作：Trace 解码、身份关联、数据聚合、数值计算和快照提取。
4. **报告生成器**依据结构化结果绘制图表、展示证据、过滤内容、嵌入子报告和汇总结论。
5. **js-memory-analyzer**分析堆对象、保活关系、生命周期违约和必要的源码证据，生成页面泄漏分析子报告。

功能变更时，在同一变更中维护原型、Skill 和相关代码；由文档生成的 Skill 副本及 Agent prompt 也应同步。本文完整定义功能规则，指导实现和验收。

### 1.2 分析原则

- 数值、生命周期、VM generation、阈值和图表数据由 Query API 计算，Agent 不手工从零散 SQL 重建。
- 进程 PSS、VM RSS、VM Accumulate、slot 残留和快照对象大小分别报告，不互相替代。
- 只有 `js-memory-analyzer` 的明确泄漏结论才能产生页面 BTS 泄漏标记和确认泄漏计数。
- 稳定残留、对象增长、保活路径、疑似未释放和确认泄漏是不同结论，不能自动升级。
- 数据缺失、身份不明、分析尚未执行、被豁免，与内存为零或没有发现问题分别表达。
- 主报告是完整证据入口，聊天只给关键结论和报告链接。快照原文保存在本地文件，不放入对话或报告。

## 2. 概念与统一约定

### 2.1 页面、虚拟机与 slot

| 概念 | 定义 |
| --- | --- |
| 页面实例 | 由 `instance_id` 标识的一次 Lynx 页面运行；同一 URL 可以有多个实例 |
| MTS | 主线程脚本虚拟机，页面独享 |
| BTS | 后台线程脚本虚拟机，可为页面独享，也可由多个页面共享 VM；共享 VM 内可使用共享或独立页面 context |
| 无 Runtime 页面 | 没有 BTS Runtime 的页面，仍可分析 PSS、MTS、组件数量等数据 |
| 共享 VM 组 | `page_uses_bts_vm.group_id` 不为 `"-1"`；只被一个页面使用也属于共享组；该字段不能单独区分 context 模式 |
| VM generation | 同名 BTS VM 销毁后再次创建的代次，从 0 开始，不能只用名称区分 VM 实例 |
| slot | BTS 内存分槽编号，范围为 0～255；0 为 unknown，1 为 common，2 为 overflow，3～255 为页面专用槽位 |

页面专用 slot 在所属 VM generation 内不因页面销毁而重新分配。专用槽位耗尽后，新页面使用 overflow。slot 0、1、2 的内存不能全部归因到某一个页面。

页面销毁、页面在 BTS 线程销毁、BTS VM 销毁是三个不同事实；共享 BTS VM 可以在其中某个页面退出后继续存活。

共享 VM 有两种 context 模式：

1. **共享 VM、共享 context**：公共 context 加载 `lynx_core.js` 等公共 JS，多个页面在该 context 中运行。`sharedData` 等公共数据挂在这个 context 的 `globalThis` 上。
2. **共享 VM、页面独立 context**：公共 context 加载 `lynx_core.js` 并暴露接口；页面 A、B 分别创建 contextA、contextB。`sharedData` 仍挂在公共 context 的全局对象上；销毁页面 context 不会销毁公共 context，公共 context 随 VM 销毁。

两种模式都可能让页面创建的对象、闭包、模块或字符串经 VM 级缓存继续存活。缓存自身生命周期合理，不代表缓存内容没有页面退出后的释放责任；反之，仅看到缓存持有关系也不能直接判泄漏。需区分缓存条目、缓存键、monitor 元数据、闭包捕获内容与引擎共同持有，并结合写入／移除／上限约定核实。

源码背景可从 `lynx/js_libraries/lynx-core/src/app/app.ts` 所在模块核实：`common/nativeGlobal.ts` 初始化公共 `sharedData`，`lynx/lynx.ts` 写入 sharedData；`BaseApp` 的 `_$factoryCache`、`_$loadScriptCache` 和 `moduleCacheMonitor` 为静态状态。`moduleCacheMonitor.ts` 是缓存追踪旁表，记录 key／creator 等元数据，不应把其所有保活量解释成模块 exports 大小。源码版本需与快照对齐；背景说明不代替版本证据。

### 2.2 内存口径

| 口径 | 含义与获取方式 | 使用边界 |
| --- | --- | --- |
| 进程 PSS | `summary.total-pss` 的 counter 值 | 包括进程中其它页面和非 Lynx 内存，不能直接等同于某页面或 JS 引擎 |
| VM Accumulate | JS 对象、字符串及相关分配的累计内存统计；QuickJS 使用 `malloc_size` | BTS 总量来自匹配的 `bts_vm_acc_*` 轨道 |
| VM RSS | `base_usage + page_rss_usage` | 包含引擎基础内存和驻留页；GC 后仍高不单独证明泄漏 |
| slot counter 值 | `bts_vm_acc_*` 样本中的 `slot_x` | 用于分槽图及辅助观察，不直接触发页面泄漏结论 |
| residual 采集后残留 | `capture_snapshot.retained_bytes` | 对应这次快照采集完成后的目标 slot 残留 |
| 对象浅层／保留大小 | analyzer 输出的 `self_size`／`retained_size` | 受引擎格式与图覆盖范围影响，不直接等于 PSS、RSS 或整个 slot 的残留 |
| 页面 Graphic 组件内存 | 去重后的 CanvasApp `detail.krypton.*.bytes` 分项，加上 AnimaX 类别的 `sizeBytes` | 资源统计／估算值；Canvas 按 App 去重，AnimaX 按组件类别使用已聚合值，不与 PSS／VM 内存相加 |
| 进程 Krypton 资源内存 | 同一进程内 `Krypton` 前缀且以 `Mem` 结尾的 counter | 进程范围、事件驱动；`KryptonTotalMemEst` 仅作总量核对，不作为堆叠分项，也不直接归因到页面 |

QuickJS 的 GC 模式中，`page_rss_usage` 是驻留 GC 页内存；RC 模式中通常对应对象堆分配内存。两者均按上述统一公式读取，不用 GC／RC 分支重写内存公式。

当前 VM 内存统计支持 `quickjs(gc)` 和 `quickjs(rc)`。其它引擎不输出不具备依据的 VM 数值，但可继续展示进程数据；其快照能否分析由 analyzer 的格式能力独立判断。

### 2.3 单位、排序与边界

- 原始 Trace 时间戳为纳秒。Query API 的时间参数和结构化时间字段统一使用 **Trace 时间轴上的绝对毫秒**，字段名以 `TsMs` 等明确单位。
- 报告可同时显示“相对 Trace 起点”的时间，但不得把相对值直接传给要求绝对时间的接口。
- 内存基础单位为 byte。展示使用 `KiB = 1024 B`、`MiB = 1024 KiB`，不把 MiB 阈值写成十进制 MB。
- 事件按时间、slice ID 排序；counter 样本按时间、counter ID 排序。同一时间的候选取排序后的最后一条。
- 非 INSTANT 事件具有开始 `ts` 和结束 `ts + dur`。持续时间缺失或为负时，结束时间未知，不伪造销毁或 GC 完成。
- 查询时刻 `t` 的 counter 值，取时间 `<= t` 的最后一个有效样本；该值在下一样本到来前有效。查询区间截断到 Trace 和对象的观察范围。
- VM 内存查询通过 `available`、源样本 ID 和时间表达数据可用性；缺少样本或绑定不唯一时说明原因。内部绘图所需的补零或延长区间不构成新的测量证据。

### 2.4 参数表

| 参数 | 数值 | 用途 |
| --- | ---: | --- |
| 页面创建前移量 | 200 ms | 纳入 `LynxShell::Create` 前已创建的平台对象 |
| 全局 GC 结束后的等待量 | 10 ms | PSS 回落观察起点 |
| 退出后最长观察时间 | 5 s | 查找退出后 PSS 最低值 |
| 同组页面窗口 | 2 s | 页面创建与销毁时间的分组容差 |
| 重叠页面独立加载观察窗口 | 严格大于 3 s | 允许给出中置信度加载峰值 |
| 高内存页面阈值 | 严格大于 150 MiB | 加载阶段 PSS 峰值增量 |
| PSS 明显残留参考值 | 至少 2 MiB | 描述退出后水位，不直接判定 JS 泄漏 |
| MTS 缓存池增长阈值 | 严格大于 3 MiB RSS | 缓存池增长异常 |
| VM 在 Trace 内创建的判别间隔 | 严格晚于 Trace 起点 100 ms | 依据 BTS 轨道首个样本判断 |
| VM GC 趋势最少样本数 | 3 | 对应第 6 节的稀疏样本规则 |
| 滚动趋势最少样本数 | 10 | 对应第 6 节的密集样本规则 |

页面 residual 分析根据对象和生命周期证据判定泄漏，不要求后续至少加载若干页面。20% 是快照采集触发条件之一，不是分析器的泄漏阈值。

## 3. Trace 数据协议

### 3.1 配置和事件字段

下表使用逻辑字段名；Perfetto 参数表中通常带 `debug.` 前缀。解析器可归一化已知的 `debug.`、`args.` 前缀，但应保留原始字段来源供定位。

| 事件 | 主要字段 | 时间语义与用途 |
| --- | --- | --- |
| `TRACE_BEGIN` | `enable_memory_trace` | 内存采集入口校验，值为 `true` 或 `1` 表示启用 |
| `LynxShell::Create` | `instance_id`，可选 `url` | 开始时间作为页面 Shell 创建时间 |
| `LynxShell::~LynxShell` | `instance_id` | 结束时间作为页面 Shell 销毁时间 |
| `page_uses_mts_vm` | `instance_id`、`desc`，可选 `url` | 页面与 MTS 的关联 |
| `page_uses_bts_vm` | `instance_id`、`group_id`、`ptr`、`desc`，可选 `url`、`slot` | 事件时间作为页面 BTS 生命周期起点，同时建立页面／VM／slot 关系 |
| `BTSRuntime::Destroy` | `instance_id` | 结束时间作为页面 BTS 生命周期终点 |
| `destroy_vm_instance` | `ptr` | 事件时间作为 BTS VM generation 的销毁时间 |
| `RunGC` | 全局强制回收事件 | 非 INSTANT；PSS 使用其结束时间加 10 ms |
| `VM_GC` | `ptr` | 归属到该指针在事件完成时刻对应的 VM generation；用于 VM 趋势和图中 GC 线 |
| `mts_vm_pool_state` | `pool_instance_id`、`is_global_pool`、`url`、`destroyed`、`id_*` | MTS 缓存池状态 |
| `bts_vm_pool_state` | `id_*` 等池状态 | BTS 缓存池辅助数据 |
| `capture_snapshot` | 见 3.5 节 | 一次快照采集记录 |
| `snapshot_chunk` | 见 3.6 节 | 一次快照的内容分块 |

`enable_memory_trace` 开启后，强制回收及页面退出 residual 采集属于默认行为。

默认行为不等于每条 Trace 都有完整事件。具体 PSS 回落和 VM 趋势仍需检查实际 GC 事件及其样本；residual 分析不要求再找到一个匹配的 GC 事件才可执行。

### 3.2 VM 类型、名称与 URL

`desc` 可为引擎类型字符串，也可为 JSON 字符串。若是合法 JSON 且其中 `vm_type` 为字符串，取 `vm_type`；否则保留原描述并判断是否属于支持类型。无法解析时给出数据说明。

- MTS 通过 `instance_id` 关联页面。
- 共享 BTS 名称取 `group_id`。
- 页面独享 BTS 使用可区分页面的名称，例如 `standalone_<instance_id>`。
- BTS 的 `ptr` 是运行时关联键，应结合 generation 和事件时间使用，不能将指针复用视为同一 VM。

页面 URL 按以下顺序补全，优先使用同一实例内最早的非空记录：

1. `LynxShell::Create` 中的 URL。
2. 模板加载事件中的 URL：`LynxView::loadTemplateBundle`、`LynxTemplateRender::loadTemplateBundle`、`LynxDevtool::onLoadFromBundle`、`LynxEngine::LoadTemplateBundle`、`LynxLoadTemplate`、`TemplateAssembler::OnJSPrepared`、`NativeFacadeDarwin::OnTemplateLoaded`、`LynxViewLifecycle::didLoadFinishedWithUrl`。
3. 页面 VM 关联等携带同一 `instance_id` 的事件中的 URL。
4. `memory_<instance_id>` 样本中的 URL。

没有 URL 时仍使用 `instance_id` 展示。URL 用于选择、展示和重复加载编号，不代替页面身份。

### 3.3 Counter 轨道

#### 页面轨道 `memory_<instance_id>`

counter 值是页面上报的总内存统计，用于判断页面存在及辅助展示，不代替进程 PSS，也不作为共享 BTS 的权威内存来源。页面退出时上报的 0 只说明页面统计归零，不证明共享 VM 或该页面的 slot 已释放。

参数中的类别对象为 JSON：

| 类别／字段 | 含义 |
| --- | --- |
| `mainThreadScriptingEngine.sizeBytes` | MTS Accumulate |
| `mainThreadScriptingEngine.detail.base_usage` | MTS 引擎基础内存 |
| `mainThreadScriptingEngine.detail.page_rss_usage` | MTS 驻留页内存 |
| `backgroundThreadScriptingEngine` | BTS 关联及辅助统计；BTS 内存统一从其专属轨道读取 |
| 其它 Lynx UI View 类别的 `instanceCount` | 对应类别的组件数量 |
| Canvas 类别的 `detail.krypton.*` | CanvasApp 的资源内存／数量快照；按下述规则去重并区分 bytes 与 count |
| AnimaX 类别的 `sizeBytes` | 该类别各 AnimaXPlayer 内存估算值之和 |

组件序列排除脚本引擎类别和 `lynxTasmElement`。除下述已明确口径的 AnimaX 估算值外，不把普通组件 JSON 的 `sizeBytes` 当作可信的资源内存；Canvas 的累加 `sizeBytes` 不用于图形内存面积图。

##### Graphic 组件识别与页面数据

- 以组件 JSON 的 `category` 为组件名称，忽略大小写，名称包含 `canvas` 或 `animax` 即为 Graphic 组件。只有 `category` 缺失时，才使用去掉已知参数前缀的类别 key；保留原始名称和来源。
- 页面在可观察生命周期内出现过 Graphic 类别即标记为含 Graphic 组件，识别不要求内存大于零或每条样本都携带该类别。Canvas 页面单独按名称包含 `canvas` 识别；`krypton.*` 是其资源字段，不另计一个 UI 组件。
- 同一页面正常使用同一个 CanvasApp。每个 Canvas UI 都读取同一 App 的 recorder；iOS 的单组件返回值还包含该 UI 的 `malloc_size`。类别聚合会累加 `sizeBytes`／`instanceCount`，但 `detail` 按 key 覆盖合并。因此既不能累加同一 App 的重复明细，也不能用 `sizeBytes / instanceCount` 代替资源分项。
- Canvas 去重范围是所属进程和页面中的 CanvasApp。Trace 提供明确 App 身份时按该身份去重；标准的单 App 页面按页面关联去重，不能仅因不同页面数值相同就跨页面合并。同一 App 经多个 Canvas 类别重复出现时，每个资源 key 只取一份；相同样本中的重复字段值冲突且不能确定来源时，将冲突字段标为不可用，不求和、不取最大值。若能验证存在多个独立 App，则先分别去重，再按相同资源 key 汇总；无法辨认多个 App 时保留归属歧义。
- `detail` 的数值可能是 JSON number 或十进制数值字符串。bytes 读取 `krypton.` 前缀且以 `.bytes` 结尾的字段；counts 读取以 `.count` 结尾的字段，并显式包含 `krypton.total.object_count`。数值须为有限非负整数；缺失、空值、不可解析或负值保留原值和不可用原因，不强制转为零。
- `krypton.total.estimated_bytes` 是 App 总估算量，只用于 tooltip 中的独立核对值。它不属于 bytes 堆叠分项；不再叠加总量，不将差额编成一个资源分项，不缩放分项以强行对齐总量。分项可能不覆盖全部统计，总量与分项还可能因分开读取而不同。
- AnimaX 每个组件通常拥有自己的 Player。类别 `sizeBytes` 已累加所有该类 Player 的估算值，每个类别直接计入一次，不再乘除 `instanceCount`。图例使用完整组件名称，例如 `animax-view`；多个不同 AnimaX 类别分别绘制。
- AnimaX 估算基于图片、视频纹理、视频缓存、Mask／Matte、屏幕缓冲及固定开销。其内部细项没有作为组件 `detail` 上报时，不自行还原或拆分；初始零值可能表示尚未估算。相关实现仅在渲染缩放系数变化时重新计算，读取组件接口只返回缓存值，不能将曲线恒定解释为实际内存恒定。

已知 Canvas bytes 字段如下；后续版本出现新的合法 `krypton.*.bytes` 时按原 key 保留，不局限于白名单：

| 字段 | 资源 |
| --- | --- |
| `krypton.canvas_element.bytes` | Canvas |
| `krypton.image_element.bytes` | Image |
| `krypton.webgl_texture.bytes` | WebGL Texture |
| `krypton.webgl_buffer.bytes` | WebGL Buffer |
| `krypton.webgl_renderbuffer.bytes` | WebGL Renderbuffer |
| `krypton.external_data.bytes` | External Data |
| `krypton.audio_buffer.bytes` | Audio Buffer |
| `krypton.audio_sampler.bytes` | Audio Sampler |

页面 `memory_N` 可能随其它类别更新而重复携带缓存的 Canvas／AnimaX 数据，counter 时间不等于图形资源重新采样时间。保留源样本 ID 和时间；重复值不构成新的独立资源测量证据。缺少 Canvas bytes 明细时说明无法分解，仍可展示可用的 AnimaX 分项或 Canvas counts，不回退到重复累计的 Canvas `sizeBytes`。

源码语义参考：Canvas App 统计见 [c7724809](https://code.byted.org/lynx/template-assembler/commit/c7724809ce2a890bdec51031b3ed786d08345dbd)，音频字段扩展见 [ad47499d](https://code.byted.org/lynx/template-assembler/commit/ad47499dd92fcf2221d74792e34311400e62582f)，AnimaX 估算见 [b1a2538d](https://code.byted.org/lynx/template-assembler/commit/b1a2538dbbda46190f48f940cacf99eb4c9dcf95)。这些引用用于解释统计来源，不把示例版本常量硬编码为分析端计算公式。

#### BTS 轨道 `bts_vm_acc_<vm_unique_id>`

- counter 值是 VM Accumulate。
- 参数 `ptr` 用于 VM 绑定。
- `base_usage + page_rss_usage` 是 VM RSS。
- `slot_0`～`slot_255` 是各 slot 的内存值。
- 后缀为该轨道的唯一标识，不解释为页面 `instance_id` 或 VM 名称。标识按字符串保存。
- VM 销毁时追加的零样本是轨道数据的一部分。

#### 进程轨道 `summary.total-pss`

counter 值是进程 PSS。通过页面所属进程选择轨道；只有一个可用进程轨道时可采用唯一候选。多进程场景无法确定归属时说明歧义，不能把其它进程的 PSS 归因给目标页面。

不假定固定采样间隔，图表和计算使用实际样本时间。

#### 进程轨道 `Krypton*`

- 以所属进程和 track ID 保存轨道身份。名称以 `Krypton` 开头且以 `Mem` 结尾的轨道为 bytes 分项，例如 `KryptonCanvasMem`、`KryptonWebGLTextureMem`；以 `Cnt` 结尾的轨道为资源计数，包括 `KryptonTotalObjCnt`、`KryptonWebGLObjectCnt` 和 `KryptonTotalSurfaceCnt`。
- `KryptonTotalMemEst` 不以 `Mem` 结尾，是独立总估算量，只用于核对；其它未知后缀不能仅因名称包含 `Mem`／`Count` 就推断单位。counts 总计和子项可能重叠，分别画线，不求和。
- 全局 helper 保存进程级资源增减，并在 Trace 开启时输出 counter；App recorder 独立记账。全局轨道不带可直接用于页面归因的身份，不能用来填充某页缺失的 Canvas 明细，也不包含 AnimaX 自身的 Player 估算。
- GL surface 在已核实实现中只更新全局计数，App 的 `krypton.gl_surface.count` 可以仍为零。全局值与页面 App 明细不要求逐点相等，也不要求全局值等于页面明细之和。
- 轨道按各自真实样本时间保持到下一样本，首个有效样本之前为未上报，末值可延长到 Trace 结束。多个轨道用时间戳并集和各自 `<= t` 的最新有效样本对齐，不因其它轨道更新就将未更新轨道置零。
- 多进程分别展示，不混合堆叠；同一进程存在同名候选轨道而不能确定是否重复统计时，将该分项标为歧义并保留候选 track ID，其它可用分项继续展示。

### 3.4 虚拟机缓存池

每个 `id_*` 参数表示一台缓存中的 VM，内容为 JSON，其中 `acc_usage` 是 Accumulate，`base_usage + page_rss_usage` 是 RSS。有效条目数为引擎实例数量。

查询时刻 `t` 的 MTS 池状态：

1. 对每个 `pool_instance_id`，选取 `ts <= t` 的最新状态；相同时间按 slice ID 决定先后。
2. 排除最新状态中 `destroyed=1` 的池。
3. `is_global_pool=1` 的池归入 `global_pool`；其它池按 URL 汇总，URL 为空使用 `Unknown URL`。
4. 每个 URL 汇总引擎实例数、Accumulate 和 RSS；总量为所有活跃池之和。

单条损坏数据不应导致其它池全部丢失，但必须说明该部分未计入。BTS 池读取查询时刻之前最新的有效状态，作为辅助数据展示。

### 3.5 快照身份与元数据

`id` 表示快照范围，同一 `id` 可多次采集；`snapshot_id` 唯一标识一份采集结果。不得按 `id` 去重掉同一页面后续的 residual。

| `id` 格式 | 快照范围 | 关联方式 |
| --- | --- | --- |
| `mts_instance/<instance_id>` | 页面 MTS | 通过页面关联 MTS |
| `bts_instance/<instance_id>/slot_<slot>` | 手动采集的页面 BTS slot | 通过页面、slot 和所属 generation 关联 |
| `bts_residual/<instance_id>/slot_<slot>` | 已销毁页面的 BTS slot | 通过页面历史关联，不能要求页面采集时仍存活 |
| `bts_vm/<vm_unique_id>` | BTS VM 整体 | 对应 `bts_vm_acc_<vm_unique_id>` |
| `bts_unknown/<vm_unique_id>` | BTS unknown slot | 同上，范围为 slot 0 |
| `bts_common/<vm_unique_id>` | BTS common slot | 同上，范围为 slot 1 |
| `bts_overflow/<vm_unique_id>` | BTS overflow slot | 同上，范围为 slot 2 |

快照时间取 `capture_snapshot.ts`；没有真实采集耗时数据时显示未知。

共同字段：

| 字段 | 含义 |
| --- | --- |
| `id`、`snapshot_id` | 范围标识、单份快照标识 |
| `total_length`、`chunk_count`，可选 `chunk_size` | 快照内容完整性信息 |
| `desc` | VM 描述；可包含 `vm_type`、`acc_usage`、`base_usage`、`page_rss_usage` |
| `instance_id`、`slot` | 采集对象元数据；存在时须与 `id` 解析结果一致 |
| `include_internal_allocations` | 是否包含引擎内部不透明分配；用于说明统计覆盖和快照可比性 |
| `trigger_retained_bytes` | 触发本次采集时的目标 slot 内存 |
| `retained_bytes` | 本次快照采集完成后目标 slot 的内存 |

Residual 的附加字段：

| 字段 | 含义 |
| --- | --- |
| `post_exit_page_count` | 该页面退出后，所属 BTS VM 又加载的新页面数量 |
| `previous_retained_bytes` | 前一份快照采集完成后的 slot 残留，首份为 0 |
| `capture_reason` | 本次采集原因 |
| `change_percent` | 触发采集时相对前一次采集后残留的变化百分比；没有上报时保留缺失 |

已知采集原因：

| `capture_reason` | 含义 |
| --- | --- |
| `first_post_exit_full_gc` | 页面退出后的首次完整 GC 触发采集 |
| `post_exit_page_count_within_two` | 退出后的前两次新页面加载阶段补充观察；具体次数看 `post_exit_page_count` |
| `residual_cleared` | 目标 slot 残留清零 |
| `residual_reappeared` | 目标 slot 清零后重新出现内存 |
| `residual_change_exceeds_20_percent` | 本次触发值相比前份采集后残留的变化超过 20% |

采集原因描述记录端行为，分析端不模拟触发调度、不重新补造快照。未知原因保留原值，已验证身份和内容的快照仍可用于分析。

`desc.acc_usage` 是 VM 总量，不能当作页面残留。`trigger_retained_bytes` 与 `retained_bytes` 可以不同，页面末次残留使用后者。

### 3.6 快照提取与完整性

`snapshot_chunk` 包含 `id`、`snapshot_id`、`chunk_index`、`content`，部分格式带 `offset`。

1. 先定位唯一的采集记录，再按 `snapshot_id` 收集属于它的分块，核对分块 `id`。
2. 按数值 `chunk_index` 排序；存在 `offset` 时同时核对顺序。分块索引应从 0 连续递增，缺失、重复或冲突都标为不完整。
3. 按原序拼接 `content`，不改写其中的 JSON 转义、换行或对象内容。
4. 核对声明分块数和总长度，再校验堆快照 JSON 结构。长度校验需采用记录端声明长度的编码口径，不混用 UTF-8 字节数和 JavaScript UTF-16 字符串长度。
5. 保存 `.heapsnapshot` 文件，返回路径、哈希、完整性状态及错误说明，不向 Agent 返回整段内容。
6. 同一 `snapshot_id` 只提取一次。不同 ID 即使文件哈希相同，仍保留各自采集时间和上下文；比较时注明重复内容，不把它当成独立对象图变化。

清零记录若有 `retained_bytes=0` 但没有可提取对象图，仍保留为已报告的清零观察，不能伪造空堆文件，也不能与“快照分块损坏”混为一谈。

## 4. 分析入口与数据准备

Lynx 同时有 internal 仓库 `https://code.byted.org/lynx/template-assembler` 和 OSS 仓库
`https://github.com/lynx-family/lynx.git`。**OSS 仓库根目录对应 internal 仓库中的 `lynx/` 目录；
两者的 Trace 事件和 Trace 分析能力相同。** 本文的事件语义、查询、内存/快照分析及报告规则
对两者一致，具体可分析范围由 Trace 实际记录的数据决定。

业务源码与 Lynx 源码均接受完整 Git URL（HTTPS、`ssh://git@host/path.git`、
`git@host:path.git`）、完整或可唯一解析的 commit、分支名、本地目录（绝对路径、相对路径、
`~/`），以及 URL/目录加 commit/分支的组合。业务版本标识须绑定已知仓库；Lynx 保留用户
明确指定的 URL／本地路径，否则使用 Trace 版本拼出的 tag 或用户提供的版本／commit／分支
自动查询 Git 远端确定仓库，不再要求用户选择 internal/OSS 或补充 URL。
URL 缺少版本时询问；本地目录未指定版本时使用当前代码并保留用户改动。

前端和 Lynx 均遵守：Git URL、commit、branch 输入必须从远端获取到本次全新目录并构建，
不检查或搜索本地仓库，不复用已有 checkout/worktree、Git 缓存、旧产物/map/manifest 或源码定位缓存。
只有用户明确指定该源码的本地路径时才允许检查和验证复用；业务来源缺 URL 时询问，
Lynx 则查询已知远端，均不扫描本地补全。
一类源码或分析工具的本地路径不授权另一类源码的本地查找。失败后的本地替代来源也须由用户明确提供。
**前端工程与产物分别提供时例外：默认不构建前端工程。** 工程和产物可在不同目录，分别通过本地、
Git（指定 ref）或下载链接提供；非 Git 下载地址不要求版本标识。远端工程仍全新获取指定源码，
产物独立获取并保留真实文件名和字节。先匹配 Trace 的生成脚本，再用匹配 map 定位到指定工程，
来源与产物的仓库、revision、路径和哈希分开记录。该例外不改变 Lynx 公共脚本准备规则。

**源码准备成功后连续分析，不增加产物确认或 Lynx 构建意愿询问。**
用户为本次分析明确指定 Lynx 源码/版本时优先使用；已有明确放弃源码辅助的决定也继续生效。
否则读取 `LynxEngineVersion.version`，拼接 tag 并查询 Git；tag 存在就自动获取、构建公共脚本。
只读版本预检允许在前端准备前执行，业务工程及分析工具路径不属于 Lynx 运行时源码输入。

- 单个可用版本：核实 tag 与完整 commit 后直接构建 `lynx_core.js`、`krypton.js` 等适用公共脚本，
  不询问是否使用该版本或构建产物；记录 Trace 事件、版本、tag、远端查询和完整 commit 证据。
- tag 不存在、版本缺失/本地标记/无效且无法解析：展示实际版本与远端结果，再请用户补充源码
  定位（版本、commit、分支或显式本地路径等），不静默换版本或解释为用户放弃。
- 多个版本：先用已记录的进程/页面身份缩小范围；仍无法唯一定位时才询问缺失的版本选择，
  不默认取首项，也不另问一次是否构建。

前端工程由用户指定且编译成功后，`frontend-prepare` 记录、校验产物并直接进入后续分析。
用户无法判定 sourcemap 与 Trace 的技术一致性，不能要求其确认产物路径或 hash 代替校验。
Lynx 构建成功同样继续；在提取快照后的源码匹配阶段，由 Skill 检查脚本绑定、JS/map、
`sourcesContent` 和记录的函数偏移。前端产物实际不匹配时，先检查工程配置中的变量、条件分支等，
输出配置位置和可能导致产物差异的原因，再提供**终止整个分析流程**、**放弃对应前端产物辅助继续
分析**、**提供明确的产物地址**三项。新产物仍不匹配或不可获取/校验则更新证据并继续询问，
直到匹配成功或用户明确终止/放弃辅助，不能按次数自动跳过。Lynx 不匹配仍采用放弃对应源码辅助/
终止二选一。没有位置元数据或未用候选不等于实际不匹配。详细规则见第 12.1 节。

自动解析未明确指定的 Lynx 仓库和版本，再全新浅克隆／拉取所选远端；
只有显式本地路径才使用对应 checkout。远端选择流程如下：

1. 先用 `GIT_TERMINAL_PROMPT=0 git ls-remote "<internal-url>" HEAD` 探测 internal，
   保留命令、退出状态和完整输出。**internal Git URL 可访问时，一定选择 internal**，
   即使 OSS 也可访问或存在同名 ref，也不改选、不要求用户确认仓库类型。
2. 只有 internal 不可访问时才探测 OSS；记录 internal 的实际访问／认证／网络错误，
   不因这个预期的选择结果暂停询问。OSS 可访问则选用它并校验版本；两个远端都不可访问才
   报告两份日志，按真实访问阻塞进入获取恢复流程，不让用户猜测仓库类型。
3. 对 Trace 读出的版本或用户指定版本拼接 `A_<version>`，用 `git ls-remote --exit-code`
   查询精确的 `refs/tags/A_<version>` 和 `refs/tags/A_<version>^{}`，annotated tag 保留
   peeled commit。这是 internal tag 约定；OSS 如使用不同命名，须从其远端 tag／release
   记录验证对应关系并留证，不假定两个仓库 tag／commit 相同。分支查询精确的
   `refs/heads/<branch>` 并固定完整 commit。
4. `ls-remote` 不列出所有 commit，裸 commit 未出现在结果中不代表不存在或属于 OSS。
   在所选仓库的本次全新空目录执行 depth-one fetch，再用
   `git rev-parse 'FETCH_HEAD^{commit}'` 核对并 detached checkout。短哈希先通过可验证的
   远端证据解析为唯一完整 commit；无法解析时报告版本信息不足，不询问仓库类型。
5. 严格区分“仓库不可访问”和“请求 ref 不存在／不可获取”。**internal 可访问但版本获取
   失败时仍保持 internal，不回退 OSS**，按实际 ref／获取失败处理，不静默换版本。
   保留 URL、类型、请求版本/ref、完整 commit、探测及获取日志；本轮已新建并 fetch 的目录
   可直接用于后续构建，无需重复克隆。

**仓库类型在 URL／commit 选择和克隆阶段确定，不能等到产物不匹配后才区分 internal／OSS。**
保留显式输入或远端查询确定的来源，克隆后核对 origin/HEAD。后续提供 commit 时沿用已确定
仓库并验证版本，不重复询问。切到 internal 的 `lynx/` 子目录
不改变 SDK 类型；显式本地路径按其实际 Git 根目录和 origin 识别，不扫描其它本地仓库。
准备构建输入和打包时，遵循所选仓库当前 revision 的说明，不得混用 internal 与 OSS 的生成器或产物。

**构建前必须按以下规则选择入口，再用该 revision 的 SDK 打包配置核实。** 路径均相对所选
checkout 根目录；“共享源码目录对应”不表示可以用 OSS 构建替代 internal SDK 构建。

| 仓库／SDK | SDK 公共 core 构建入口 | 工作区与构建顺序 | 默认产物目录 |
| --- | --- | --- | --- |
| internal `lynx/template-assembler` | `tools/oliver/lynx-kernel/build.py` | checkout 根目录：`@lynx-js/runtime-shared build` → `@lynx-js/lynx-core build:lib` → `@byted-lynx/kernel build:<platform>` | `oliver/lynx-kernel/output/` |
| OSS `lynx-family/lynx` | `tools/js_tools/build.py` | checkout 根目录：`@lynx-js/runtime-shared build` → `@lynx-js/lynx-core build:<platform>` | `js_libraries/lynx-core/output/` |

例如当前 iOS 结构应读取 checkout 根目录的 `platform/darwin/ios/lynx/BUILD.gn`、
`build_overrides/darwin.gni` 中的 `prepare_command`／devtool 准备命令：internal 调用 kernel
入口，OSS 调用根目录 `tools/js_tools/build.py`。其它平台或路径已变化的 revision，沿实际
SDK 打包规则定位 JS 生成步骤。构建台账记录引用文件/行号、入口、工作目录、完整 package
执行链和产物目录，不能只因为某个 package 存在、同名文件生成或命令 exit 0 就认定选择正确。

internal 里的 `lynx/tools/js_tools/build.py` 生成 `lynx/js_libraries/lynx-core/output/`
下的独立共享 core，**不是 internal SDK 的最终 kernel**。其中 `lynx-core build:lib`
是 kernel 的中间依赖；单独运行 `lynx-core build` 不能代替 kernel 的最后打包步骤。
只有用户明确要求 standalone OSS 目标，或捕获 SDK 的实际构建引用证明使用该目标，才能在
internal checkout 内例外选择共享 core，并记录依据；不能因为 `cd lynx` 就改变目标。
OSS checkout 不得套用 internal kernel 或假定存在 internal 的 Krypton 等兄弟组件。

internal 在根工作区安装 `@byted-lynx/kernel...` 的锁定依赖，只安装 `lynx/` 下的 core
依赖并不充分；OSS 安装根工作区 `@lynx-js/lynx-core...` 的锁定依赖。先按该 checkout 的
AGENTS/README 初始化工具链，再执行对应 wrapper。缺 `buildtools/corepack`、node 或 wrapper
属于环境问题，不能改用另一套构建入口。若展开 wrapper 为直接 pnpm 步骤，必须事先逐项核对
完整 package 链、工作区、平台、版本变量和 feature 开关；独立 core `build` 不能声称与 kernel
wrapper 等价。初始化/依赖/构建失败先按下述环境检查规则自动重试一次，不借“等价步骤”切换目标。

依据选定入口生成 `lynx_core.js`、外置 map、带 inline map 的 `lynx_core_dev.js`，以及
实际 SDK 使用的 Krypton 等组件编码入二进制前的 JS/map；保留平台和 WebGPU 等开关。
`LynxEngineVersion.version` 仅是引擎版本观察，不直接证明 JS 构建环境传入了同值的 `version`。
记录实际变量为未设置／默认或显式值；捕获构建环境未知时，分别保留所选入口的默认候选和有证据
支持的版本注入候选，通过偏移校验选择，不能只依据 Trace 版本覆盖默认构建。
缺少 map 的 piper 生成器可通过捕获脚本补充生成，但必须校验 JS 与原编码输入逐字节一致。
Trace 能力一致不代表构建产物可互换，不能跨仓库套用 map 或偏移。

准备完成须有逐组件清单，至少包含 core prod、core dev、Krypton 及实际 loader 引入的其它脚本：
记录适用性证据、源仓库/ref/完整 commit、平台/开关、获取方式、构建命令/退出状态/完整日志、
JS/map 路径和哈希、注册工程 ID；显式本地路径的产物复用须如实标注验证依据。每项必须构建并
注册成功、有证据证明不适用，或经用户明确同意跳过；缺项/失败/待处理都不能完成准备。
只提交 core 的 manifest 或 `frontend-prepare` 成功不能替代 Krypton 的完成记录，仓库没有组件
也不证明捕获 SDK 未使用它。清单和失败记录保存在分析输出目录，缺项进入报告来源限制。

**全新克隆、同步依赖与构建可能产生临时文件或被 Git 跟踪的文件变更。** 公共脚本构建完成后，
这些变化不阻断分析，不检查工作区干净状态，不调查无关变更，也不要求清理、提交或询问用户。
仍校验 origin/ref/HEAD、JS/map 与来源文件哈希；只有具体文件内容与 commit 一致时才生成远端
源码链接。变化文件可保留已验证的本地定位和片段，缺少 commit 链接本身不属于源码匹配失败。

快照提取后另行检查绑定：逐项对照 Scripts 清单、已准备组件、候选 matched/total 偏移和唯一选中
结果。发现应有脚本没有候选时重新进入准备；已有构建授权无需重复征求。缺产物、构建失败或明确
偏移冲突按源码失败流程交互，不能静默生成“已完成源码辅助”的报告。位置数量不足可以保留为明确
证据缺口。“JS/map 已准备”与“快照脚本已绑定”是两个状态。
将冲突归因于 commit 前，必须只读核对“仓库类型 → SDK 引用配置 → 构建入口/工作区/package
链 → 平台、prod/dev 和版本参数”。入口选错应明确报告为入口选错；某个候选不匹配不等于
用户 commit 错误，没有独立版本证据不得要求换 commit。该核对不将真实匹配失败变成默认跳过，
也不能覆盖用户已明确终止分析的决定。

**全新 Lynx checkout 初始化、依赖同步/安装或公共脚本构建失败，先检查 shell 环境等因素，
自动重试一次。** 完整保存首轮 stdout/stderr、命令、工作目录与退出状态；读取第一处错误，
按仓库说明检查 shell 初始化、实际可执行文件路径、PATH、Python/Node/corepack/pnpm、
VIRTUAL_ENV/PYTHONHOME/PYTHONPATH、代理及必要构建变量。只记录相关且脱敏的信息，
作有依据的子进程级修正，保留原仓库、revision、SDK 入口、平台与预期参数，不修改用户全局环境。
停止确实失败/超时且仍运行的本次命令后，再重试失败阶段并完成剩余构建；命令仅转入后台不算失败。
依赖同步内部的 Git 拉取失败属于此规则，不按初次源码克隆失败立即询问。
重试成功直接继续；仍不能完成公共脚本构建时，才提供**放弃 Lynx 源码辅助继续分析**和
**终止整个分析流程**两个选择，展示两次日志与诊断记录。不无限重置同一准备流程的重试次数。

**其它准备失败按阶段处理，不默认跳过或中止。** 初次 internal 不可访问后继续探测 OSS
属于上述自动选择步骤，不触发中途暂停。失败保存日志，明确说明源码、失败阶段、
实际错误/超时、已尝试 URL/ref；停止本次准备中超时仍运行的命令，保留已完成证据。
克隆、拉取或检出失败后，仅追问实际错误所缺的修正版本或访问／获取信息，不重复确认
Lynx internal/OSS。展示已尝试的确切 `git_url`、commit ID/分支，并询问其它获取方式：
本地 checkout、可访问镜像、源码归档/导出，或匹配 JS/map 与可验证的构建来源记录。
新输入须核实实际仓库与版本；无 Git 身份的归档或独立产物不能冒充通过运行时来源校验，
缺少信息时继续追问。不要盲目重复失败命令、静默切换仓库或将 Git 失败强制变成二选一。
**持续交互，直到拿到可用源码、用户明确不需要 Lynx 产物辅助分析（业务源码则明确放弃
对应项目），或用户明确中止整个分析流程。** 不因失败次数、无回复或某一方式不可用而结束。

业务依赖安装/构建失败、上述 Lynx 重试仍失败，以及后续真实 Lynx 源码匹配失败时，提供两个明确选项：
**终止整个分析流程**，或**跳过当前失败的对应源码，继续使用其余可用的代码完成后续分析**。
前端产物不匹配或显式产物获取/校验失败优先使用第 12.1 节的配置诊断和三选一循环。
进入该决策后等待明确答复，不继续重试或以部分成功产物绕过失败。放弃/跳过仅作用于说明的源码范围，保留用户原话，
在报告中记录来源缺口与定位限制；另一个源码失败时重新按阶段交互。

公共产物通过独立 `--lynx-manifest` 与前端 map 一同解析；保留用户明确输入或自动版本解析证据、resolved commit、
产物哈希及各 snapshot 的候选偏移匹配证据。`lynx_core.js` 的 runtime URL 也可能装载 dev 代码：
必须用至少三个且覆盖全部记录位置的函数/类/方法语法偏移进行唯一匹配，歧义和不匹配不映射。
完整流程见 [lynx-sources](../references/lynx-sources.md)。历史样例重分析曾使用当时用户指定的
commit `710b41823ed73572117b7b6852ed5df6995d4646`，不用 Trace 中的无效本地版本。
该记录不是新请求的授权或默认 revision，即使再次分析同一份样例 Trace，也必须按本次
对话中的源码输入和决定执行上述门禁。
上述规范同时维护在 Skill 主文档及发布 references 中；发布 Skill 不包含、也不依赖本原型文档。

### 4.1 请求路由

| 用户请求 | 行为 |
| --- | --- |
| 宽泛内存分析、高内存、泄漏检查 | 自动解析 Trace 版本 tag 并完成源码准备后运行默认流程；不要求用户选择页面或确认构建意愿 |
| 指定 URL | 不区分大小写的子串匹配，分析全部匹配实例 |
| 指定 `instance_id` | 精确匹配该实例 |
| 滚动／滑动趋势 | 需要 URL 或 instance，以及绝对 Trace 毫秒起止时间；只询问缺失信息 |
| 指定 VM 的第几份快照 | 先查询快照清单，再解析用户指定序号 |

默认目标是 Trace 开始后创建的页面。Trace 开始前已存在的页面仍参与 VM 关联、存活页面提示和全局上下文；用户明确选中时可展示其可获得的数据。

内存分析入口要求 `TRACE_BEGIN.enable_memory_trace` 启用，否则说明没有可用的 Lynx 内存数据，建议升级并开启内存采集后重新录制，停止该流程。

URL 无匹配时列出所有非空唯一 URL，请用户选择，不猜测目标。instance 不存在时说明未找到并停止该目标分析。滚动区间须满足 `start < end`，与页面观察范围无交集时停止该场景分析。

### 4.2 页面生命周期

同时保存两种生命周期：

| 口径 | 起点 | 终点 | 用途 |
| --- | --- | --- | --- |
| Shell | `LynxShell::Create` 开始 | `LynxShell::~LynxShell` 结束 | PSS、页面分组、缓存池、页面图表 |
| BTS | `page_uses_bts_vm` | `BTSRuntime::Destroy` 结束 | slot 归属、存活页面列表、页面退出事实、BTS 事件 |

缺创建事件不补造真实创建时间；有 Trace 起点页面内存等证据时标记为预先存在。缺销毁事件表示本次观察中未确认销毁。内部区间推理可用无穷边界，JSON 使用空值和状态表达。

用于页面内存观察的起点：

`t_real_create = max(t_trace_start, t_shell_create - 200 ms)`。

预先存在的页面图表从 Trace 起点观察，但不计算缺少真实进入前基线的加载增量。直到 Trace 结束仍未销毁的页面，观察终点为 Trace 结束。

### 4.3 BTS generation 与轨道绑定

1. 按时间顺序处理页面关联、VM 销毁和 VM GC。
2. 通过 `ptr` 找到活动 VM，再记录名称、类型、generation 和使用过它的页面。
3. 某 VM 销毁后关闭该 generation；同名 VM 再次出现时 generation 加 1。
4. 同名、同指针的历史 VM 不得合并。身份冲突无法消除时保留歧义说明。
5. 内存轨道候选必须同时满足：指针相同，且轨道采样区间与 VM generation 生命周期相交。
6. 候选恰好一条时绑定；零条或多条时停用该 VM 的 counter 内存分析并报告原因。

不能硬性要求轨道首样本晚于页面关联事件，因为录制顺序可能使首样本略早。

快照归属通过第 3.5 节的身份关联单独验证。counter 绑定失败不自动否定一份身份清晰且内容完整的 residual 快照；此时仍可做对象分析，但说明 VM 图表不可用。

查询 VM 在时刻 `t` 使用的存活页面时，采用 BTS 口径：`bts_create <= t < bts_destroy`。它仅供图表上下文等功能使用，不再用于 GC 前后集合匹配的泄漏归因。

### 4.4 页面分类

- **独立页面**：在 `[t_real_create, min(t_shell_destroy, t_trace_end)]` 内没有其它本次录制中新建页面的 `t_real_create`。
- **重叠页面**：不满足上述条件。该分类描述新页面创建干扰，不意味着独立页面所在进程没有其它已存活对象。
- **同组页面**：从重叠页面中，按创建时间依次取尚未分组的页面作为锚点；收集同一共享 VM generation 下、创建和销毁时间分别距锚点不超过 2 s 的未分组页面。至少两个成员才成组，每个页面只属于一组。
- **重复焦点页面**：同 URL 的多个实例按创建时间排序，各次销毁不晚于下一次 `t_real_create`。按 1 开始标注“第 N 次加载”。

同组页面只共享适合做组级分析的 PSS 结果。每个页面的 residual 序列和子报告始终独立，不因分组或 URL 相同而合并。

## 5. 页面内存分析

### 5.1 加载阶段 PSS 峰值增量

独立页面取 `t_start=t_real_create`，`t_end=min(t_shell_destroy,t_trace_end)`；同组页面取最早成员起点和最晚成员终点。

基线为 `t_start` 时刻的有效 PSS，峰值为区间内样本最大值，增量为峰值减基线。上述两类按既有规则标记高置信度；同组结果必须说明属于整组。

其它重叠页面查找其后第一个其它页面的 `t_real_create`。若距本页面起点严格大于 3 s，可在该窗口计算中置信度峰值；否则不计算，说明创建干扰过强。缺基线或峰值样本时不输出伪造数值。

高／中置信度峰值增量严格大于 150 MiB 时产生“高内存消耗页面”issue，并提示 OOM 风险。该 issue 不等于泄漏结论。

### 5.2 页面退出后的 PSS 回落

适用于已销毁的独立页面或全部成员已销毁的同组页面：

1. 基线仍取该页面／组的 `t_start`。退出时刻 `t_exit` 为页面或组的最晚 Shell 销毁时间。
2. 找到开始时间不早于 `t_exit` 的第一个完整 `RunGC`，令 `t_observe = gc_end + 10 ms`。
3. 找到之后第一个无关页面的 `t_real_create`，记为 `t_next`；不存在则视为无穷。
4. 若新页面在 `t_observe` 前创建，放弃该次高置信度回落分析。
5. 在 `[t_observe, min(t_observe + 5 s, t_next, t_trace_end)]` 内找到最小 PSS 样本 `m_low`。最小值重复时使用最早样本。
6. 计算 `delta_pss = m_low - baseline_pss`。

| 结果 | 表达 |
| --- | --- |
| `delta_pss < 0` | 低置信度；存在其它内存下降因素 |
| `0 <= delta_pss < 2 MiB` | 该观察窗内 PSS 上涨不明显；不能据此排除全部泄漏 |
| `delta_pss >= 2 MiB` | 退出并完成回收后 PSS 仍有明显上涨；不直接当作 JS 泄漏 |

在页面／组符合条件、实际 GC 完整且基线和观察样本齐备时，后两类回落结果标记高置信度。该置信度针对测得的回落结果，不等于已确认内存泄漏。

缺少完整 `RunGC` 时说明无法确认高置信度回落；可补充退出后最多 5 s、且不跨下一页面创建的 PSS 最低值，明确标为低置信度观察。不能因配置字段缺失而推断没有强制回收。

报告必须显示基线样本和最低值样本各自的时间戳、PSS 值、观察窗口、增量和置信度。重叠且无法分组的页面不计算单页回落。

### 5.3 页面内存增量图

适用于独立页面。若存在 BTS 但其内存不可用，不绘制完整的页面内存增量图并说明原因；无 BTS 页面可绘制可用的 PSS 和 MTS。

- 起点为 `t_real_create`。
- 有回落结果时，终点取实际产生 `m_low` 的 PSS 样本时间。
- 无回落结果但页面已退出时，优先取退出后首个完整 `RunGC` 结束加 10 ms；缺少该事件时取退出后 10 ms，并说明这不是已确认回收终点。
- 未退出时终点为 Trace 结束。所有终点均不超过 Trace 结束。
- 使用区间内真实 PSS 样本时间，对齐各 VM 的时刻查询值。

序列包括进程 PSS 增量、可用的 MTS RSS／Accumulate、BTS RSS／Accumulate。MTS 和页面独享 BTS 的进入前基线为零；共享 BTS 减去 `t_real_create` 的 VM 基线，并明确该增量属于 VM，可能含其它使用者的影响。

本节是页面综合图。第 7 节 BTS 堆大小图取消 RSS，不改变本节及滚动综合图的 RSS 口径。

图表使用不同颜色折线，保留负值、零基线、悬停数值和图例开关。有回落结果时，最后一个 PSS 增量必须等于报告中的 `delta_pss`，不能另取邻近样本代替。

### 5.4 页面组件数量图

对每个页面展示整个可观察生命周期内的 Lynx UI View 类别数量，每个类别一条序列。

新建页面在第一个组件样本前可绘制零起点；页面销毁边界可绘制生命周期结束的零点，但必须区分这种边界补值与真实 counter 样本。不能把补零当作组件已实际释放的证据。

保留零基线、完整类别名、悬停详情和图例显示／隐藏。组件数量增长可作为排查线索，不单独确认泄漏。

### 5.5 Graphic 组件内存占用

在“页面实例分析”的每个含 Graphic 组件的页面卡片中，添加标题为 **“Graphic组件内存占用”** 的阶梯堆叠面积图，放在页面内存增量图和组件数量图之后。该图独立于 PSS、MTS／BTS 数据可用性和页面是否重叠；只有 AnimaX 的页面也展示。

1. 数据按第 3.3 节计算。Canvas 每种去重后的 `krypton.*.bytes` 是一个分项；每个 AnimaX 类别是一个分项，名称保持原始组件名。Canvas 总估算量、累加 `sizeBytes` 和 counts 不进入堆叠。
2. x 轴使用页面的可观察 Shell 生命周期：起点沿用第 4.2 节的 `t_real_create`，预先存在页面从 Trace 起点观察；终点是 Shell 销毁结束或 Trace 结束，均裁剪到 Trace 范围，不延长到 PSS 回落观察终点。
3. y 轴为实际 bytes，按 KiB／MiB 展示；面积的总高度是已知分项合计，不绘制归一化到 100% 的面积。分项按稳定的资源 key／组件名称排序，使用不同颜色，排序和颜色在过滤、重绘及语言切换后保持一致。
4. 悬停显示样本时间、各可见分项字节数、占全部有效分项合计的比例及合计。隐藏图例不改变比例分母；合计为零时比例为零。有缺失分项时明确标注“已知分项合计／占已知分项比例”，不将部分覆盖称为页面全部图形内存。可用的 Canvas App 总估算量独立展示，并说明与分项合计的差异。
5. 字段首次上报前及明确缺失／无效的样本区间显示未知，不补测量零值；已知值在相邻样本间阶梯保持，末值可延至页面观察终点。页面退出时无组件明细的 `memory_N=0` 表示 reporter 清空，不生成“图形资源已释放”的零点。单个有效样本仍保留可见点和后续保持区间，并注明样本稀疏／字段可能缓存，不做线性插值或趋势判定。
6. 只有部分分项可用时绘制这些分项并说明缺口；没有任何有效 bytes 时保留图表位置并显示原因。完全没有 Graphic 类别的页面不增加此图。

图例、tooltip、标题折叠和语言切换沿用报告公共交互。新增 Graphic、Canvas 和全局 Krypton 图的 tooltip 顶部统一显示悬停时间，各数据行及独立对照值不追加 `@来源时间`、`counter=` 或 `track=`；来源信息仅保留在结构化数据中。标注为资源统计／估算值，不与 PSS／VM 内存相加，不依据此图独立产生确认泄漏标记。

### 5.6 Canvas 组件图形资源计数

对名称包含 `canvas` 的页面，在 Graphic 面积图之后添加 **“Canvas组件图形资源计数”** 折线图；仅含 AnimaX 的页面不添加此图。

- 使用第 3.3 节中去重后的所有 Canvas App count 字段，每个字段一条线；明确包括 `krypton.total.object_count`，不能只匹配 `.count` 而遗漏它。
- 保留完整资源字段身份，可使用双语资源标签，但 tooltip 中显示原始 key。`instanceCount` 是 UI 组件数量，仍属于原有组件数量图，不混入本图。
- x 轴与同页 Graphic 面积图一致；y 轴为资源数量。使用阶梯折线保留采样值，显示真实零值、单点和图例开关。缺失、缓存、末值保持、退出边界与第 5.5 节一致。
- `total.object_count`、`webgl_generic.count` 及 WebGL 子类型可能存在包含关系，分别显示，不堆叠或求和；计数增长仅提供资源变化线索。
- 能识别 Canvas 页面但缺少有效 counts 时显示原因，仍保留可用的内存图。

### 5.7 MTS 缓存池增长

对本次新建且已经销毁的每个页面：

- `t0 = t_real_create`。
- `t1 = max(t0, t_shell_destroy - 100 ms)`。
- 按第 3.4 节获取两个时刻的所有活跃 MTS 池。
- `pool_delta_rss = total_rss(t1) - total_rss(t0)`，同时计算每个 URL 的实例数、Accumulate 和 RSS 前后值及增量。

不丢弃负增量、只在一端存在的 URL 或 `global_pool`。总 RSS 增长严格大于 3 MiB 时产生高置信度的“MTS 虚拟机缓存池增长过多”issue，将正 RSS 增长 URL 及其数据重复列入“异常 MTS 虚拟机缓存池归属”。

该规则确认观察窗内的池增长，不证明池由该页面单独创建，也不证明 JS 对象泄漏。未销毁页面缺少上述结束点时说明未执行此项。

### 5.8 滚动／滑动场景

只在用户明确指定该场景时执行。取请求区间与页面可观察生命周期的交集：

1. 绘制 MTS RSS／Accumulate、BTS RSS／Accumulate、进程 PSS 的可用序列。
2. 绘制各类别组件数量。
3. 使用实际 PSS 时间对齐各数据源；若无 PSS 时间点，说明无法执行当前的对齐分析。
4. 按第 6 节、最低 10 个样本判断每个序列趋势，输出上涨与否、稳定水位差、斜率、样本数和原因。

趋势结果本身不产生确认泄漏结论。建议检查保留 View 时，须同时说明引擎内存与组件数量是否共同增长。

## 6. 趋势判定

本节同时用于滚动趋势与 VM GC 后 Accumulate 趋势，使“上涨”具有可复核定义。

1. 不足调用场景要求的最少样本数时，结果为“样本不足”，不等同于确认不涨。
2. VM GC 场景有 3～9 个样本时直接使用原值。其它满足样本数的序列做半径 2、最多 5 点的移动中位数，边缘使用实际可用点。
3. 首尾稳定水位分别取前后 20% 样本的中位数；样本数向下取整，稀疏序列窗口至少 1 点，其它序列至少 3 点。稳定水位差为末段减首段。
4. 对平滑后序列的相邻差分计算中位数绝对偏差 `MAD`。
5. 噪声阈值取 `max(单位下限, abs(首段水位) × 1%, 3 × MAD)`。内存单位下限为 64 KiB，数量单位下限为 1。
6. 用 Theil–Sen 方法计算稳健斜率：取不同时间点两两连线的每秒斜率中位数。为控制开销，样本按 `max(1, ceil(n/80))` 的步长选取，并保留最后一点。
7. 按每桶 `max(1, floor(n/5))` 点分桶，保留最后的不足一桶数据。比较各桶中位数，至少 `max(1, ceil(相邻桶对数 × 60%))` 对不下降。

只有同时满足“斜率为正”“稳定水位差严格超过噪声阈值”“桶级持续性达标”，才判定上涨。报告展示全部判定量及原因；规则或参数改变时同步更新本节与验收。

## 7. BTS 虚拟机整体观察

### 7.1 范围与图表

对每个有可用 counter 轨道的共享 BTS VM generation 展示可展开章节“共享的 BTS 虚拟机堆大小图”，标题带名称和 generation。该代仅关联一个页面时也展示。

- x 轴从 VM 在 Trace 内的首次有效观察开始，到 VM 销毁或 Trace 结束。
- 主图是 **slot 阶梯堆叠面积图**，slot 按数值升序固定堆叠，slot 1 在 slot 0 之上，以此类推。
- counter 样本值持续到下一样本，末样本可延长到观察终点。只延长已测值，不产生额外趋势样本。
- 图中不绘制 RSS，也不设置 RSS 图例或 RSS 悬停行。
- VM Accumulate 总值仍读取 counter，供总量提示和趋势分析。slot 总和与 VM 总量有差异时分别标明，不缩放 slot 强行相等。
- 没有 slot 字段但有 VM Accumulate 时，展示 Accumulate 阶梯面积作为降级视图，并说明缺少 slot 数据。
- 堆叠绘制对未携带某个已知 slot 的样本可补 0，但补值不作为残留清零证据；残留判定依据第 8 节。

slot 0／1／2 分别标注 unknown／common／overflow。专用 slot 标注页面 `instance_id`；悬停时刻已完成 `BTSRuntime::Destroy` 的页面附加“已销毁”。同时展示该时刻使用此 VM 的存活页面列表。

悬停详情包括各 slot 字节数及其占该样本全部 slot 总和的比例；隐藏图例不改变原始比例分母。总和为零时比例为 0。普通行单行显示，使用半透明背景；在可见堆叠边界绘制 4 px 悬停点。

### 7.2 事件与标记

- 本 VM generation 的每个 `VM_GC` 完成时间绘制红色竖向虚线。
- x 轴下方用不同颜色气泡展示 VM 销毁、页面 BTS 创建、页面 BTS 销毁和已关联快照。
- 页面销毁气泡位于 `BTSRuntime::Destroy` 结束；快照气泡位于 `capture_snapshot.ts`。
- 页面气泡悬停显示 instance 和完整 URL；快照气泡显示 ID、范围、采集原因及可用 residual 元数据。
- 确认泄漏使用比普通事件更突出的图标，位于形成该结论的证据快照时间，默认采用末次有效 residual 快照时间。不得使用 Agent 执行分析的墙钟时间。
- 泄漏标记显示 instance、slot、结论等级、残留量、可量化的泄漏量及证据快照，点击进入该页面子报告。
- 只有疑似、只有 slot counter 残留或尚未运行 analyzer 时，不绘制确认泄漏标记。

### 7.3 分析项一：VM 未销毁

匹配轨道的首个样本严格晚于 Trace 起点 100 ms 时，按本规则视为 VM 在 Trace 内创建。若直到 Trace 结束都没有 VM 销毁事件，产生高置信度“BTS 虚拟机未销毁”issue。

报告保留 Trace 结束时的 RSS 数值和源样本时间；这是一项状态说明，不在 BTS 图中恢复 RSS 序列。缺少 RSS 时显示不可用。

该规则报告 VM 存活状态，不自动产生页面泄漏标记，不宣称该 VM 一定违反缓存或共享策略。

### 7.4 分析项二：GC 后 Accumulate 趋势

对属于此 VM generation 且处于其存活区间内的每个 `VM_GC`，选择事件完成时刻之后或恰好同刻的首个 counter 样本。

同一 counter 样本若被多个 GC 选中只计一次；不使用销毁后的数据，不把图表延长点当作样本。按第 6 节、最低 3 个样本分析 Accumulate 趋势。

判定上涨时产生中置信度“BTS 虚拟机 Accumulate 内存呈上涨趋势”issue。无论是否命中，都展示样本数、水位差、斜率、阈值和判定原因。

这一 VM 整体趋势不按 URL 分解，不推导某页面每次泄漏多少，也不作为调用 residual 分析的前置门槛。

## 8. 销毁页面的 BTS residual 分析

### 8.1 适用范围

检查所选页面中所有可归属的 `bts_residual` 序列，不要求 PSS 独立、VM 总量上涨或使用共享 context。页面独享 BTS 若有有效 residual 也可分析；共享 VM 图只承担其适用范围内的标记展示。

专用 slot 3～255 可以按页面归因。对于 overflow 等非专用范围，保留观察数据和说明，但不能把整个槽位的残留归给单页。

页面退出事实以完整 BTS 销毁事件为优先证据；若缺事件但 residual 协议明确指向销毁页面，可保留协议所表达的退出事实并将精确退出时间记为未知。字段冲突时停止该序列的页面归因，不能猜测。

### 8.2 序列组织与末次观察

1. 按 `(VM generation, instance_id, slot)` 分组，将该页面所有 residual 记录按采集时间、slice ID 排序。
2. 保留每份记录的 snapshot ID、时间、采集原因、退出后新加载页面数、采集前／后字节数、完整性和文件哈希。
3. 手动页面快照及 VM 整体快照可以作为补充证据，但不混入 residual 序列冒充退出后观察。
4. 末次完整、身份有效的 residual 的 `retained_bytes` 作为“本次观察到的末次残留”。后续清零元数据可更新 slot 状态；清零后再出现残留须继续观察最新状态。
5. 后续有损坏、未完成或身份冲突的记录时，展示末次有效值，同时说明它不是序列末端完整覆盖。
6. 展示快照距离页面退出及 Trace 结束的时间、序列份数和 `post_exit_page_count`；缺少退出时间时不计算退出间隔。

不要求至少两次后续页面加载，不设置固定等待时长，也不因快照停止产生就假定已永久稳定。只有一份快照时也执行可支持的对象分析，证据能否确认泄漏由 analyzer 决定。

后续有效证据已显示清零时，不沿用先前快照的残留量或泄漏结论作为当前状态。若保留历史发现，标明其观察区间和已清零状态；重新出现残留后再依据后续证据判定。

### 8.3 与 js-memory-analyzer 的协作

内存分析 Skill 在默认流程中自动编排 residual 分析。

交给 analyzer 的材料至少包括：

- 本页面按时间排序的 residual 快照文件路径，以及各自的 snapshot ID、哈希和采集时间。
- 页面 instance、URL、slot、VM 名称和 generation。
- 来自 VM 元数据的 GC／RC 模式（无法识别时为 unknown），以及机器可校验的同页连续退出后观察上下文。
- 页面退出事实及其来源；可获得时提供 BTS 销毁事件 ID 与时间。
- 每次采集的 `retained_bytes`、`trigger_retained_bytes`、`post_exit_page_count`、采集原因和覆盖范围。
- 用户问题、已生效的豁免规则、可用的补充手动快照或已核对源码材料。

调用时明确说明：**这些文件是同一个已销毁页面的多次退出后观察，不是进入前／退出后的实验配对。**

Query API 在 `residualAnalyses[].analyzerContext` 保存模式、页面和 VM 身份、slot、有序快照 ID／哈希／时间，
并写出 `contextPath` 指向的 JSON。调用 analyzer 的 `summary`／`trend` 时用 `--residual-context` 传入；
analyzer 校验输入文件顺序和 slot，并在证据中保留 `residual_context`。回填时核对完整上下文，不凭文件名推断模式。

复用 analyzer 的快照解析、对象统计、retainer、根路径、支配关系和报告能力。现有 `summary`、`trend`、`retainers`、`page-exit` 的适用条件仍需遵守：

- 只有退出后快照时，不能构造并不存在的进入前或 baseline。
- 不能只使用正增长族筛选残留。末次仍存在但数量不变、甚至减少的对象，也可能需要检查。
- 核对目标 slot 与外部持有者的边界；对象图可能为保活分析保留其它 slot 的上下文节点，不能将全部节点数当作本页残留数量。
- 相同哈希不构成独立对象变化；默认不跨快照用相同对象 ID 证明同一对象持续存在，除非已验证运行时身份及该 ID 语义。
- `include_internal_allocations` 不一致等覆盖差异必须标注，不能直接把统计差异解释为释放或新增。
- GC 事实、对象保活、预期生命周期结束和释放缺口分别检查。只有统计或单条保活路径不足以确认泄漏。

`analysis.findings` 是 analyzer 定稿结论的来源，主报告承接其结论和证据，不通过大小阈值将自动统计提升为确认泄漏。源码材料缺失时保留实际能支持的结论，不编造责任代码。

泄漏候选筛选和判定不得依赖键格式、数字位数或推测的时间戳含义，也不要求特定缓存 API 或 Function 类型。
属性键仅用于定位实际持有边，快照本身不能证明键的生成方式。用户提供的代码示例属于场景上下文，不作为通用匹配模板；
泄漏结论仍须结合持有链、预期生命周期和已核实的释放缺口，并区分用户提供的事实与快照证据。

### 8.4 状态、大小与去重

| 状态 | 主报告行为 |
| --- | --- |
| 待分析 | 展示已有序列，不计入确认泄漏 |
| 分析不可用／失败／证据不足 | 展示原因、已完成范围及可复查记录 |
| 存在保活／疑似未释放 | 单独列为待核实发现，可查看证据，不进入确认泄漏计数或泄漏标记 |
| 已观察到清零 | 展示该次清零及后续记录，不由此排除其它槽位或后续重新出现 |
| 确认泄漏 | 进入页面 BTS 泄漏 issue、确认泄漏计数及适用 VM 图的标记 |
| 豁免或排除 | 不计入确认泄漏，保留规则与命中证据 |
| 已知非泄漏 | 简要说明原因与可忽略残留大小，不进入泄漏候选、待核实计数、确认 issue 或泄漏标记 |

退出残留分析中，已知非泄漏实例的可折叠标题仅展示 instance 与 slot，不附加“已知非泄漏”状态文字。
泄漏实例的可折叠标题保留“泄漏”（英文 `Leak`），状态文字使用红色。
正文“已知非泄漏残留”的数值和单位整体加粗，与“末次有效残留”一致。
发现条目的“泄漏”（英文 `Leak`）、“非泄漏”（英文 `Non-leak`）、“观察信息”（英文 `Observation`）
均采用与置信度标签一致的圆角胶囊样式；分别使用红色文字与浅红背景、浅黄色背景、绿色文字与浅绿背景。
条目展示文案“泄漏”对应 `confirmed`，不改变确认泄漏的判定和计数语义。
标题旁已有对应状态标签时，删除标题末尾重复的状态及其分隔符：例如
“sharedData 保活页面回调，泄漏”展示为“sharedData 保活页面回调”，
“GC Atom 字符串：已知非泄漏”展示为“GC Atom 字符串”，保留圆角状态标签与置信度。
中英文及主／子报告遵循相同规则；仅处理紧邻状态标签的展示标题，不修改原始 finding、翻译键或正文结论，
也不删除标题主体中的“泄漏”等有意义词语。

置信度与上述状态分别保存。“高置信度”（英文 `High confidence`）使用淡蓝色背景与蓝色文字，仅表示可信度，不表示存在问题。
高置信度的“对象被保活”不能自动改名为“确认泄漏”。

至少分开输出：

1. 原始末次 slot 残留总量及其快照时间。
2. analyzer 识别的泄漏对象和证据。
3. 能可靠量化时的泄漏对象占用，并标明统计口径和是否为下界。
4. 豁免项及其可可靠计算的占用。

不能将 slot 总残留直接当成泄漏量，也不能把相互包含的对象 `retained_size` 简单相加。无法去重或准确量化时报告对象证据和不可量化原因。

同一页面多份快照中的同一项发现只计一次；同一页面的多个发现归入一个页面子报告。主报告分别显示确认泄漏页面数和问题条数，避免把快照份数当作泄漏次数。相同 URL 的不同页面分别计数。

### 8.5 页面子报告与回填

每个确认泄漏的页面 instance 必须有一份由 analyzer 输出的独立定稿 HTML 子报告，包含其全部发现及证据范围。疑似页可以展示其分析报告，但不改变判定等级。

主报告接收结构化的页面分析结果、子报告内容或路径及证据引用，完成以下行为：

- 页面分析区域展示末次残留、判定、疑似／确认发现和查看子报告入口。
- 在主报告内部打开嵌入的子报告，支持从结论和图中标记跳转；展开必要的父级折叠区。
- 子报告可独立打开，同时随主报告交付。主报告通过相对路径按需加载同目录的页面 HTML，并提供保存链接；不把大体积的全量归因报告重复嵌入主报告或 `analysis.json`。整体目录可离线阅读，重新渲染到另一目录时一并复制子报告，不依赖外部上传链接。
- 子报告中保留 analyzer 的结论强度、覆盖范围和证据缺口，主报告不另写相冲突的结论。
- 主报告单独嵌入 Trace 中提取并校验的堆快照，供离线详情面板使用；原始 Trace 仍独立保存。

本流程使用 analyzer 的本地报告输出进行组合；对外上传主报告或子报告属于另行指定的交付方式。

### 8.6 豁免、过滤与重新分析

已支持的 BTS residual 已知非泄漏规则版本为 `bts-residual-2`：

| 规则 | 识别依据与报告说明 |
| --- | --- |
| `debugger` | 分配统一收敛到 native `[debugger]` 节点，属于调试器内存，可忽略。 |
| `builtin-function` | Function 没有 JS 字节码或源码位置，并由可追溯到引擎 context 的内置原型／构造函数方法持有，例如 Object.valueOf、Array.indexOf。内置函数可跨页面存活；其独占属性存储和名称字符串一起计量，不扩展到任意附属对象。 |
| `object-shape` | `object shape` 类型的引擎对象布局元数据，可忽略。 |
| `gc-atom-string` | 仅适用于 GC 模式，检查全部原始非 weak 入边，字符串唯一持有者是同一个 atom_array。说明这是 GC 引擎实现造成的残留，展示实际 KiB，可暂时忽略；相同页面再次加载会复用字符串。 |
| `vm-current-app-id` | 字符串仅由 VM 全局对象的 currentAppId 及其独占属性存储持有，可同时有 atom 簿记边。通过有根路径的 jscontext 的 internal global_obj 边核实全局对象，并检查全部原始非 weak 入边。currentAppId 是 VM 全局变量，下次页面加载覆盖旧值并释放前一页面创建的字符串，因此可忽略，不认为是泄漏；适用于 GC、RC 和未知模式。普通对象的同名属性、其它业务持有者或共享属性存储不适用。 |

字符串若同时有其它持有者，不能仅凭当前快照命中 atom 规则。连续观察中，若相同 slot 中的唯一字符串值及大小
已在早期快照证实只由 atom_array 持有，后续仍在 atom_array 中且新增持有者全部来自其它 slot，则记录早期命中证据，
说明后续页面复用了已有字符串；不靠跨快照对象 ID 推断身份，不扩展到从未有 atom-only 证据或存在重复值的字符串。
RC 模式不应用 atom 字符串规则。只凭名称 Function、Object 或 atom_array 不能豁免整个对象图。

analyzer 在每份快照的 `residual` 中保留规则版本、命中节点、原始持有者证据、互不重叠的 shallow bytes 和未分类对象。
规则判定仅覆盖本页分配；零大小的外部 holder 节点不计入本页残留。未分类对象继续分析，不自动判断为泄漏或已知非泄漏。

### 8.7 残留持有者来源分解

来源分解接受 analyzer 在本次调查中已识别的**任意持有者节点**，包括普通对象、closure 和 native holder，无持有者名称白名单，也不要求固定 global／构造器模式。例如正文已分析出 `_$factoryCache`、`sharedData`、`__Engine`、`moduleCacheMonitor`，就以这些持有者的节点证据进行归属；不能因为 `__Engine` 不在缓存名单而遗漏。标签只用于展示，不承担节点匹配或 VM 级生命周期证明。

analyzer 在 `snapshots[].residual.cache_retention` 输出全量未分类分配的持有证据，字段名为兼容保留，新版本为 `holder-retention-2`。从每个所选持有者沿强边遍历，在其它所选持有者边界停止，跳过 weak／引擎簿记，阻止通过回指公共 global 或支配源持有者的祖先节点将整个运行时归给它。每个分配保留全部命中的近端持有者及可复核路径、其它强根路径标记；GC 模式另外记录原始 atom_array 入边，RC／未知模式不继承该语义。没有确立强根的 native 分配保留待核实。

finding 声明 `allocation_breakdown: {evidence_ref: "/snapshots/N/residual/cache_retention", node_ids: [...], holders: [{label, evidence_ref}]}`。每个 holder 引用必须位于本项已有 query／snapshot 证据内，定位同一快照哈希及具体 ord/id；禁止引用待生成的 cache_retention 形成循环。`holders` 没有十项上限，独立于展示锚点，不从正文名称猜测，也不因为正文链接数量限制而遗漏持有者。一个快照使用其所有 finding 声明的持有者并集；同名不同节点分别归属，同一节点的多个标签合并。

analyzer 在成稿前执行 `render-report.js --analysis analysis.json --attribute-residual --finalize --format json ...`，重新读取原始快照并核实哈希、节点和分配大小；之后渲染、导入不再需要原始图。`node_ids` 精确选择该项讨论的分配，“其余残留待核实”排除已计入泄漏下界的节点。选择范围、来源声明、快照身份、全量覆盖及浅层大小在 analyzer 和导入层校验；不同 finding 不重复计量同一快照节点。旧 v1 测量仍可读，新分析使用 v2。

主报告及子报告展示来源、浅层字节数、对象数、分配与持有路径、其它保活证据和合计。按“持有者集合＋其它根标记”生成互斥行，共同持有的分配只计一次。每行最多展示 10 个代表对象，但统计覆盖全部所选对象；零大小 holder 可跳转，不参与字节求和。归属大小不是断开引用后的可回收量，也不改变已有泄漏／非泄漏判定。

来源表按归属字节数**从高到低**排列，相同大小保持原顺序。第一列在来源名称之后展示圆角背景标签，保持原列宽，标签可整体换行。采用用户指定的 `residual-source-labels-1` 标签规则：`moduleCacheMonitor`、`_$factoryCache`、`_$loadScriptCache`、`__Engine` 精确命中时显示黄色“非泄漏”；其它已归属来源显示红色“泄漏”。多个持有者或别名必须全部命中该名单才显示“非泄漏”，任一个未命中即显示“泄漏”；匹配原始标签，不使用附加节点 ID 后的展示文本。没有已归属持有者的行显示“待核实”。中英文主报告分别使用“泄漏／非泄漏／待核实”和“Leak／Non-leak／Needs verification”。

来源表中任意一行显示“泄漏”时，“其余残留待核实”等所属 finding 的标题也显示红色“泄漏”标签，替换原展示状态标签；没有泄漏行时保留原标题状态。主报告和子报告同步联动，中英文分别显示“泄漏／Leak”。

该名单决定来源行及其标题的展示标签，不限制通用持有者发现与归属，不改写分配证据、finding disposition、已知非泄漏量或已有泄漏下界。

“分配与持有路径”列中的字符串节点展示实际内容预览，使用与快照详情相同的字符串绿色（浅色主题 `rgb(0, 128, 0)`），节点 ID 和跳转保留。预览不包含单独的 slot 元数据后缀；按 Unicode 码点保留前 128 个字符，超过时追加 ASCII `...`，不截断代理对。analyzer 从已核实哈希的原始快照生成可选 `string_preview: {text, truncated}`，不复制完整长字符串；导入后为 sample 的 `stringPreview`。显示时转义 HTML；旧证据缺少预览时回退类型／ID，不猜测字符串内容。主报告、子报告使用相同规则。
首行固定显示类型、可跳转的节点 ID 和大小，例如 `string @11951 · 80 B`；绿色字符串内容单独显示在下一行，持有路径继续显示在其后。
字符串预览用双引号包裹，内部引号、反斜杠等按原文显示，不添加字符串转义；包裹引号不计入 128 字符限额。
字符串预览字号与持有路径统一为 `12px`，小于第一行的节点摘要字号。

验收示例：`leak-example-gc` instance 1 的 200 B 仍为 monitor／factory 共同持有的 80 B 和 sharedData 的 120 B，并保留 GC atom_array 共持说明。instance 2 的 137440 B 中，`__Engine` 应归属 1032 B（10 个 closure 共 960 B＋一个对象 72 B），不得落入“未归属到所选持有者”；总量不变且不重复计入已有泄漏下界。

其它业务豁免规则由用户明确提供识别方法，整理为可复核规则；没有指定时不自动增加业务豁免。

每条规则至少记录稳定标识、版本、适用范围、匹配依据、作用对象、处理方式和说明。不能以某次快照的偶然对象 ID 作为跨任务规则，也不能仅因 URL 相同就豁免所有残留。

规则生效后重新执行受影响页面的分析，产生新定稿结果：

- 保留原始快照和原始残留值；豁免不改写 Trace。
- 保存命中证据和排除说明，更新有效发现、计数、结论、图中标记和子报告。
- 全部确认发现被排除后移除该页面泄漏标记，但保留可查看的排除记录。
- 回填结果携带输入摘要、分析器版本和规则版本。摘要覆盖 Trace 时间边界、页面和 VM 身份及完整快照序列的元数据与哈希；不匹配时拒绝回填。每次重新分析导入新的定稿结果，不隐式复用旧结论。

## 9. 报告与用户交互

**维护约定：报告内容更新需要适配中英文。** 新增或修改任何用户可见的报告内容时，必须在同一次更新中同步维护中文和英文文案，覆盖静态界面与动态分析结果，并验证双向语言切换后内容完整、语义一致。

### 9.1 主报告结构

交付物为可整体移动的目录，`report.html` 为入口，默认中文，支持英文切换。Trace 基础信息和统计摘要置顶；主报告按以下最多八个一级栏目排列，其中 Graphic 栏目按数据条件显示，不再使用“进一步分析”标题：

1. 前置说明，其后放置共享 BTS VM 名称过滤器。
2. 页面实例分析，按创建时间排序。
3. 异常 MTS 虚拟机缓存池归属。
4. 共享的 BTS 虚拟机 Slot 内存，包含 VM 图及两项分析。
5. BTS 页面退出残留分析，包含页面 residual 结果及子报告入口。
6. Graphic内存分析，仅在存在全局 Krypton 轨道时显示，包含 Krypton 与 AnimaX 合并的资源内存面积图和 Krypton 资源计数折线图；有同进程 `summary.graphics` 时叠加独立折线，详见第 9.7 节。
7. JS 引擎堆快照。
8. 结论。

左侧固定显示目录，随主报告滚动保持可见，超出视口时目录独立滚动。目录与以上栏目顺序一致；
页面实例分析下按创建顺序显示“页面 1、页面 2……”子项，BTS 页面退出残留分析下按正文顺序显示
真实的 `instance_id`（如 `instance 1`），不重新编号。页面序号在过滤时保持稳定。
点击目录自动展开目标页面／residual 卡片并滚动定位，当前阅读位置在目录中高亮。
章节和子项使用稳定锚点，支持直接打开链接及浏览器前进／后退；语言切换同时更新目录。
窄屏（宽度不超过 1000px）时，目录改为顶部固定的可折叠菜单，默认收起，选择目标后自动收起并避免遮挡目标标题。

主报告中的动态发现标题、结论、限制说明、证据缺口、豁免原因和泄漏量口径均随语言切换，
包括由它们派生的 issue 文本与图表提示；采集原因、完整性和判定状态也使用双语标签。
对象名、快照 ID、代码和证据指针保留原值。翻译只影响展示，不覆盖 analyzer 定稿中的原始发现，
且两种语言保留相同的数值、结论强度与证据边界。

页面标题显示完整 URL 并可换行，附 instance 和重复加载序号。基本信息包括 MTS／BTS 类型、VM 名称和 generation、slot、共享状态、两种生命周期及可计算的存活时长。

页面和 VM 章节均可点击标题展开／收起，内容包含图表及分析结果。同组 PSS 结果显示在各成员页面，并突出说明“数据属于这些页面整体”，不复制成多个独立 issue。

含 Graphic 组件的页面卡片按第 5.5／5.6 节显示对应图表；页面与新增的 Graphic 栏目、图表标题均支持展开／收起。以下新增文案须同步支持中英文：

| 中文 | English |
| --- | --- |
| Graphic组件内存占用 | Graphic Component Memory Usage |
| Canvas组件图形资源计数 | Canvas Graphics Resource Counts |
| Graphic内存分析 | Graphic Memory Analysis |
| Graphic资源内存 | Graphic Resource Memory |
| Krypton图形资源计数 | Krypton Graphics Resource Counts |

资源估算、已知分项合计、占比、字段缓存、缺失／歧义和 Shell 事件说明也须双语；组件名称、资源 key、轨道名称和证据 ID 保留原值。

### 9.2 前置说明

只对当前数据实际命中的情况给出说明：

- 指定 URL 外还存在至少两个无关 URL 时，提示减少无关页面加载。
- 目标页面存在创建重叠时，说明单页面 PSS 归因受干扰。
- 宽泛分析中，本次新建且未退出的页面超过全部观察页面的三分之一时，说明存活页面增加会推高进程内存。
- 建议优化录制时，可提示减少无关卡片，或通过回放在 LynxExample 复现。
- 预加载、容器实例池和容器未释放可作为需要核实的方向，不作为没有证据的确定结论。

缺少 PSS、VM 内存或 analyzer 时分别说明受影响的子项，保留其它可以完成的分析。

### 9.3 过滤器

每个共享 BTS VM 名称生成一个默认勾选的复选框，名称不含 generation。勾选立即联动：

- 使用所选名称的页面实例。
- 对应的所有 VM generation 图表及 VM 分析。
- 对应页面的 residual 结果、疑似／确认发现和子报告入口。
- 结论中的相关问题，以及可见页面数、问题数、确认泄漏页面数。
- 目录中的页面／residual 子项，隐藏无匹配目标的条目并同步当前项；一级栏目保留，便于跳转查看空状态。
- 页面 Graphic／Canvas 图随所属页面卡片过滤；全局 Krypton 图中的页面气泡随可见页面过滤，但进程级曲线及整个 Trace 的 x 轴范围保持不变，不将过滤后的气泡误认为全局内存只属于这些页面。

存在共享 VM 过滤器时，页面按其是否使用选中名称决定可见性；没有共享 VM 时不设置这组过滤限制，正常展示其它页面。无匹配内容时显示明确空状态。

切换语言、折叠／展开不重置过滤器与图例状态。报告层面的隐藏不改变已完成分析的结论；豁免规则导致的重新分析则按第 8.6 节更新结果。

### 9.4 图表公共规则

- 数值显示单位，保留零基线、负增量和完整时间范围。
- 点击图例切换对应序列显示，隐藏后悬停也遵循可见序列。
- 页面 URL、对象标签等文本正确转义；长 URL 可在扩展 tooltip 中换行。
- 同时刻事件仍可区分，显示各自身份，不将重叠事件静默覆盖。
- 无数据或样本不足显示原因，不用空白图暗示无问题。

### 9.5 JS 源码绑定、快照清单和用户指定分析

在 **“JS 引擎堆快照”一级栏目**中，依次展示“JS 源码来源与绑定状态”和“快照清单”两个二级标题。
两者都加入左侧目录，作为该一级栏目的子项，使用稳定锚点，支持跳转和当前项高亮。
所有业务工程、Lynx 公共脚本、未选中的构建候选、未引用产物和用户同意跳过的工程都必须可见，
不能只展示匹配成功的源码，也不能仅放在报告页头或要求用户阅读 JSON。

源码状态只保留一张来源清单表，不展示“各快照脚本的绑定与可用性”标题或其明细表：

| 表格 | 每行范围 | 必须展示 |
| --- | --- | --- |
| 源码来源清单 | 一个已提供 JS/map 产物，或没有产物的工程 | 工程 ID、业务／Lynx 类型、本地目录或 Git URL、请求 ref／实际 commit、Lynx 平台与请求版本、生成 JS 与 map 完整路径（注明内联 map）、已校验原始文件数量、准备及使用状态、JS/map SHA-256、跳过原因 |

已绑定的产物显示绑定的快照脚本数量，绑定状态文字使用绿色；没有绑定的产物及无产物工程整行文字变灰，
包括路径、版本、哈希和原因。继续用文字区分候选但未绑定、已提供但未引用、用户同意跳过和清单缺失，
不只依赖颜色表达状态，也不把未绑定解释为全局不可用。

绑定统计使用各快照保存的选中结果；同名但不同 script ID 的记录保留，script ID 不跨快照合并。
详细候选、定位结果和诊断仍保存在分析数据与快照查看器中，不在主报告展开第二张表。
函数偏移匹配不等于捕获脚本的完整哈希校验，不提升源码身份置信度或改变泄漏结论。
准备记录也不保证来源文件当前仍在本机。

所有标题和状态支持中英文；路径、版本、URL、诊断正确转义，长路径自动换行，小屏表格可横向滚动。
snapshot ID 沿用快照查看入口。没有源码资料、没有脚本／位置记录或旧报告缺少清单时显示明确空状态或
记录缺失说明，保留快照浏览功能。

快照清单包含范围类型、所属 VM generation、页面／slot、序号、snapshot ID、时间、完整性，以及适用的 residual 元数据。

每个具体 VM generation 下的快照按时间和 slice ID 从 1 编号，页面 residual 序列可另有页内序号，两种序号必须注明范围。不能将同名 VM 的不同 generation 混成不明确的“第 N 份”。

用户明确指定快照时，解析到唯一 snapshot ID 后提取并交给 analyzer，保留既有手动分析能力。只有用户的选择仍有歧义时才询问；不为 residual 自动流程额外增加确认步骤。

### 9.6 结论与异常恢复

主报告区分一般内存 issue、确认页面泄漏、待核实发现和证据缺口。一般 issue 包括高内存页面、MTS 池增长、VM 未销毁和 VM 整体趋势，不自动计入确认泄漏。

聊天回答保持简短：先说明当前规则发现的问题，列关键数值与置信度，优先用户指定目标，并给主报告链接。

完整运行且未命中高／中置信度规则时，可表述“当前规则未检测到高或中置信度内存问题”。若仍有未分析页面、疑似项或不可用证据，须一并说明；不能把未完成分析概括为“没有泄漏”。

analyzer 不可用时提示所缺能力，继续生成基础主报告，residual 状态为未完成。某页失败不阻断其它页面。

### 9.7 Graphic 内存分析

在存在全局 Krypton 轨道时，于“BTS 页面退出残留分析”之后、“JS 引擎堆快照”之前，添加独立一级栏目 **“Graphic内存分析”**，并同步左侧目录，保留稳定锚点。没有全局 Krypton 轨道时，正文栏目和目录入口均省略，不显示空栏目；仅有 AnimaX 或 `summary.graphics` 不触发该栏目。页面自身的 Graphic／Canvas 图不受此条件影响。

对每个有数据的进程，依次展示以下两图。删除“进程 upid=...”标题；进程身份保留在结构化数据中，多进程的数据仍分别聚合，不混堆。

1. **“Graphic资源内存”**：按第 3.3 节选择 `Krypton*Mem` 轨道，每条 bytes 轨道为一个阶梯堆叠面积分项，并加入同进程各 AnimaX 类别的页面估算分量，使用原始组件名称；x 轴覆盖整个 Trace，y 轴为 bytes，按 KiB／MiB 展示。面积图合计、占比、峰值及末值均包含 AnimaX。`KryptonTotalMemEst` 不加入堆叠，保留为 Krypton 部分的核对值；另提供 `KryptonTotalMemEst + AnimaX` 的 Graphic 总估算对照，缺失来源时标记为已知部分。不得再叠加页面 Canvas 明细。
2. **“Krypton图形资源计数”**：同一进程每条 `Krypton*Cnt` 轨道分别绘制阶梯折线，x 轴同样覆盖整个 Trace，y 轴为数量。包括总对象、WebGL 对象和 surface 计数，但不把总计和子类相加。

若该进程同时存在唯一的 `summary.graphics` 轨道，在 **“Graphic资源内存”** 面积图上追加一条独立红色细折线（`#dc2626`，线宽 1.25 CSS px），标签保留 `summary.graphics`。以实际轨道是否存在为条件，不按平台名称推测；Android 可能上报此轨道，其它平台缺少时保留原面积图。该线为系统上报的进程图形内存，与资源估算口径不同；共用时间轴和 bytes 纵轴，纵轴范围同时覆盖面积堆叠与该线的最高值，绝不把它叠加到面积高度、资源合计、占比分母、峰值分析或 Graphic 总估算对照。tooltip 仅显示该线的绝对值，不显示分项占比；支持独立图例开关。按自身采样时刻连接折线，首报前未知，真实零值保留，末值可保持至 Trace 结束；缺失/无效区间不补成零。同进程多条同名轨道或进程归属不明时不猜配、不跨进程合并，说明不可用原因。

两图按真实采样时间对齐，采用相同完整时间范围；Krypton 首样本前未知，真实零值保留，末值保持到 Trace 结束。AnimaX 按真实 Shell 页面生命周期聚合，每页每个类别的 `sizeBytes` 只计一次，同名类别在同时存活的页面间求和；页面首次上报前及缺失字段为未知，部分页面有值时保留已知部分并标注覆盖不足，不能因一个页面缺失而丢掉其它页面的值。生命周期外该页不计入聚合；这表示页面估算范围结束，不作为实际释放证据。未销毁页面的最近有效值保持到 Trace 结束。采样时刻与页面生命周期端点共同参与时间对齐。固定分项顺序和颜色，支持图例开关、单点、tooltip 与部分数据说明。隐藏图例不改变全部已知 bytes 分量的比例分母，零合计时比例为零。所有分项缺失或某类轨道不存在时分别说明，不用另一种单位填补。

**两个图的 x 轴下方均添加页面生命周期气泡**，布局、颜色区分、重叠处理和悬停样式复用“共享的 BTS 虚拟机 Slot 内存”，但事件集合限定如下：

- 页面须在自身可观察生命周期内出现过 Graphic 类别，且与当前 Krypton 轨道属于同一进程。AnimaX-only 页面也符合条件，即使其生命周期内 Krypton 没有更新；它们仅提供上下文，不代表全局内存归因。
- 只使用真实的 `LynxShell::Create` 开始时间和 `LynxShell::~LynxShell` 结束时间；气泡位置不使用页面图起点的 200 ms 前移量。
- 不显示 `page_uses_bts_vm`、`BTSRuntime::Destroy`、VM 创建／销毁、GC 或快照气泡。缺少 Shell 创建／销毁事件时不补造事件；销毁时长未知时不伪造结束时间。
- 每个 Shell 事件在每张图中只出现一次，多个 Graphic 类别或多个 Canvas UI 不增加重复气泡。同一时刻多个页面／事件保留各自身份，不能相互覆盖。
- 气泡 tooltip 显示创建／销毁类型、事件名、slice ID、真实 `instance_id`、完整 URL 和时间；上下两图使用相同事件集合。页面与轨道进程归属不明时不跨进程猜配，并说明缺口。
- 页面选择或共享 VM 过滤只过滤气泡和页面卡片，保留进程曲线、总量和整个 Trace 的时间范围。状态在语言切换和折叠后持久化。

Graphic 图表用于观察 Krypton 进程资源与 AnimaX 存活页面估算的变化，不依据气泡相邻关系、某次归零或某页退出后的全局残留直接确认页面泄漏。页面选择及共享 VM 过滤不裁剪 AnimaX 分量或总量。

## 10. Query API 与报告数据契约

### 10.1 确定性能力

保留以下基础入口：

```bash
node <skill目录>/scripts/trace_query.bundle.cjs memory-analysis \
  --path "<trace路径或URL>" \
  --output "<产物目录>"

node <skill目录>/scripts/trace_query.bundle.cjs memory-snapshot \
  --path "<trace路径或URL>" \
  --snapshot-id "<snapshot_id>" \
  --output "<临时目录>/<文件名>.heapsnapshot"
```

内存分析选择参数为 `--url`、`--instance-id`；滚动参数为 `--scenario scroll --start <绝对毫秒> --end <绝对毫秒>`。

查询能力包括：

- 页面／VM 清单及身份关联。
- 某时刻 VM Accumulate／RSS、源样本身份及可用性。
- 某时刻共享 VM 的 BTS 存活页面集合。
- 页面和 VM 图表、PSS／池增量、稳健趋势。
- Graphic 页面识别、CanvasApp 去重、bytes／count 分类、AnimaX 已聚合估算值、页面图形图表，以及全 Trace Krypton 图表和 Graphic 页面的 Shell 事件集合。
- 所有快照元数据，以及按页面组织的 residual 序列。
- 单份快照提取、完整性和哈希。

`queryMemoryAnalysis` 提供基础分析和序列；`prepareMemoryResidualAnalysis` 完成逐份提取与输入摘要。
`queryVMMemory` 提供某时刻的 VM 数值和源样本信息，`querySharedBtsLoadedPages` 提供共享 VM 的存活页面集合。
Skill 不自己完成这些确定性计算。

CLI 默认输出完整数据到 `<报告路径>.json`，residual 文件到 `<报告路径>.snapshots`。
非 residual 快照在清单中保留未提取状态，按明确选择通过 `memory-snapshot` 提取。

### 10.2 结构化结果

查询和分析结果提供以下信息：

| 数据对象 | 必须包含的信息 |
| --- | --- |
| Trace 信息 | 时间边界、内存采集状态、相关进程 |
| 页面／VM | 身份、生命周期、类型、共享关系、generation、slot、轨道绑定状态 |
| 页面图形数据 | 是否含 Graphic／Canvas、原始组件名称、CanvasApp 去重范围／依据、资源 key 与单位、AnimaX 聚合值、源 track／counter ID 与样本时间、有效性／缺失／冲突原因、缓存及估算说明、页面内存面积与计数序列 |
| 全局 Graphic 数据 | 进程身份、按 track ID 区分的原始 Krypton 轨道名、AnimaX 原始组件名及页面聚合范围、bytes／count／总量核对分类、包含 AnimaX 的合计与总估算、完整 Trace 边界、真实样本与保持区间、部分覆盖状态、图例稳定 key，以及关联 Graphic 页面的真实 Shell slice ID／事件时间 |
| 快照 | 范围类型、身份、事件时间、采集元数据、归属、完整性、文件与哈希 |
| residual 序列 | 分组键、全部采集记录、末次有效值、末端覆盖、退出及后续加载上下文 |
| 页面 residual 结果 | 分析状态、结论等级、置信度、全部发现、证据引用、原始残留与可量化泄漏量、豁免记录 |
| 子报告 | 页面身份、独立报告文件、嵌入所需内容及主报告定位目标 |
| 运行信息 | 输入快照哈希、analyzer 版本、规则版本、完成／失败范围 |
| 汇总 | issue 总数、确认泄漏页面数、待核实页面数、未完成／证据不足页面数 |

### 10.3 分析与渲染阶段

一次完整 Skill 执行包括：

1. Query API 产生基础数据和 residual 分析清单，可输出标注“快照分析待完成”的基础报告。
2. Skill 提取文件并编排 analyzer，获取每页结构化定稿结果及子报告。
3. 将结果回填报告数据，再生成最终主报告。报告生成器不自行从数值推断泄漏。

完整数据的 `schemaVersion` 为 4。`residualAnalyses` 保存每页序列，`snapshots` 保存采集与提取元数据。
回填清单的 `schemaVersion` 为 1，形状为：

```json
{
  "schemaVersion": 1,
  "translations": {
    "<原始发现标题>": {"zh": "<中文标题>", "en": "<英文标题>"},
    "<原始发现结论>": {"zh": "<中文结论>", "en": "<英文结论>"}
  },
  "pages": [{
    "analysisId": "<页面 residual 序列 ID>",
    "inputDigest": "<查询产生的输入摘要>",
    "analyzerVersion": "<分析器实际版本或脚本哈希>",
    "rulesVersion": "none",
    "evidencePath": "instance-final.json",
    "reportPath": "instance.html",
    "decisions": [{
      "findingId": "<analyzer analysis.findings 中的 ID>",
      "disposition": "retained",
      "confidence": "high"
    }]
  }]
}
```

每条 analyzer finding 必须对应一个明确分类：`confirmed`、`suspected`、`retained`、`excluded`、`known-non-leak` 或 `information`。
分类依据是定稿发现的结论和证据，不从字节数计算。`information` 为统计观察，不表示无泄漏。
`excluded` 附带 `exclusion: {ruleId, version, reason, evidenceRefs}`。`known-non-leak` 还附带 `bytes`，
对应末次快照中的同名规则，并引用 `/snapshots/N/residual/rules/M`；各规则大小互不重叠。
全部末次残留均有规则证据且序列完整时，页面状态显示“已知非泄漏”；有未分类对象时保留实际分析状态。
可量化的确认泄漏可附 `leakBytes`
和说明去重方法、上下界的 `leakSizeBasis`；无法可靠量化时省略。

`translations` 以原始文本为键，提供 `{zh, en}`，可供多个页面共享。必须覆盖全部 finding 的标题、
结论和限制说明、analyzer 的 gaps、豁免原因及可选的泄漏量口径；缺少或为空的译文在回填时拒绝。
失败记录的 `error` 同样提供双语文案。每次回填替换该页的译文，避免沿用旧分析中的文字。

`applyMemoryResidualResults` 校验整个清单后替换对应页的结论，再重建计数、issue 和图中标记。
校验项包括输入摘要、定稿状态、末次有效快照哈希、全部 finding 的分类、证据指针及豁免信息。
只有清零元数据时直接显示清零；没有对象图不伪造 analyzer 报告。

某页无法完成分析时，清单可记录
`failures: [{analysisId, inputDigest, error}]`，该页显示失败及原因，其它页继续。
未包含在回填清单中的页面保留原状态。文件相对路径以清单所在目录解析。

```bash
node <skill目录>/scripts/trace_query.bundle.cjs memory-report \
  --data "<产物目录>/analysis.json" \
  --residual-results "<回填清单>.json" \
  --output "<产物目录>"
```

不传 `--residual-results` 时可直接离线重新渲染已有数据。异步 `generateMemoryAnalysisArtifacts` 输出完整目录；
`generateMemoryAnalysisReport` 是其中的 HTML 渲染步骤。旧 JSON 缺少 Trace 来源时，须补充
`memory-report --path "<原始Trace>"`。显式 `.html` 输出路径仍兼容，附属文件写入同目录。

目录包含 `report.html`、`analysis.json`、`residual-results.json`、各页面 HTML 和证据 JSON、
`snapshots/`、原始 Trace 与 `assets/`。路径以产物目录为基准；`artifacts.trace` 保存相对文件名、
字节数和 SHA-256。默认返回目录及入口链接，后续需要单文件时再压缩整个目录。

每次生成或重新输出报告，交付回复必须同时汇总产物体积：列出主报告、各页面 HTML、
证据 JSON 和分析数据等主要文件；快照、Trace、assets 等可按目录或类别汇总，并给出
目录递归文件总计。以实际文件字节数计算，统一明确标注 MiB（1 MiB = 1,048,576 B），
不使用磁盘块占用代替文件大小，不混淆单文件体积与多个文件的合计。

Issue 和 finding 的证据快照链接来自已验证证据指针及快照 SHA-256，不从结论文字猜测。
点击后，在主报告右侧覆盖展开快照详情；点击左侧空白、关闭或 Escape 收起。复用 Trace 网页的
列表、对象、出边、Retainers、对比与下载组件，按 `(id, snapshot_id)` 定位，不依赖内部 slice ID。
对象链接在 Summary 原有类型分组内展开并选中对应节点，自动展开该节点的出边树、滚动到可见位置，
并显示 Retainers；不另设“Located object”区域或重复插入普通对象。目标在后续分页时，
直接加载目标所在页，并支持向前／向后加载和显示全部。零大小 holder／synthetic 节点不属于统计分组时，
直接显示可展开的节点行，不改变类型统计。节点 ord/id 必须一致，快速切换链接不得回填旧请求结果。
生成时提取 Trace 中全部 snapshot_chunk，按顺序拼接并校验后以惰性读取的 JSON 嵌入主报告。
校验源 Trace SHA-256 和已有快照 SHA-256，缺失的提取文件从 Trace 恢复。
HTML 中转义 `<`，防止快照字符串提前结束 script 标签；原始快照不重复写入 analysis.json。
无快照的指标 issue 不伪造对象证据；
清零元数据不提供不存在的对象图。快照序列表同样提供跳转。

HTTP/HTTPS 和双击本地 report.html 均直接读取嵌入快照，无需手动选择 Trace 或启动本地服务。
首次展开详情时向共用 viewer 传入快照数据，后续仅传选中项；缺失、损坏或清零记录显示说明。
快照详情使用与主报告同源的 `srcdoc` iframe；外置样式、脚本仍从 `assets/` 加载。
本地 `file://` 不能直接加载另一个 HTML 文件作为该 iframe，否则浏览器会因跨源拒绝
`showSaveFilePicker`／`showDirectoryPicker`，导致列表右键下载失败。
验收覆盖单个快照保存、目录导出、取消保存，以及不支持原生保存 API 时的普通下载。
代码与字体随 assets/ 目录交付，可离线使用，报告不再包含 WASM Trace 解析器。

源码构建先运行 `ui/build`，再构建 trace-query。`build:report-viewer` 从共享 UI 源码打包，
使用 UI 构建对应的字体；`generate-skills` 将运行资源一并复制到 skill 的
`scripts/report-assets/`。使用已发布的 CLI/skill 不需要本机编译 UI。

## 11. 验收场景

### 11.1 基础分析

| 场景 | 预期 |
| --- | --- |
| `enable_memory_trace=1` | 正常进行内存分析 |
| 未启用内存 Trace | 明确终止内存分析，不产生无数据的正常结论 |
| Trace 前已存活、未销毁、无 BTS 页面 | 生命周期与可用子项正确，缺失不当作释放 |
| 同名 VM 重建或指针复用 | 页面、轨道、GC 和快照不串 generation |
| 轨道首样本略早于 VM 关联事件 | 依据生命周期交集正常绑定 |
| 无轨道或多个候选轨道 | 停用对应 counter 分析，保留独立可用证据 |
| PSS 回落成功 | 图表最后一点与回落 delta 一致，两个源样本可定位 |
| MTS 多池、池销毁、global_pool | 按最新池状态和 URL 聚合，包含负增量 |
| GC 趋势 2／3／9／10 个样本 | 分别验证不足、稀疏原值和密集平滑规则 |
| BTS 图 | 无 RSS 序列，保留 slot、GC、生命周期、快照和 VM 两项分析 |

### 11.2 Residual 与结论

| 场景 | 预期 |
| --- | --- |
| 一个页面多份相同范围快照 | 保留完整序列，按 snapshot ID 提取 |
| 只有一份 residual，后续加载次数为 0 | 仍进入分析，由证据决定结论，不因次数直接拒绝 |
| 多份残留量相同 | 检查稳定残留对象，不因无正增长漏掉目标 |
| 触发值大、采集后残留很小 | 使用 `retained_bytes` 描述末次残留，不按触发值认定泄漏 |
| 残留下降、清零、重新出现 | 保留过程，以末次有效观察更新状态，不提前结束 |
| 有末尾损坏快照 | 显示末次有效值及覆盖缺口，不宣称已确认最终稳定 |
| 未知采集原因 | 保留原值，身份和内容合法时继续 |
| slot 2／身份冲突／外部持有者 | 不把共享或上下文内存全部归给单页 |
| analyzer 仅给疑似 | 展示待核实发现，无确认泄漏标记和计数 |
| analyzer 确认泄漏 | 每实例有独立定稿报告，主报告与 VM 标记可跳转 |
| 发现提到具体对象或引用实测节点 | 必须返回非空 `representative_objects: [{label, evidence_ref}]`（最多 10 项），复用当前发现证据中的快照哈希与节点 ord/id；无法唯一绑定时须给出 `object_anchor_gap` 原因并作为中英文限制展示。finalize 与 Trace 导入拒绝节点证据既无锚点也无缺口；纯统计项无需虚构对象。交付前核对中英文对象链接跳转到正确快照节点、展开滚动并显示 Retainers，支持零大小 holder；上限只限制展示链接，不限制分析对象数量；没有源码绑定不妨碍对象跳转 |
| 节点身份不匹配 | 拒绝选择并显示错误；不按同名对象或其它快照的序号兜底 |
| 展开／收起快照面板 | 保留滚动条占位，主报告位置与宽度不变 |
| analyzer 不可用或某页失败 | 基础报告与其它页面继续，明确未完成范围 |
| 新增豁免后重跑 | 命中记录可查，确认计数、图标、结论和子报告一致更新 |
| 切换过滤、语言、折叠状态 | 内容和计数正确联动，不丢失用户选择 |

### 11.3 示例 Trace

| 示例 | 模式 | 场景 |
| --- | --- | --- |
| [example-gc.pftrace](example-gc.pftrace) | GC | 连续加载同一页面并退出，核对已知非泄漏模式 |
| [example-rc.pftrace](example-rc.pftrace) | RC | 同上，核对 GC／RC 规则差异及 currentAppId 的通用规则 |
| [leak-exmaple-gc.pftrace](leak-exmaple-gc.pftrace) | GC | VM 级 sharedData 缓存持有退出页面创建的回调，明确泄漏样例 |
| [leak-exmaple-rc.pftrace](leak-exmaple-rc.pftrace) | RC | 同一泄漏场景，验证 RC 模式下的识别 |
| [graphics.pftrace](graphics.pftrace) | Android GC／图形 | instance 1 使用多个 canvas-ng，instance 2 使用 animax-view，验证页面资源去重、估算面积、全局 Krypton 图表及 summary.graphics 折线 |

用户提供以下代码演示该类泄漏：

```js
lynx.setSharedData((new Date().getTime()).toString(), () => {
  console.log("1234");
});
```

`lynx.setSharedData` 是 VM 级缓存。本段代码示例用时间戳键写入回调，演示缓存条目未释放时回调越过页面生命周期的问题。
时间戳仅是该示例的选键方式，不是通用泄漏规则；不能按数字位数筛选键，也不能从快照里的数字键反推实际生成方式。
分析应结合用户提供的场景、实际属性持有链、
页面退出时间和同页 residual 序列，区分明确泄漏与其它运行时缓存残留。不能把整个 slot 的残留都作为泄漏量，
也不能把裁剪后单页快照中的键数量作为整个 VM 的缓存条目数。

四份 BTS 样例用于核对页面／VM／slot 身份、残留快照顺序、采集前后数值、同页连续观察，以及非泄漏规则与明确泄漏的区分。
分析时以文件内的实际元数据和对象证据为准；示例文件可替换，本文不固定快照数量、对象数量或内存数值。

### 11.4 Graphic 与 Krypton 图表

| 场景 | 预期 |
| --- | --- |
| 同页多个 canvas-ng 读取同一 CanvasApp | bytes／counts 各取一份；不使用重复累计的 `sizeBytes`，不乘除 `instanceCount`，不叠加 App 总量 |
| 同一 App 经多个类别上报，或存在可辨认的多个 App | 按已验证 App 身份去重后再聚合；字段冲突或 App 身份不足时说明歧义，不按数值相同跨页面去重 |
| Canvas detail 的数字／数字字符串、未知资源 key | 解析合法数值；动态保留 `.bytes`、`.count` 和 `total.object_count`，不遗漏新增 audio 分项 |
| `sizeBytes` 存在但缺少 Canvas detail | 说明分项不可用；不拿 `sizeBytes` 或全局 Krypton 值替代，保留可用的 AnimaX 分项 |
| 页面同时包含 Canvas 与一个或多个 AnimaX 类别 | 同一面积图展示去重 Canvas bytes 和各 AnimaX 类别聚合值，AnimaX 图例使用原始类别名；计数图只展示 Canvas 资源 |
| 只有 AnimaX，或 AnimaX 仅有一条样本 | 展示 Graphic 面积图和单点／保持区间，注明估算和稀疏样本；不生成 Canvas 计数图，不拆造 AnimaX detail |
| 缺字段、负值、无效字符串、全零及页面 reporter 清空 | 未知与真实零分开；无效字段不夹为零；退出 `memory_N=0` 不作为资源释放证据，不伪造面积下降 |
| 全局 `Krypton*Mem`、`Krypton*Cnt` 和 `KryptonTotalMemEst` 并存 | bytes 分项与同进程 AnimaX 估算一起堆叠，counts 分别画线；合计与 Graphic 总估算均包含 AnimaX，总估算值不重复进入面积堆叠 |
| 多个页面的同名 AnimaX、缺失估算或页面退出 | 同名分量求和，每页仅一次；保留已知部分及缺失标记，退出后结束该页贡献，不宣称测得实际释放 |
| 没有全局 Krypton 轨道，仅有 AnimaX 或 summary.graphics | 省略 Graphic内存分析栏目及目录入口；页面 Graphic／Canvas 图仍按各页数据展示 |
| 同时有全局 Krypton 与同进程 summary.graphics | 在 Graphic资源内存面积图上叠加独立折线，共用 bytes 纵轴；它不参与堆叠、合计、占比、资源峰值或 Graphic 总估算对照 |
| summary.graphics 缺失、跨进程或同进程同名歧义 | 保留资源面积图；不补造折线、不猜配进程，歧义时说明原因 |
| 全局轨道异步更新、首样本晚、末样本早 | 在整个 Trace 时间轴中按每条轨道保持值，首样本前未知，末值延长到 Trace 结束，不将未更新轨道补零 |
| 多进程或同进程同名轨道歧义 | 按进程分别展示；候选轨道和关联页面身份可查，不混堆或猜配气泡 |
| Graphic 页面只有 Shell 事件或只有 AnimaX 数据 | 两张全局图均包含真实 Shell 创建／销毁气泡；不要求 BTS 事件或同时发生 Krypton 更新 |
| 普通页面、BTS 销毁、GC、VM 和快照事件 | 均不进入 Krypton 图的页面气泡集合；缺失的 Shell 端点不合成气泡 |
| 同时刻多个 Shell 事件、多个 Canvas 组件 | 按 slice ID 保留不同事件，同一事件每图只出现一次；tooltip 显示完整 URL 和真实 instance |
| 过滤、图例隐藏、折叠及中英文切换 | 页面图和气泡联动；全局曲线及 Trace 范围不变；占比分母稳定，状态持久化，新增栏目与目录顺序一致 |

`graphics.pftrace` 当前 Android 样例（SHA-256 前缀 `13218aa6`）的核对基准：页面 1 的 Canvas bytes 分项合计为 `101,568,528 B`，不能画成原始 `sizeBytes` 的 `203,137,056 B`；页面 2 的 `animax-view` 为 `62,325,760 B`，只计一次，并在全局 Graphic 面积图的对应生命周期内形成相同大小的分量，计入合计及 Graphic 总估算。全局 `KryptonTotalMemEst` 峰值 `112,203,760 B` 只用于核对，不能叠加到 Mem 分项之上；不同时间发生的峰值不相加。`summary.graphics` 单独绘制折线，其值不改变上述合计和占比。两个全局图都应出现页面 1、2 的 Shell 生命周期气泡，入口页面 0 不出现；AnimaX 页面期间没有 Krypton 更新也不删除其气泡。数值仅用于当前样例验证，不能写入分析逻辑。

## 12. 前端工程准备与快照源码定位

### 12.1 分析前置条件

用户可同时提供多个页面工程，支持第 4 节列出的 URL、commit、分支、本地目录及组合格式。
工程和已构建产物是两个独立输入：可分别为本地目录/文件、Git 仓库加 ref、源码或产物下载归档。
Agent 逐个读取工程指引；只有工程输入时，本地已有有效产物可以复用，Git 工程获取指定版本并记录
实际 commit 后构建。用户同时给出产物时，**不默认安装依赖或构建前端**，直接获取并验证指定产物，
不要求两者同目录或同仓库；只有用户明确要求替代重建时才重建。
任何活跃工程失败或缺少产物时都不能启动 Trace 查询或分析（第 4 节的版本预检例外）。
获取源码失败按第 4 节持续追问确切 URL/ref 及其它获取方式；依赖安装/构建失败暂停并询问
终止整个分析或跳过对应源码，不自动修复重建。仅用户明确放弃工程时才能从待完成集合中移除，
记录原因及用户原话；不能把环境、权限阻塞或重试次数当作放弃。
若用户已明确放弃全部工程，保留放弃记录后即可直接分析。

RSpeedy 的已知产物目录为 `leak-example/dist/.rspeedy/main/`，包含
`background.a3deaafc.js`、`background.a3deaafc.js.map`、`main-thread.js`、`debug-info.json` 等。
BTS 原始源码定位要求生成 JS 与匹配的 v3 sourcemap；JS-only 输入允许一级生成代码定位，
须明确原始源码映射不可用，不能将此等同于产物不匹配或强制重建。`debug-info.json` 是主线程 LepusNG PC 调试信息，
本例 `function_source` 与 `main-thread.js` 一致，不能用于 BTS Function 映射。

所有工程准备完成后，以列表展示工程 ID、原始工程与独立产物各自的来源/本地目录、Git 请求版本／实际
commit（如适用）、下载/解压记录、每个生成 JS 和 map 的
完整路径、异常警告和放弃记录，然后**直接继续分析，不要求用户确认产物是否正确或是否使用**。
之后构建、源码、版本或匹配选择器变化，重新准备和技术校验，不重新询问产物使用许可。
用户要求重新编译时必须使用本次新产物；hash 名称变化后仍保留真实文件名，由 Skill 在快照绑定时
检查匹配，不能通过重命名或用户确认强行映射。

**前端产物不匹配诊断与恢复：**

1. 展示 Trace 脚本地址、候选 JS/map 路径与哈希、偏移匹配/冲突数量及其计数单位、源码内容差异。
   有原产物时比较生成字节、长度、前缀/尾部和函数偏移，不能仅凭文件名 hash 推断实质变化。
2. 检查实际 config、其导入模块及构建脚本，追踪 `process.env`、`.env*`、CLI 参数、`NODE_ENV`/mode、
   dev/prod 条件、`ASSET_PREFIX`/`assetPrefix`/`publicPath`、define、platform/target、压缩器、
   sourcemap 和输出命名等。必要时结合锁文件、工具链/插件版本及构建日志。
   输出“**文件:行号 → 变量/条件 → 本次已知值与分支 → 可能影响的生成内容/偏移 → 录制时证据或未知**”。
   区分已验证原因与推测，敏感值脱敏；当前 shell 的值不能当作录制时的值。没有找到原因须直说并
   列出缺失证据，不改配置或自动重建用户指定的产物。业务源码不变也可能因注入 URL 长度变化而产生
   后续偏移变化，必须以实际配置和产物为证，不能预设为本次根因。
3. 暂停后给出三个选项：**终止整个分析流程**；**放弃对应前端产物辅助，继续分析**；
   **提供明确的产物地址**（本地文件/目录、Git URL+ref、JS/map/压缩包下载地址均可）。
4. 提供新地址后保留原始工程定位，重新获取、登记清单和执行相同匹配校验；匹配成功自动继续。
   仍不匹配或获取/校验失败时，更新配置诊断和差异证据，再次询问相同三项。
   **循环直到匹配成功、用户明确终止或放弃对应产物辅助，无固定重试上限，不根据沉默推断放弃。**
   显式产物的获取/校验失败也适用此循环；普通工程依赖安装/构建失败仍按第 4 节处理。
5. 替换或放弃后使该范围的旧定位缓存及已序列化定位结果失效，防止报告继续引用旧映射。
   放弃仅排除用户选定工程的产物辅助，继续使用 Trace/堆证据及其它有效源码，记录用户原话和归因限制。

例如用户说“Trace 中页面前端工程为 `xxxx`，产物已构建好，在 `yyyy` 下载”：获取 `yyyy` 后以其中
的压缩 JS 匹配 Trace location，换算生成行/UTF-16 列；再使用对应 map 将原始坐标定位到 `xxxx` 下
的源码。map 的构建机绝对路径或 `../src/...` 可以通过唯一后缀、内容一致性和根目录约束重定位；
不把 map 下载目录当作原始工程。原始源码链接指向 `xxxx` 或其已核实 commit，生成代码链接指向
下载的 JS；缺少匹配 map 时只展示后者。

实现使用 `frontend-prepare --config ... --output ...` 生成带内容哈希的清单，
所有 Trace 命令携带 `--frontend-manifest ...`，在 processor 初始化前复验指纹。
`frontend-confirm` 仅保留兼容性记录，不是分析前置条件。Agent 负责 clone／构建及检查后续
源码匹配结果、配置诊断与替代产物循环。`root` 始终指向原始工程；
`artifactFiles: [{script, map?}]` 指定独立产物（相对路径以配置文件目录为基准），替代 `outputDirs`
扫描，map 可与 JS 分开放置；未指定 map 时发现内联/相邻 map，否则保留 JS-only。`artifactOrigin`
记录产物来源，不能覆盖工程的 `origin`。配置及完整命令见
[前端工程准备指南](../references/frontend-sources.md)。

### 12.2 已验证的 Function 映射链

以 `12745.heapsnapshot` 中 `Function @16581` 为例：

| 环节 | 证据／结果 |
| --- | --- |
| 节点 | nodeIndex 449；`node_fields.length=6` |
| location | `[2694, 4, 39549]`，`2694 / 6 = 449` |
| 脚本身份 | `primjs_sources` v1 将 script_id 4 解析为 `file://view3/.rspeedy/main/background.a3deaafc.js` |
| 原始偏移 | `source_offset=39549`，零基 UTF-8 字节偏移 |
| generated position | 本例生成 JS 为单行且前缀为 ASCII，得到 line 1、零基 UTF-16 column 39549 |
| 原始源码 | v3 sourcemap 映射到 `src/App.tsx` line 20、零基 column 58，即界面显示 `20:59` |
| 对应代码 | `lynx.setSharedData` 的第二参数回调，函数体为 `console.log("1234")` |

`object_index` 不是 nodeIndex，必须按 meta 中节点记录宽度换算。`primjs_sources.fields` 定义平铺
`scripts` 字段顺序，`name` 是 snapshot strings 索引。script ID 仅在其快照内有意义。
Trace 面板与报告快照详情的 Summary／Comparison 下拉框提供 Scripts 视图，按
`primjs_sources` 的记录顺序显示 Script ID 和完整脚本名，支持按名称或 ID 筛选。
同名但不同 ID 的脚本分别保留；未被对象 location 引用的脚本也显示。缺失、不支持或为空的
脚本表显示空状态，非法行跳过，不影响对象浏览，也不从 location 或源码映射推测脚本列表。
同一下拉框的 Raw 视图以格式化 JSON 树展示原始 snapshot，保留未知字段，支持 `+ / −`
逐节点展开与收起。默认展开顶层，大数组或对象每次加载 100 项，长字符串可展开查看完整内容。
JSON 在 Worker 中按需解析，仅传输当前展开的节点；离开 Raw 后释放解析数据。
PrimJS 引擎写入 `ptr - source_start`，偏移是生成脚本 UTF-8 字节数；普通多行、中文、emoji 场景
必须读取实际生成脚本才能转换为 sourcemap 所需的行和 UTF-16 列。`sourcesContent` 是原始源码，
不能替代生成脚本。只有已知生成坐标或已证明单行 ASCII 前缀等条件下，才可省略该转换所需的脚本文本。

本例 map 的 `file` 为旧的 `background.53098423.js`，与磁盘哈希名不同；周边 11 个 token 的
映射及反向映射核对成功，且 App.tsx 第 20–22 行与 `sourcesContent` 完全一致。因此不能仅凭
`map.file` 判死，也不能忽略差异：准备清单展示警告，依据产物来源和映射点验证后确认。

### 12.3 报告交互、来源及缓存

报告对象超链接首先打开对应 snapshot，校验 node ID/index，自动在原类型和分页中选中并展开节点，
显示 Retainers。任何节点有有效 location 时均自动显示源码结果，保留生成脚本／偏移及映射后的源码片段，
高亮目标行。snapshot 节点及 Retainer 树中的蓝色链接在原始源码映射成功时显示 `文件:行:列`；
否则显示脚本路径的最后一段文件名（去掉 query／fragment 并解码 URL 转义），仅文件名未知时显示 `Source`。
例如 RC 第一份快照的 `@15397` 显示 `App.tsx:20:59`，`@27923` 显示 `krypton.js`；
脚本名可读不代表其本地产物或原始源码已找到。有位置信息但无法
映射时仍显示原始位置和具体失败原因，不能伪造源码跳转。
源码面板按从原始源码到 VM 实际加载脚本的顺序，逐层显示「源码链接 → 对应源码片段」：
不显示 `Source ·` 前缀；没有原始源码时，直接从 runtime URL 与 byte offset 开始，不重复显示脚本路径。
当前定位器只查询一次 sourcemap，数据保存两层。若构建工具已合并多次编译的映射，可以直接定位最终源码；
若各编译阶段只有独立的 map，当前不会递归追溯，也不保留或展示中间层。
定位成功时在左侧留白绘制圆角连线：从生成代码路径行的垂直中点向左、向上，再向右以箭头指向源码路径行的中点。
连线随路径换行和面板缩放自动对齐；无法定位原始源码时不绘制指向未知目标的箭头。
连线仅作辅助：横向跨度 8px、线宽 1px，使用小箭头、小圆角及 60% 不透明度的弱化文字色，避免抢占源码内容的视觉重点。
首行保持原始完整路径及行列（例如 `App.tsx:8:8`），其后紧接 App.tsx 片段，
再显示 runtime URL 与 byte offset，其后紧接生成 JS 片段。节点上的 `文件:行:列` 标签保持不变。
若只能定位生成 JS，先显示 runtime URL/偏移与 JS 片段，再显示无法继续定位原始源码的具体原因。
「Generated JavaScript · 生成行:列」坐标信息放在片段及失败提示之后，不插入链接与片段之间。
源码路径及两层代码片段自动换行、完整展开，不设置内部高度限制或滚动条。
Summary 与 Comparison 中，源码详情与 Retainer 树共用一个隐藏滚动条的滚动区域，
保留滚轮、触控及键盘浏览能力，避免源码展开后挤压或遮挡引用树。
只要已匹配生成 JS 且字节偏移有效，无论原始映射成功或失败，均保留生成片段：
偏移前最多 80 个、从偏移开始最多 160 个 Unicode 码点，从目标偏移开始高亮，
截断端显示省略号。不能将生成脚本片段标作原始 TSX。
例如第一份 `bts_residual/1/slot_4` 快照（slice 7188）的 `@12931`，
`source_offset=58` 指向 `background.a3deaafc.js` 的 `function t(t){...`，可直接查看此处上下文。
缺失／歧义产物或非法偏移时不猜测片段。定位器缓存版本升级后，旧失败结果须重新计算。
不得按节点类型或显示名称过滤有效 location。`code`／函数字节码节点也需要解析：
第二份快照（slice 12745）的 `anonymous @14365`（nodeIndex 450）与 `Function @16581`
共享 `(script_id=4, source_offset=39549)`，都映射到 `App.tsx:20:59`，可复用同一缓存结果。

本地工程输出绝对文件路径和一基行列，并提供 file URL；浏览器限制本地跳转时仍能离线查看片段。
若已唯一匹配本地生成 JS 且位置有效，Source 中展示的 runtime URL（例如
`file://view4/.rspeedy/main/background.a3deaafc.js`）也应为蓝色链接，目标为实际本地生成文件
的 `file:///...#L<生成行>:<生成列>`（一基），即使原始 sourcemap 无匹配也可跳转。
原始 TSX 链接与生成 JS 链接分别使用各自坐标，不把虚拟 `view4` 当成本地目录。
Git 工程的链接指向实际构建 commit，保留用户请求 branch；源站不支持列锚点时仍在界面展示精确列。
GitHub／GitLab 直接生成链接，其它平台使用已验证的 URL 模板。不得将 node_modules、未跟踪文件或
本地已修改源码伪装为仓库 commit 中的文件。构建机绝对路径按工程内唯一后缀和 sourcesContent 校验
映射回本地路径。多个工程匹配同名脚本时必须报告歧义，使用已知 runtime URL prefix 区分，不猜测页面。

报告生成时解析一次并把轻量定位结果写入 `analysis.json` 和 viewer，按快照 SHA-256 绑定；
同时保存用于第 9.5 节表格的工程来源、跳过记录、JS/map 路径与哈希、原始文件数量，以及每个快照的
完整脚本候选与选中结果（包括没有 location 的脚本）。不嵌入完整 sourcemap 或额外复制原始源码。
离线重渲染复用已保存资料，无需访问来源工程；快照哈希不符时不得复用该快照的定位结果。
旧报告仅展示实际保存的字段并注明清单不完整，不推测缺失的工程、产物或绑定。
系统临时目录中的 `lynx-source-location-cache-<digest>.json` 同时缓存成功与失败，不随报告交付。
manifest digest 覆盖工程、版本、选择器、
JS/map 及原始文件内容哈希，变化后旧缓存失效，需重新准备。没有前端工程或旧 snapshot 没有 locations 时，
原有快照查看功能保持可用。新分析与离线 `memory-report` 均可直接使用已准备产物并执行技术校验。

### 12.4 连续执行验收

| 场景 | 预期行为 |
| --- | --- |
| 用户提供前端工程，构建成功，产物 hash 改变 | 使用实际新产物继续，零产物确认；后续检查绑定，不重命名强配 |
| 前端 JS/map 与快照实际不匹配 | 先展示匹配证据及 config 变量/条件分支原因（文件行号、取值、影响、确定性），再询问终止/放弃对应产物辅助/提供明确产物地址 |
| 前端配置或录制时变量值不可确定 | 明确哪些值未知、哪些原因只是推测，不以当前环境代替录制环境，不自动修改配置重建 |
| 替代产物仍不匹配或下载/校验失败 | 更新证据并继续同一三选一循环，直到匹配或明确终止/放弃；不按重试次数结束 |
| 工程为本地路径，产物为下载链接；或工程/产物分别在不同 Git 仓库 | 分别获取与留证，默认零前端构建；JS 一级匹配后用 map 映射回指定工程，源码链接使用工程 commit |
| JS/map 分开放置，map 引用 `../src/...` | 使用显式路径、安全唯一后缀及 `sourcesContent` 校验映射；不要求产物与工程同目录 |
| 已提供前端工程，分析用到的业务位置只能定位到生成 JS | 绑定阶段询问补充匹配的 map／发布产物，或接受当前精度继续；未答复不定稿，不以确认泄漏为前提。补充后重新校验，接受则保留生成位置并记录范围，不重复询问 |
| 只有未用到的脚本缺 map，或只提供 JS 而未提供前端工程 | 不因此询问或强制重建；保留可用的生成位置，不声称已映射到原始源码 |
| map 内容不符、路径有歧义或越出工程 | 不猜测原始源码位置，保留有效生成代码证据并报告原因；真实内容冲突进入前端三选一 |
| 替代产物匹配成功 | 清除旧定位证据，以新清单自动继续，无使用确认 |
| Lynx JS/map 与快照实际不匹配 | Skill 展示匹配证据，再询问放弃 Lynx 源码辅助继续或终止；不请用户判断 map 正确性 |
| Trace 有唯一可用版本，远端 tag 存在 | 记录 tag/完整 commit 后全新获取、构建并分析，不问是否构建或使用 |
| Trace tag 不存在或无法唯一解析 | 展示版本与远端结果，请用户补充缺失的源码定位；不静默换 revision |
| 全新 Lynx 初始化或依赖同步首轮失败，环境修正后成功 | 保存错误与诊断，自动重试一次，成功后连续分析 |
| 全新 Lynx 公共脚本准备重试后仍失败 | 展示两次日志，再询问放弃 Lynx 源码辅助继续或终止 |
| 全新 Lynx 构建成功但存在临时/已跟踪文件变更 | 不阻断、不清理、不询问；仍校验 JS/map，并只为与 commit 内容一致的源码生成远端链接 |
