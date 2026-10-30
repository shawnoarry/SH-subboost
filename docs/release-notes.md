# SubBoost v2.10.0

## 中文

### 新增与修复

- 扩展 VLESS XHTTP 与 Hysteria2 导入，保留独立下行、Reality 混合密钥交换、Gecko/ECH 等设置；修复 TUIC/Hysteria、WireGuard、Snell、SSH 的部分参数丢失或映射错误。高级选项需要客户端内核支持。
- 修复导入规则后的目标代理组匹配，以及代理组重命名、禁用、删除后的处理，使编辑器与可视化预览保持一致。
- 改善 IPv6 fake-ip DNS 环境下的公共订阅导入，同时保留默认的内网和保留地址保护。
- 更新运行时与依赖的安全基线，并保持 YAML 凭据、合并配置和多行数组、对象的解析兼容性。

### 升级说明

- Docker 镜像自带新版 Node.js，无需升级宿主机 Node。一键安装用户可在正式发布后运行 `subboost update`；升级器会先创建并验证数据库备份，再短暂重启服务。
- 直接用 Node.js 构建或运行源码时，请先使用 Node 24.x（至少 24.22.1，推荐）或 Node 26.x（至少 26.12.1）；Node 22 和 25 不再支持。
- 从 v2.9.0 升级没有新增数据库迁移或环境变量变更。请保留现有数据、配置和密钥，并在升级前备份；Docker Compose 源码部署继续按部署文档更新并重建镜像。

## English

### Features and Fixes

- Expanded VLESS XHTTP and Hysteria2 imports to preserve independent download settings, Reality hybrid key exchange, and Gecko/ECH options. Fixed lost or incorrectly mapped parameters in TUIC/Hysteria, WireGuard, Snell, and SSH. Advanced options require support from the client kernel.
- Fixed target proxy group matching after rule imports and handling after groups are renamed, disabled, or deleted, keeping the editor and visual preview consistent.
- Improved public subscription imports in IPv6 fake-IP DNS environments while preserving the default protections for private and reserved addresses.
- Updated runtime and dependency security baselines while preserving parsing compatibility for YAML credentials, merged configurations, and multiline arrays and objects.

### Upgrade Notes

- Docker images include the updated Node.js runtime, so the host's Node.js does not need upgrading. One-click installation users can run `subboost update` after the stable release is published. The updater first creates and verifies a database backup, then briefly restarts the service.
- When building or running source directly with Node.js, first use Node 24.x (at least 24.22.1, recommended) or Node 26.x (at least 26.12.1). Node 22 and 25 are no longer supported.
- Upgrading from v2.9.0 introduces no new database migrations or environment variable changes. Keep existing data, configuration, and keys, and back up before upgrading. Docker Compose source deployments should continue updating and rebuilding images according to the deployment documentation.
