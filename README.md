# ShipWitness

**让 AI 开发的软件，用可核验的证据决定能否发布。**

ShipWitness 是面向独立开发者和非技术产品负责人的开源发布验收台。它把原始需求转成版本化验收标准，保存执行证据、返工单和负责人决定，并在证据不足时明确拒绝“猜测通过”。

> 当前版本：`0.2.0`。适合本地开发和产品体验；身份认证、团队隔离和完整浏览器执行器尚未完成，请勿直接暴露到公网。

## 已实现

- 项目目录、分支、测试网址和返工方式持久化
- 项目目录、Git 提交和测试网址连通检查
- 验收标准库：新增、编辑、启用/停用和版本记录
- 创建任务时快照启用标准，历史结果不受后续修改影响
- 验收任务、返工单、负责人决定和 JSON 验收卷宗
- 基础执行证据：仓库状态、HTTP 响应、页面标题、耗时和内容指纹
- 保守裁决：尚未执行真实业务路径时保持“证据不足”
- Docker、健康检查、安全响应头、优雅停机和 GitHub Actions CI

## 本地启动

需要 Node.js 20 或更高版本。

```bash
cp .env.example .env
npm start
```

打开 <http://127.0.0.1:4173/>。默认数据保存在 `data/store.json`，该文件不会提交到 Git。

## Docker 启动

```bash
docker compose up --build
```

数据保存在命名卷 `shipwitness-data`。健康检查地址：`GET /api/health`。

## 开发检查

```bash
npm run check
```

检查包括服务端、前端 JavaScript 语法和 API 集成测试。

## 产品边界

当前基础执行器只证明项目目录和页面可以访问，不会把“页面能打开”误判为业务功能通过。真实页面点击、网络证据、截图和业务裁决将在 `0.3` 浏览器执行器中实现。

路线图见 [docs/ROADMAP.md](docs/ROADMAP.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全报告方式见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
