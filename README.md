# ShipWitness

**让 AI 开发的软件，用可核验的证据决定能否发布。**

ShipWitness 是面向独立开发者和非技术产品负责人的开源发布验收台。它把原始需求转成版本化验收标准，保存执行证据、返工单和负责人决定，并在证据不足时明确拒绝“猜测通过”。

> 当前版本：`0.4.0-dev.5`。已具备真实浏览器验收、证据返工闭环、安全工作区、PostgreSQL 灾备、哈希链审计、CI/CD 发布门禁，以及可校验的版本化交付包。正式公网部署仍需 HTTPS 和完整安全审查。

## 已实现

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

现有 JSON 数据迁移、备份、恢复和 HTTPS 部署要求见 [私有部署指南](docs/DEPLOYMENT.md)，CI 门禁、签名卷宗和 Webhook 见 [发布自动化](docs/RELEASE_AUTOMATION.md)，Agent/GitHub 配置见 [交接与集成](docs/INTEGRATIONS.md)。

## 开发检查

```bash
npm run check
```

检查包括服务端、前端 JavaScript 语法和 API 集成测试。

## 产品边界

没有配置浏览器步骤的标准只执行基础环境检查；没有明确结果断言的路径仍会标记为“证据不足”。浏览器执行器限制同源跳转、单标准最多 20 步，并且不会执行任意脚本。

路线图见 [docs/ROADMAP.md](docs/ROADMAP.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)，部署指南见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全报告方式见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
