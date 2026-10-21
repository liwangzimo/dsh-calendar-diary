# dsh-calendar-diary（日历日记）

一个**纯记事本**式的 DSH 插件：一天一条，写在你自己的一个 `.xlsx` 里。侧栏一个月历面板（一次显示 10 周），会话输入框上方一条「今日」横条。

没有提醒、没有通知、没有标签、没有搜索、没有云同步，也**不联动官方「自动化任务」**。除了你指定的那个 `.xlsx` 和插件自己的配置目录，它不写别的地方，也不联网。

## 功能

- **侧栏「日历日记」**：月历网格一次显示 **10 周**（10 行 × 7 天，周一开头），格子里**直接显示当天内容**（超出一格的部分裁切，鼠标悬停看全文）；有记录的日子带标记；可左右切月、回到今天；点某天打开编辑框写 / 改 / 删（保存、`Ctrl+Enter`、删除本条）。
- **输入框上方「今日」横条**：不离开对话就能写今天那一条。
- **数据文件一栏**：显示当前数据文件路径，「更改…」可换（只换指向，不搬数据）。
- **导入**：选 `.xlsx` / `.xls` → **先预览**（来源、行数、日期范围、新增 / 冲突 / 未变 / 跳过，冲突逐条列出）→ 选冲突策略（默认**保留现有**）→ 确认后才写盘，写前自动备份。
- **导出**：范围「全部 / 某年 / 某月」→ 写出同构的 `.xlsx`，只写新文件、绝不动数据文件；目标若就是当前数据文件本身会被**拒绝**（导出不备份，覆盖等于把范围外的天数一次删光）。

## 安装

需要 DSH（桌面版或网页版均可；本插件同时有宿主半与客户端半）。`dsh plugin` 会把剩余参数**原样转发给 profile 目录里的 pnpm**，所以 `--profile` 是它自己的选项，必须写在 `add` **之前**（写成 `plugin add … --profile desktop` 会报 `required option '--profile <name>' not specified`）。

**方式一：从 GitHub**

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile <profile> add "github:liwangzimo/dsh-calendar-diary" --config.minimumReleaseAge=0
```

**方式二：克隆到本地后按目录安装**（改代码即生效，但要重启）

```powershell
git clone https://github.com/liwangzimo/dsh-calendar-diary.git
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile <profile> add "link:<克隆下来的目录>" --config.minimumReleaseAge=0
```

> `--config.minimumReleaseAge=0` 只放宽这一次命令的供应链策略（DSH 的 profile 默认拒绝"太新"的包）。不加可能因 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 失败。

### 装完必须再做一步：注册 bundle

`dsh plugin add` **只加依赖**。还要在 profile 的 `package.json` 里把插件登记进 `dsh.profile.bundles`，即在这个数组里加一行字符串：

```json
"dsh": {
  "profile": {
    "bundles": [
      "…",
      "dsh-calendar-diary"
    ]
  }
}
```

**只装依赖不登记 bundle 是不会加载的。** 两处都改完后，**完全退出并重开 DSH**——本插件不支持热更新（刷新页面、关窗重开都无效，客户端代码是在启动时打包进图的）。

重启后确认生效：侧栏出现「日历日记」面板，或打开 `http://<DSH 地址>/dsh-calendar-diary/state` 看到 JSON。

