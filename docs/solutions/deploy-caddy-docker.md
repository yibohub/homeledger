# 云服务器部署运维（docs/solutions/deploy-caddy-docker.md）

> 姊妹篇：[deploy-nas.md](deploy-nas.md)（NAS + GHCR 镜像路径）。本篇 = 自有云服务器（CVM）+
> 域名 HTTPS 的部署/升级 runbook。**机器资产细节（地址/域名/同机其他服务）不进公开仓库**，
> 见部署机 `~/apps/homeledger/DEPLOY.md`（随部署落盘，与代码同更新）。

## 架构选型（2026-10-09 首次部署实测）

目标机为多站点服务器，既有惯例：**应用容器只绑 `127.0.0.1:<端口>`，公网一律走 Caddy 子域反代，
TLS 由 Caddy 自动签发/续期**。家账簿照搬该惯例，与其余服务互不干扰：

- **服务器本地构建**，不拉 GHCR：CI 镜像只在打 tag 时发布（规则：tag=发版、须维护者明确批准），
  latest 长期落后 main；本地构建可部署任意 commit，无 tag 依赖
- 不复用根目录 `docker-compose.yml`（那是 NAS 场景，`image:` 指向上游中转镜像），另写
  `docker-compose.prod.yml`：`build: .` + `127.0.0.1:5111:5111` + `env_file: .env` + `./data:/data`
- `.env`（600 权限）：`SESSION_SECRET`/`ADMIN_PASSWORD` 用 `openssl rand` 随机生成、
  `ALLOW_REGISTER=false`；镜像 tag 用部署 commit 短哈希（`homeledger:<sha>`）
- 数据全在 `~/apps/homeledger/data`（SQLite + 附件）：备份=整目录拷走，迁移=整目录搬走

## 标准部署步骤（runbook）

```
本地：  git bundle create /tmp/hl.bundle main && scp /tmp/hl.bundle <部署机>:/tmp/
部署机： git clone /tmp/hl.bundle ~/apps/homeledger        # 坑二：需补 fetch+checkout 才有分支
        cd ~/apps/homeledger
        git fetch /tmp/hl.bundle 'refs/heads/main:refs/heads/main' && git checkout -f main
        git remote set-url origin https://github.com/yibohub/homeledger.git   # 备用直连
        # 写 .env + docker-compose.prod.yml（要点见上节），mkdir -p data && chmod 700 data
        docker compose -f docker-compose.prod.yml up -d --build
        # Caddy：sudo cp Caddyfile Caddyfile.bak-$(date +%Y%m%d-%H%M) →
        #        tee -a 追加站点块 { reverse_proxy 127.0.0.1:5111 } →
        #        caddy validate → systemctl reload caddy（reload 不中断现有站点）
```

**验证清单**：容器 `healthy`；`healthz` 200；登录流（GET `/login` 取 `_csrf` → POST 302 →
带会话 GET `/` 200）；证书 issuer=Let's Encrypt。首访触发签证，重试几次再判失败。

## 升级 / 回滚

- 升级 = 部署机 `~/apps/homeledger/update.sh /tmp/hl.bundle`（fetch→ff-only→build→up -d→
  image prune，脚本已固化在部署机，含回滚提示）
- 回滚：`git checkout <旧commit> && docker compose -f docker-compose.prod.yml up -d --build`
- 升级前备份：`cp data/homeledger.db data/homeledger.db.bak-$(date +%F)`

## 坑

**坑一：部署机 `git clone https://github.com/...` 报 `GnuTLS recv error (-110)`**
根因：大陆网络对 GitHub 的 TLS 深连接被掐（`curl https://github.com` 200 只代表边缘可达，
git 传输层照样断）。方案：**代码分发一律走 git bundle**（`git bundle create` + scp +
fetch），不依赖目标机能直连 GitHub。bundle 667K 级，秒级传输。

**坑二：bundle 只打包单个 ref 时 `git clone` 报 `remote HEAD refers to nonexistent ref`，检不出分支**
根因：`git bundle create x.bundle main` 不含 HEAD 记录，clone 后停在无提交的 master。
方案：在克隆目录 `git fetch <bundle> 'refs/heads/main:refs/heads/main' && git checkout -f main`。

**坑三：`umask 177` 生成目录得到 `drw-------`，容器无法进入数据目录**
根因：目录缺执行位（x）= 无法遍历，对属主同样生效；umask 177 只适合文件。
方案：目录显式 `chmod 700`；uid 对齐（宿主 ubuntu=1000 = 容器 node=1000，bind mount 直接可写）。

## 防回归

- 升级路径固化在部署机 `update.sh`（bundle 流内建，直连失败自动兜底提示）
- 机器侧运维手册固化在部署机 `DEPLOY.md`（Caddy 备份惯例 / 常用命令 / 回滚）
- 相关规则：AGENTS.md §操作纪律（出网动作逐项确认）；发版到 NAS 的另一条路径见
  [deploy-nas.md](deploy-nas.md)
