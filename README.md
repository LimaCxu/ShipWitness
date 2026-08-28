# ShipWitness

**让 AI 开发的软件，用可核验的证据决定能否发布。**

ShipWitness 是面向独立开发者和非技术产品负责人的开源发布验收台。它把原始需求转成版本化验收标准，保存执行证据、返工单和负责人决定，并在证据不足时明确拒绝“猜测通过”。

> 当前版本：`0.4.0-dev.47`。验收凭据保险箱支持加密保存、30–365 天有效期、临期提示、原地轮换、引用统计和误删保护；过期凭据会在项目预检、任务创建和真实执行阶段被拒绝。浏览器步骤只引用凭据名称，任务、日志、截图说明和签名证据包不会保存明文。平台同时具备真实浏览器验收、隔离恢复演练、部署配置中心、用户治理、MFA、GitHub 与 CI 同步、上线就绪中心、安全评审、审计、发布门禁、密钥轮换和精确回退。开发版本仅适合本地或受控试点；正式公网部署仍需稳定版、HTTPS 和一年内独立安全审查。

## 已实现

- Coding Agent 扩展 API：`/api/v1` 稳定版本路径、读写权限分离、幂等任务提交、执行、证据与门禁读取
- 生命周期治理：公开支持政策、稳定版发布日期与停止支持日期校验、开发版和过期版本自动降级
- 安全评审闭环：登记第三方报告、结构化发现项、整改状态、复测证据、限时风险接受和发布阻断
- 安全证据交付：Ed25519 签名整改证据包、状态变化失效提醒、下载和离线验签
- GitHub 自动同步：验签接收 push、check suite、check run 和 workflow run 事件，持久化防重放、分支精确匹配、失败可审计重试
- GitHub 代码证据：管理员或审批人显式同步分支提交、签名和 CI 状态，新验收任务保存不可变提交快照，绑定提交 CI 未成功时发布门禁保持阻断
- 上线就绪中心：以阻断、警告和通过分级检查数据库、HTTPS、主密钥、审计链、备份、独立安全评审、通知与运行健康，并导出不含机密的 JSON 报告
- 项目生命周期：管理员可填写原因后归档、查看和恢复项目，历史证据保留，活动任务受保护
- 验收标准资产化：跨项目复制、JSON 导入导出、冲突预览、跳过或生成新版本，以及批量启停
- 项目总览：按真实验收、审批和返工数据汇总全部项目状态，并可直达项目或最新任务
- 工作区内多项目切换：每位成员独立记忆当前项目，标准、历史和任务深链接自动同步到所属项目
- 团队待办收件箱：聚合等待执行、失败处理、超时接管、发布审批、修复复验和失败投递，并保存个人已读状态
- 可选 SMTP 邮件通知：邀请、验收失败和待审批邮件使用加密持久队列、指数退避重试和可审计最终状态
- 首次使用向导：按官网、后台或登录入口启动包一次创建项目、可执行标准和首个验收任务
- 项目目录、分支、测试网址和返工方式持久化
- 项目目录、Git 提交和测试网址连通检查
- 验收标准库：新增、编辑、启用/停用和版本记录
- 创建任务时快照启用标准，历史结果不受后续修改影响
- 验收任务、返工单、负责人决定和 JSON 验收卷宗
- 从失败证据生成返工单、记录状态时间线并创建单路径复验任务
- 首次管理员初始化、密码登录、安全会话、登录限流和退出失效
- 多工作区隔离、工作区切换、成员管理以及管理员/审批人/成员角色
- PostgreSQL 16、自动版本迁移、JSON 数据导入、数据库健康检查
- 数据库与截图证据联合备份、SHA-256 校验和显式确认恢复
- 工作区级哈希链审计、篡改检测和审批人发布决定
- 结构化编码 Agent 交接包与显式触发的 GitHub Issue 导出
- 权限受限且仅显示一次的机器 API Key、稳定退出码发布门禁 CLI
- Ed25519 签名验收卷宗、离线验签 CLI 和加密私钥存储
- HMAC 签名发布 Webhook、持久化投递队列和指数退避重试
- 带逐文件 SHA-256 清单的版本化发布包、Tag/版本一致性门禁
- 升级前备份新鲜度、主密钥和数据库迁移兼容性检查
- PostgreSQL 事务性主密钥轮换及逐工作区审计记录
- 精确镜像/备份版本绑定的 Compose 停机、恢复、启动和健康确认回退
- 验收目标来源白名单、逐跳重定向检查与浏览器跨来源请求阻断
- 并发任务原子抢占、崩溃 Webhook 自动重领和 CI 依赖漏洞门禁
- 成员角色调整与安全移除、最后管理员保护、改密和其他会话吊销
- 登录设备管理：查看本人有效会话、识别当前设备、单独退出陌生设备并记录安全审计
- 两步验证：TOTP 动态码、一次性恢复码、五分钟登录挑战、邀请二次校验和主密钥轮换兼容
- 验收凭据保险箱：工作区加密保存、标准引用计数、无停机轮换、误删保护和全链路明文隔离
- 账户恢复：无账号枚举的邮件请求、30 分钟一次性链接、旧会话吊销及 MFA 保留
- 面向管理员/审批人的任务队列、失败投递、存储和审计完整性状态
- 管理员重置成员密码、强制临时密码改密与全局会话吊销
- 可确认、可审计、异常恢复后自动解决的工作区告警中心
- 带完整性证明的审计快照导出、到期数据预览与受控运营数据清理
- 历史证据不可覆写的关联重试、执行失败记录和超时任务安全接管
- 令牌哈希存储、可过期可撤销的一次性成员邀请与自主设密
- 基础执行证据：仓库状态、HTTP 响应、页面标题、耗时和内容指纹
- 真实浏览器步骤：同源打开、点击、输入、可见性、文字和网址断言
- 浏览器证据：逐步结果、最终网址、网络响应摘要和完整页面截图
- 保守裁决：尚未执行真实业务路径时保持“证据不足”
- Docker、健康检查、安全响应头、优雅停机和 GitHub Actions CI

