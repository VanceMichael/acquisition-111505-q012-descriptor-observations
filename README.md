# 环境观测交换流的描述符展开与缺测资料采集

这是面向资料接收人员的 Node.js 服务。当前提供人工收件、描述符驱动的自动采集、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。自动采集按公告声明的描述表版本展开位流：延迟重复组按次数落实每个传感器观测，作用域内的比例/参考值变化只影响对应嵌套成员，缺测位型保持缺测（不变极端值、不拿别的站点补齐），站点与观测时间归属到每条记录。未知描述符、位流截断或填充异常会使对应公告失败并报告已确认到哪一步，不猜测跳过，也不输出看似合理的记录。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、解码、采集、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；`SOURCE_URL` 指定 `/api/collect` 的默认来源，缺省 `http://127.0.0.1:4200`。`npm run demo` 使用临时目录和系统分配端口展示人工收件、自动采集、描述表改版后的旧交付解释与未知描述符处置，结束即清理，通常只需数秒。

## 容器

`docker build -t descriptor-observations:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 descriptor-observations:local` 启动。环境准备后，`docker run --rm --network none descriptor-observations:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象。`POST /api/collect` 从来源自动采集：请求体可省略，也可提交 `{"source": "http://…"}` 覆盖默认来源；响应逐公告给出状态。成功公告的每个传感器观测按 station, tableVersion, sensor 身份归档（来源命名空间 `source:<来源地址>`，与人工收件互不混淆），observationTime 随公告归属到每条记录，重复采集复用既有版本。描述表按版本留存在归档 `tables/` 下：来源表改版后，仍声明旧版本的交付按留存表解释；同一版本内容发生静默变化会被拒绝。公告级失败（表版本无法取得、位流截断、末尾填充非零、延迟重复次数缺测、未知描述符）不写入归档、不影响其他公告，响应中给出已确认观测轨迹与断开位置。`GET /api/records` 查询全部收件版本，`GET /health` 检查进程。

记录身份字段为 station, tableVersion, sensor。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs、按业务身份保存的 receipts 和按版本留存的描述表 tables。

`src/` 为收件、解码与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。
