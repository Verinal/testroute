# TestRoute

测试编排 Skill：路线规划、用例生成与标准化归档——七层标准测试链路、全流程证据链（trace/video/截图）、API 端点 × 深度覆盖硬门禁、案例卡与防伪封章报告。

引擎在工具、引导在 Skill，零依赖（纯 Node ≥18，无需 npm install）。**本仓库根目录就是 skill 本体，clone 即用。**

> **为什么叫 TestRoute？** 这里的 route 指「测试路线」——先规划测什么、按什么顺序测，再据此生成用例并归档；与 API 路由（routing）无关。

## 安装

下面用 `<skill目录>` 指代你的编辑器/宿主存放 skill 的目录（各宿主的常见取值见下表）。把本仓库 clone 为 `<skill目录>/testroute` 即完成安装：

```bash
git clone https://github.com/Verinal/testroute.git <skill目录>/testroute
```

`<skill目录>` 的常见取值：

| 宿主 | `<skill目录>` 参考取值 |
| --- | --- |
| Claude Code | `<项目>/.claude/skills` |
| Cursor | `~/.cursor/skills` |
| ZCode | `~/.zcode/skills`（项目级用 `<项目>/.zcode/skills`） |
| 其他宿主 | 任意固定路径即可，让 LLM 知道路径；不支持 skill 机制的宿主，把 SKILL.md 正文贴进系统提示/规则文件（如 `.cursor/rules`）同样生效 |

> 提示：`~` 代表当前用户主目录，Windows 下即 `C:\Users\<用户名>`。

## 使用

装好后对编辑器里的 LLM 说：

> 为这个项目规划测试路线并生成测试并执行
> / 或：只生成测试方案和用例，不要执行

不需要任何注册或配置，skill 自带完整工具引擎。

## 更新

```bash
git -C <skill目录>/testroute pull
```

## 说明

- 本仓库由自动化流程发布（build + 609 项自检门禁全部通过才推送），请勿手改
- License: MIT