## 本地启动

需要 Node.js 20 或更高版本。

```bash
cp .env.example .env
npm install
npx playwright install chromium
npm start
```

打开 <http://127.0.0.1:4173/>。首次启动会要求创建管理员和工作区；已有的 0.3 数据会在初始化时归入该工作区。默认数据保存在 `data/store.json`，该文件不会提交到 Git。

## Docker 启动

```bash
cp .env.example .env
# 编辑 .env，替换 POSTGRES_PASSWORD 和 SHIPWITNESS_MASTER_KEY
docker compose up --build
```

数据库保存在 `shipwitness-postgres` 卷，截图证据保存在 `shipwitness-data` 卷。健康检查地址：`GET /api/health`，返回实际数据库引擎和连接状态。

现有 JSON 数据迁移、备份、恢复和 HTTPS 部署要求见 [私有部署指南](docs/DEPLOYMENT.md)，部署分级与检查口径见 [上线就绪中心](docs/READINESS.md)，Coding Agent 调用见 [扩展 API](docs/EXTENSION_API.md)，多项目使用方式见 [项目组合](docs/PROJECTS.md)，归档规则见 [项目生命周期](docs/PROJECT_LIFECYCLE.md)，标准复用见 [验收标准包](docs/CONTRACT_PACKS.md)，CI 门禁、签名卷宗和 Webhook 见 [发布自动化](docs/RELEASE_AUTOMATION.md)，Agent/GitHub 配置见 [交接与集成](docs/INTEGRATIONS.md)。

## 开发检查

```bash
npm run check
```

检查包括服务端、前端 JavaScript 语法和 API 集成测试。

## 产品边界

没有配置浏览器步骤的标准只执行基础环境检查；没有明确结果断言的路径仍会标记为“证据不足”。浏览器执行器限制同源跳转、单标准最多 20 步，并且不会执行任意脚本。

路线图见 [docs/ROADMAP.md](docs/ROADMAP.md)，试点反馈见 [docs/PILOT_FEEDBACK.md](docs/PILOT_FEEDBACK.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)，邮件通知见 [docs/EMAIL_NOTIFICATIONS.md](docs/EMAIL_NOTIFICATIONS.md)，团队待办见 [docs/TEAM_INBOX.md](docs/TEAM_INBOX.md)，首次验收启动包见 [docs/STARTER_KITS.md](docs/STARTER_KITS.md)，任务恢复见 [docs/RUN_RECOVERY.md](docs/RUN_RECOVERY.md)，成员邀请见 [docs/INVITATIONS.md](docs/INVITATIONS.md)，工作区管理见 [docs/ADMINISTRATION.md](docs/ADMINISTRATION.md)，数据治理见 [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md)，部署指南见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)，兼容性承诺见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)，内部安全审查见 [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)，安全整改闭环见 [docs/SECURITY_REMEDIATION.md](docs/SECURITY_REMEDIATION.md)，安全报告方式见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
