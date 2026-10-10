# NAS 部署运维（docs/solutions/deploy-nas.md）

> 现象 → 根因 → 方案。起步篇：先沉淀实际踩到的坑（语音 not-allowed），容器管理器/镜像源切换/
> ZeroTier 组网等内容后续按需补齐（对应看板待办「deploy-nas 知识沉淀」逐步落盘）。

## 坑一：部署后点麦克风提示「语音识别失败（not-allowed）」（2026-10-09，v1.10.0 实测）

**现象**：群晖部署后，悬浮球 / 极简捕获区点话筒，提示「语音识别失败（not-allowed），可以直接输入」。

**根因**：Web Speech API（`SpeechRecognition`）只在**安全上下文**（HTTPS 或 localhost）可用。
NAS 通过 `http://<NAS-IP>:5111`（局域网 / ZeroTier IP）访问是普通 HTTP，浏览器直接拒绝
麦克风类 API——报错名就叫 `not-allowed`。**不是识别坏了，是 API 起不来**。同理受影响的还有
`getUserMedia` 等一切需要权限的浏览器能力。

**方案（按稳妥程度排序）**：

1. **自签证书 + 反向代理 + 导入信任（纯本地，推荐但要做完最后一步）**
   - 控制面板 → 证书 → 新增 →「创建自签名证书」（DSM 7.0/7.1 入口在「安全性 → 证书」）
   - 控制面板 → 登录门户 → 高级 → 反向代理：来源 `https`、主机名必填（填 NAS 主机名或
     ZeroTier IP）、端口自选（如 `5443`）、启用该证书；目标 `http`、`localhost:5111`
   - **关键一步（不做完语音仍不可用）**：Chrome 对「证书错误插页 → 继续前往」的页面会
     **自动拒绝麦克风等权限**，Web Speech 依旧报 not-allowed。必须把 DSM 导出的证书
     （设置 → 证书 → 导出 .pem）**安装进访问设备的系统信任存储**：
     - Windows：双击 .cer → 安装证书 → 本地计算机 → 受信任的根证书颁发机构
     - iOS：描述文件安装后，还要到 设置 → 通用 → 关于本机 → 证书信任设置 里手动开启完全信任
     - Android：设置 → 安全 → 加密与凭据 → 安装证书
   - 之后 `https://<主机名>:5443` 为无警告的安全上下文，麦克风可用
2. **有公网域名的话**：DSM 证书用 Let's Encrypt（需 DDNS/公网解析），同样走反代——
   无需导入信任，最省心
3. **不配 HTTPS 的替代**：系统键盘听写（iOS/Android 输入法麦克风），体验接近，
   输入的就是文本，走既有文字识别管线——HTTP 下最省事的方案

**代码侧配套（v1.10.1）**：麦克风按钮增加 `window.isSecureContext` 门控——HTTP 访问时
按钮不再出现（此前是点了才报错）；`not-allowed` 错误文案改为对症提示（需 HTTPS + 授权）。

**追问（2026-10-10 华为手机实测）：HTTPS 配好、话筒按钮已出现，点击仍报 not-allowed？**
按钮出现只说明「API 存在 + 安全上下文成立」，not-allowed 是浏览器拒了麦克风权限，按序排查：

1. 地址栏是否还有「不安全」提示——通过「高级 → 继续前往」插页进入的页面，浏览器会
   **静默自动拒绝**麦克风（见上「关键一步」）：证书必须导入设备信任存储后**重新进入**
2. 站点麦克风权限被拒过：锁图标 → 网站设置 → 麦克风 → 允许，重试；
   **站点设置里连「麦克风」选项都没有 = 该浏览器没有网页麦克风权限体系**，无处置权
3. 操作系统层没给浏览器应用麦克风：设置 → 应用 → 华为浏览器 → 权限 → 麦克风 → 允许，
   然后**彻底划掉浏览器重开**（网页层开了系统层没开时同样报 not-allowed 且不弹任何提示）
