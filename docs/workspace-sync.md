# 两台电脑独立运行与加密工作配置 / Encrypted workspaces

## 两种文件的用途

- **`.subboost`**：用于在两台 SubBoost 之间传递完整的可编辑工作配置，文件经过密码加密。
- **`.yaml`**：从 SubBoost 下载的普通 Clash/Mihomo 配置，直接导入 Clash Verge，不需要解密插件。

## 第一次设置

1. 两台电脑都安装这个包含加密工作配置功能的版本，并各自准备独立数据库。只在本机使用时，保持服务监听 `127.0.0.1`。
2. 在电脑 A 的首页导入订阅、整理节点和分流规则。
3. 打开首页的 **加密同步 → 创建加密文件**，设置独立的长密码（至少 12 个字符），导出 `subboost-workspace.subboost`。
4. 将该文件放入你自己的同步文件夹，或手动传到电脑 B。SubBoost 不包含云同步服务，也不会上传文件。
5. 在电脑 B 的首页点击 **加密同步 → 打开加密文件**，选择文件并输入同一加密密码。
6. 继续编辑，然后下载普通 YAML，导入本机 Clash Verge。关闭 SubBoost 不影响已导入的 YAML 使用。

加密密码与两台电脑各自的 SubBoost 登录密码无关。本机账号、数据库中的订阅记录及生成的订阅链接不会跨电脑复制。若需要保存为本机订阅链接，可在导入工作配置后另行登录保存。

## 本机双击启动（Windows）

这台电脑完成安装后，在项目目录双击 **`启动SubBoost.cmd`** 即可。它会启动已有的本机 PostgreSQL 和已构建的 SubBoost，等待网页及数据库就绪，再打开系统默认浏览器。首次使用会进入本机账号初始化页；账号已创建后进入首页。无需打开 Codex，也不会重新安装依赖、下载程序、创建数据库或修改杀毒设置。

保留启动窗口即可使用。退出时先在窗口按 **Ctrl+C**，等服务退出后再关闭窗口。如果数据库是本次启动入口启动的，也会正常关闭；原先已经运行的数据库不会被它关闭。直接关闭窗口或关机可能跳过正常关闭步骤。已经导入 Clash Verge 的 YAML 不受 SubBoost 停止影响。

重复双击会打开已运行的服务；启动尚未完成时会等待，不会启动第二份。若 3001 端口被其他程序占用，会显示错误并保留窗口。若自动打开浏览器失败，可手动访问 `http://127.0.0.1:3001/`。

启动入口使用原项目的生产构建，后续修改应用源码后需执行一次 `npm.cmd run build` 更新构建，再启动。另一台电脑仍需先完成本机环境、数据库和构建的准备；不要把这一台的 `.env` 或数据库复制过去。

### 家用电脑首次安装与迁移包

私下传递的 Windows 迁移包可包含已有的 Node.js、PostgreSQL 程序和 standalone 构建，分别位于 `data/runtime/node/`、`data/runtime/pgsql/` 和 `local/.next/`。这些运行文件不进入 Git；单独克隆源码仍需要自行准备运行环境和构建。

完整解压迁移包后，第一次双击 **`首次安装SubBoost.cmd`**。它仅为新目录初始化独立数据库、执行项目数据库迁移并生成新的本机密钥，然后打开网页。检测到已有安装时不覆盖；安装失败时保留现场供检查，不会删除或重建已有数据。程序和数据库仅监听本机地址，不修改系统代理或杀毒设置。之后使用 **`启动SubBoost.cmd`**，无需每次打开 Codex。

在网页创建家用电脑自己的本机账号后，打开 **加密同步 → 打开加密文件**，导入私下传递的 `workspace.subboost`。迁移文件只包含当前工作配置；不会复制办公室电脑的账号、登录态或数据库密钥。生成家用电脑的本机订阅链接后，再导入本机 Clash Verge；办公室的 `127.0.0.1` 链接及其订阅 token 不会自动成为家用电脑上的订阅。

可选的 `clash-home-config.encrypted.json` 保存普通 Clash YAML 和手动分组选择，使用单独传递的密码文件在本机解密：

```text
node scripts/decrypt-home-transfer.cjs --input private-workspaces/home-transfer/clash-home-config.encrypted.json --password-file private-workspaces/home-transfer-password.txt --output private-workspaces/home-import
```

迁移包自带 Node 时，可将命令开头的 `node` 换成 `data/runtime/node/node.exe`。解密程序只生成 `clash-home.yaml` 和分组选择记录，不会导入、激活或切换 Clash。导入前核对 AI 分组的节点；YAML 已将导出时所选节点排在相应手动组的首位，但 Clash 自己缓存的分组选择仍可能覆盖首次默认值。

解锁密码另行保管，不放进迁移包、Git 或同步文件夹。`workspace.subboost` 与普通导出文件格式相同，后续仍可按下文连接同步文件。同步工作配置后，需要在各电脑重新保存本机订阅或重新导出 YAML，Clash 才会使用更新后的内容；Clash 客户端自身的 TUN、系统代理、DNS 覆写和手动分组选择不会通过工作配置自动同步。

## 直接连接同步文件（Chrome / Edge）

在支持 File System Access 的桌面浏览器中：