### 回滚

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile <profile> remove dsh-calendar-diary
```

再把 `dsh.profile.bundles` 里那行删掉，重启。

## 数据格式

数据文件是一个 `.xlsx`，默认位置是你用户目录下的 `.dsh/dsh-calendar-diary/diary.xlsx`（第一次运行时创建；面板里可改）：

| 项 | 值 |
| --- | --- |
| 工作表 | `DesktopCal` |
| A 列 | 整数 Excel 日期序列号（1900 系统），单元格格式固定 `m/d/yy`（显示成 `11/25/26`） |
| B 列 | 自由文本，可多行（`\r\n`），时间直接写在文本里 |
| 行序 | 日期降序；一天最多一行 |

这个形状与桌面日历软件 DesktopCal 导出的两列表一致，所以老数据可以直接导入。

**为什么数据文件只写 `.xlsx` 而不是 `.xls`**：把上千行写回 `.xls` 会**静默截断长度超过 255 字符的单元格**，不报错、不提示。写 `.xlsx` 实测 0 处值差异、0 处格式差异、0 处文本差异。所以导入收 `.xls`，但**数据文件只写 `.xlsx`**。

## HTTP 路由（宿主半注册，客户端同源 fetch）

客户端不依赖任何会话或命令通道，只用相对路径 `fetch(..., { cache: 'no-store' })` 调这些路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-calendar-diary/state` | 数据文件路径、是否存在 / 可写、总行数、有记录的月份（降序）、今天 |
| GET | `/dsh-calendar-diary/entries?month=YYYY-MM` | 该月条目 `[{ date, serial, text }]` |
| POST | `/dsh-calendar-diary/entries` | `{ date, text }` 写入 / 覆盖一天；`text:''` 置空但保留行 |
| POST | `/dsh-calendar-diary/entries/remove` | `{ date }` 删掉该行 |
| POST | `/dsh-calendar-diary/path` | `{ dataPath }` 换数据文件（校验是可用日记、拒绝 `.xls`） |
| POST | `/dsh-calendar-diary/pick-dir` | 原生文件夹对话框（不可用时返回 `{ok:false,error}`，界面回落手输） |
| POST | `/dsh-calendar-diary/list-files` | `{ dir }` 列出候选 `.xlsx` / `.xls` |
| POST | `/dsh-calendar-diary/import/scan` | 只读预览导入，不写盘 |
| POST | `/dsh-calendar-diary/import/apply` | `{ sourcePath, policy }` 执行导入（先备份再原子写） |
| POST | `/dsh-calendar-diary/export` | `{ scope, value, outPath }` 导出新 `.xlsx` |

错误一律是 JSON：`{ ok:false, error:'<code>' }` + 4xx/5xx。方法不匹配返回 `405` 并在 JSON 里给出 `allow`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：注册上面 10 条路由，持有全部文件读写 |
| `diary-io.js` | I/O 层：读 / 原子写 / 备份 / 导入 / 导出（只用 `node:fs` + `xlsx`，不碰 ctx，所以能在纯 Node 里被验证） |
| `diary-store.js` | 纯数据层：序列号↔日期、解析、排序、upsert / remove、导入合并策略（无 I/O、无时钟） |
| `client.js` | 浏览器半：月历面板 + 今日横条 + 导入导出 |
| `locale/zh.json`、`locale/en.json` | 界面文案（键集合两边完全一致） |
| `cordis.patch.yml` | loader 补丁：一行把宿主半挂上（`package.json` 的 `dsh.bundle.patch` 指向它） |
| `tests/diary-store.test.mjs` | 数据层单测（含用真实 DesktopCal 导出测出的序列号锚点） |
| `tools/migrate.mjs` | 从 `.xls` 迁移到 `.xlsx` 并做 0 差异校验的一次性工具 |

## 开发与自测

```powershell
node --test tests/diary-store.test.mjs   # 数据层单测（纯函数，无 I/O）
node tools/migrate.mjs --help            # 迁移工具用法
```

宿主半的路由可以用假 req/res 在纯 Node 里驱动，不需要启动 DSH。

## 已知边界（都是有意的，不是待办）

- **一天只保留一行**。如果数据文件里同一天被人手工塞了两行，读取时按"首行优先"取一行；下一次任何写入都会按这个结果重写整个文件，也就是那一行会从正式文件里消失。它仍在**那一次写入生成的 `.bak-<时间戳>` 里**，所以可恢复。本插件自己不会产生重复行。
- **"必须先预览再导入"是客户端门槛**。宿主半边按设计**无状态**：`/import/apply` 单独调用也会执行（但不支持按天逐个决策）。这条防线在 UI 上，不在协议上。
- **相对路径**按插件主目录（`~/.dsh/dsh-calendar-diary`）解析，不按宿主进程的工作目录——否则同一个相对路径会随启动方式指向不同地方。
- **写入失败不会留下垃圾**：临时文件在失败时被清掉，数据文件本身只在最后一步 `rename` 时才会被替换，所以"写失败"永远不等于"文件损坏"。失败时仍可能已经生成了一份 `.bak-`。
- **两位数年份的文本日期**（如 `11/25/26`）一律按 20xx 解释，与 Excel 在这段日期范围内的行为一致。
- 每个进程**首次写入前**做一次备份（`diary.xlsx.bak-<yyyyMMdd-HHmmss>`），同一次运行内不重复备份。
- **10 周视图下格子会偏小**：面板越窄（尤其编辑框并排时）每格越窄，"格子里显示内容"只是提示，全文以悬停提示或点开编辑框为准。

## 许可

[MIT](LICENSE)