4. **三层全开（证书信任/站点/系统）仍 not-allowed = 浏览器识别引擎缺失**（API 对象存在
   所以按钮会出现，但引擎没有云服务可用，start() 直接失败）——华为鸿蒙浏览器实测如此，
   此路终局，用系统键盘听写。另有一条殊途同归的变体：权限通了但报错变成
   「语音识别失败（network）」——同样是内核没有识别服务后端（识别是浏览器厂商的云服务，
   国产内核没有配套）。两态都终局于键盘听写。想区分「不能录音」还是「不能识别」可开
   [mictests.com](https://mictests.com) 验证：能录但不能识别 → 服务端转写兜底可行（见 BOARD 押后）

浏览器支持速查：Chrome / Edge（各家云识别）✅；Safari 14.1+（含 iOS，Siri 后端）✅；
Firefox ❌（从未实现）；Opera/Brave 等 Chromium 壳 ⚠️（API 在但事件不触发）；
华为鸿蒙等国产浏览器 ❌（无识别后端）。

## 坑二：键盘避让在华为浏览器时好时坏（2026-10-10，kb-diag 实测定案）

**现象**：极简模式键盘弹出底栏该藏不藏（m.js 的 kb-open 检测），且时好时坏、
与代码版本对不上。

**根因（诊断页实测定案）**：华为浏览器 UA `ArkWeb/7.0.0.107`（HuaweiBrowser/6.1.8.301，
screen 320×726 CSS px）的键盘高度上报是**一秒内 6+ 个事件的爆发式动画**
（vv 611→623→635→636 逐步过渡，vv 先动、innerHeight 跟在后面）——适配逻辑若在
动画中途采样，会把中间值学进「键盘收起基准高度」（基准学小/学乱），之后判定失效；
事件驱动的自愈又依赖下一次事件，时序不巧就死到底。这与「改 A 功能、B 坏了」的
版本时间线只是巧合同窗。

**方案（v1.11.0 待发）**：检测改为「事件去抖 + 500ms 轮询」双通道（PR #19）——
轮询不依赖事件到达，基准被污染后键盘收起的首个采样即自愈；采样一律过 250ms
去抖（旋转动画同理防中间值）。载入时键盘已占屏学小基准的场景同样由轮询兜底。

**ArkWeb 实测特征备查**：`vv.scale` 常态即 0.96~0.97（非 1.0，且页面间漂移——捏合守卫
已改为相对本页干净态 scale0 判定 + vv/ih 比例双条件，勿再用绝对 scale 魔数）；键盘开
≈368px vs 全高 638px（地址栏收展还有 ~10% 振荡：580↔638）；`pointer: coarse` true /
`hover: false` 正常；Web Speech 无识别后端（见坑一）。

## 发版到 NAS 的标准路径

```
维护者推 tag（vX.Y.Z）→ CI 双架构镜像发布 GHCR（镜像 tag 无 v 前缀：X.Y.Z / latest）
→ NAS：cd /volume1/docker/homeledger && docker compose pull && docker compose up -d
→ 验证：http(s)://<NAS-IP>[:端口]/healthz 200 + 关于页版本号
```

- 拉取走中转 `ghcr.milu.moe/yibohub/homeledger`；中转不可用时备选 DaoCloud / 南大镜像源，
  或本地 `docker pull` + `docker save/load`（细节待沉淀）
- 升级前备份数据库：停容器后 `cp data/homeledger.db data/homeledger.db.bak-$(date +%F)`
- 每日自动备份：控制面板 → 任务计划 → 每日 rsync/cp `/volume1/docker/homeledger/data`
  到另一共享文件夹（**待配置**，见看板发版节）

## 防回归

- verify-ai-chat / verify-minimal 各有一条 `isSecureContext` 断言：门控被删会红
- 相关规则：AGENTS.md §操作纪律（NAS 侧动作逐项确认）；姊妹篇见
  [route-shadowing.md](route-shadowing.md)、[windows-test-infra.md](windows-test-infra.md)