- 电脑 A 打开工作配置后，选择 **选择同步保存位置**，在同步文件夹中创建一个新的 `.subboost` 文件。已有非空文件不会被静默覆盖。
- 电脑 B 使用 **连接已有同步文件**，选择同一个同步文件夹中的文件，输入加密密码。
- 修改后点击 **加密保存到同步文件**；换电脑前等待同步软件完成上传。
- 在另一台电脑上先等待文件下载完成，再点击 **读取文件更新**，然后继续编辑。
- 重新打开页面时可以 **解锁上次配置**；浏览器可能要求重新授权文件访问。解锁的是本机上次加密保存的副本，编辑前仍应读取同步文件更新。

页面打开期间会检查所连接文件是否变化。发现变化后提示读取更新，不会自动替换编辑器或自动写入文件。不支持文件授权的浏览器（包括部分内嵌浏览器）可使用加密导出、导入。

## 换电脑和冲突

每次只在一台电脑上编辑同一份配置。两台电脑不需要同时开机；使用云同步文件夹时，确认上传完成后再关闭当前电脑。设备直接同步则需要两台电脑至少有一段共同在线时间。

应用会保留加密的版本关系：

- 文件比当前版本旧、属于另一个工作配置，或两边从同一旧版本分别修改时，会要求确认。
- 本机有未加密保存的修改时，读取更新会提示先导出备份。
- 保存到同步文件前会再次读取原文件。若与上次读取的内容不一致，拒绝覆盖，并保留本机编辑内容。
- 同步软件产生的“冲突副本”需要分别打开检查。该功能不自动合并节点或规则。

本地版本检查无法充当跨电脑分布式锁：两台离线电脑同时改动、或同步尚未完成时，仍可能产生冲突副本。请遵循“先读取、再编辑、加密保存、等同步完成”的顺序。

## 安全边界与备份

文件在浏览器中使用 AES-256-GCM 加密，使用随机 salt、随机 IV 和 PBKDF2-HMAC-SHA-256（600,000 次）从密码派生密钥。工作配置名称、更新时间、版本关系、来源和节点均放在密文中。密码不发送给 SubBoost 后端，不写入浏览器存储，也不包含在导出文件中。

浏览器可保留加密副本和本机文件授权；解锁后的配置与密码只在当前页面的内存中供编辑使用。加密工作配置会停用原有的明文草稿和登录跳转草稿缓存。**锁定**或离开首页会清空工作配置编辑器，并保留上次的加密副本。如果需要登录保存为本机订阅，请先登录，再解锁工作配置。忘记加密密码无法恢复文件。关闭、刷新或离开页面前，请先加密保存；工作配置不会自动备份未保存的修改。

现有 SubBoost 登录和本地订阅数据库仍按原有机制工作。同步功能不会迁移数据库、账号、`.env`、会话 cookie、数据库加密密钥、本机订阅 ID/token 或编辑历史。

只同步 `.subboost` 文件。不要同步 PostgreSQL 数据目录、`.env` 或整个应用的浏览器数据目录。已经导出的普通 YAML 含节点凭据，应妥善保管。加密同步不能防止已获授权的电脑上的恶意程序读取解锁后的内容，也不能使已经泄露的节点凭据失效。

不要把个人配置提交到 Git。本仓库忽略 `*.subboost` 和 `private-workspaces/`；如果临时把普通 YAML 或原始订阅列表放在项目中，请放进 `private-workspaces/`（或已有的 `data/`）目录。忽略规则无法移除已经提交过的文件或历史。

## English

Each PC runs its own SubBoost instance and database. The home-page **加密同步** dialog exports/imports a password-protected `.subboost` workspace containing sources, node snapshots, deletion/restoration metadata, filters, proxy groups, routing, DNS and listeners. Local accounts and subscription IDs/tokens are not transferred.

Put only the encrypted file in your own synchronized folder, or transfer it manually. SubBoost does not provide cloud transport. Chrome/Edge can connect directly to a local synchronized file; other browsers support download/upload. Read the latest file before editing, save explicitly, and wait for your synchronization client to finish before switching PCs. No machine must remain continuously online. Direct device-to-device transport requires an overlapping online period; cloud-backed folders do not.

Encryption/decryption runs in the browser using AES-256-GCM and PBKDF2-HMAC-SHA-256 with 600,000 iterations, a random 16-byte salt and a random 12-byte IV. Passwords are never sent to the server or persisted. The optional local browser cache stores ciphertext and a device-local file handle only. Encrypted workspaces disable the ordinary plaintext draft and login-handoff caches. Locking or leaving the home page clears the workspace editor and in-memory password. Log in before unlocking if you need to save a local subscription. Forgotten passwords cannot be recovered; unsaved edits are not automatically backed up.

Older/unrelated/divergent revisions and unsaved local edits require confirmation before replacement. File writes refuse to overwrite a file that differs from the last observed ciphertext. This is advisory conflict protection, not a distributed lock or an automatic merge engine. Keep and inspect synchronization conflict copies.

Decrypt the workspace in SubBoost, then download ordinary YAML for Clash Verge. Clash needs no encryption support. Protect the plaintext YAML and the unlocked endpoint devices. Never synchronize `.env` or a live PostgreSQL data directory.
