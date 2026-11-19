# 额度预检与工具字段传递

## 目标

复用额度处理和错误提示。按既有动作策略检查余额，重试时复核失效拒绝。补齐音乐风格与纯音乐参数。

## 假设

用户在额度恢复后立即重试可以继续原操作；音乐工具将显式设置的参数传递给选定协议。

## 证伪方式

分别模拟拒绝后恢复、两个同时重试及仅提示的分析入口；捕获音乐请求，检查约定字段及显式关闭开关的取值。

## 验收

余额由零恢复后可立即重试；并发只查一次。确认登录、权限、业务拒绝及仅提示入口维持原语义；核对工具字段到执行器。

## 运行时规则责任清单

下表按桌面壳和 13 个产品插件列出本次沿调用路径核对的代表性规则。每行的责任方掌握判定所需的事实。“保留”指该边界有独立目的，“收拢”列出目标状态。范围是用户操作时的检查，不含 CI、发布流程及第三方依赖内部。

| 组件与规则入口 | 调用场景 | 判定责任与处置 |
|---|---|---|
| [桌面权限](../app/dsh-desktop-next/src/electron-permissions.ts) | 桌面页面申请屏幕、麦克风等原生能力 | 桌面主进程核对请求来源，操作系统决定是否授予权限。保留两处检查。 |
| [执行中枢 omnimux](../plugins/plugins/omnimux/src/media/execute.js) | 画布、Agent、媒体 HTTP 请求 | 网关按操作声明模型输入，中枢据此准入并映射实际请求。收拢各入口的字段必填规则。工具显式传递音乐风格及纯音乐开关；账本继续防重复提交。 |
| [工作流 omnimux-workflow](../plugins/plugins/omnimux-workflow/src/shared/validation/executionReadiness.ts) | 画布按钮、HTTP/Agent 启动和排队执行 | 工作流判定节点与上游素材就绪。收拢同一请求的重复解析。队列取到实际素材后复核，已受理任务按原任务标识恢复。 |
| [账号 omnimux-accounts](../plugins/plugins/omnimux-accounts/src/client/api.js) | 账号页面查询和修改 | 凡既有动作需要预检，复用中枢额度接口及错误识别；动作授权及账号元数据仍归账号服务。 |
| [发布 omnimux-publish](../plugins/plugins/omnimux-publish/src/submit.js) | 发布页面准备、后台队列派发 | 共用额度预检。派发器在执行时复核账号状态，因为排队期间授权可变。保留内容与平台适配检查。 |
| [灵感 omnimux-inspiration](../plugins/plugins/omnimux-inspiration/src/http-routes.js) | 页面检索、采集和本地写入 | 复用中枢额度错误处理；Host 保留对写入来源的检查，本地素材和采集请求继续使用各自访问规则。 |
| [商品 omnimux-products](../plugins/plugins/omnimux-products/src/library.js) | 手工创建草稿、Agent 新增商品 | 两个入口共用商品库，Agent 创建额外要求内容。保留现有行为；调整时需先明确草稿与可用商品的业务区别。 |
| [素材 omnimux-assets](../plugins/plugins/omnimux-assets/src/ingest.js) | 本地素材导入和写盘 | 导入服务在写入前检查可用空间；此时才掌握素材大小、目标磁盘和剩余容量。保留。 |
| [剪辑 omnimux-clip](../plugins/plugins/omnimux-clip/src/paths.js) | 打开项目、读写或导出项目文件 | 项目路径模块核对标识并将文件限制在对应根目录。保留，文件访问入口复用同一模块。 |
| [表单 omnimux-forms](../plugins/plugins/omnimux-forms/src/store.js) | 工作区草稿读取和保存 | HTTP 入口核对来源，草稿存储校验字段及预期修订号，防止并发覆盖。保留。 |
| [浏览器 omnimux-browser](../plugins/plugins/omnimux-browser/src/pairing.ts) | 浏览器扩展配对 | 配对服务核对请求与用户授予的连接许可。保留，模型的调用资格不能代替用户授权。 |
| [市场 omnimux-market](../plugins/plugins/omnimux-market/src/install-validation.ts) | 从市场安装包 | 市场安装器接触实际文件后校验内容和目录结构。保留，列表中的可选状态只用于选择。 |
| [视频 omnimux-video](../plugins/plugins/omnimux-video/src/understand/pack-video.js) | 视频分析和逆向拆解 | 两种操作共用本地视频检查，核对文件可读性与大小。保留在首次读取文件处。 |
| [分析 omnimux-analytics](../plugins/plugins/omnimux-analytics/src/stage-events.js) | 页面上报打开、关闭等事件 | Host 入口校验事件与字段白名单，限制可进入分析队列的数据。保留。 |
