# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

- 这是一个面向 Obsidian 的插件，用来做类 Anki 的闪卡和间隔重复复习。
- 项目主体高度集中在 `main.ts`；`styles.css` 负责界面样式，`manifest.json` / `versions.json` 负责 Obsidian 插件声明。
- `main.js` 是 esbuild 生成的产物。应修改 `main.ts` 后重新构建，不要直接改生成文件。

## 常用命令

- `npm install` — 安装依赖。
- `npm run dev` — 启动 esbuild 监听模式，并根据 `main.ts` 重新生成 `main.js`。
- `npm run build` — 先执行 TypeScript 类型检查（`tsc -noEmit -skipLibCheck`），再用 esbuild 生成生产构建。
- 目前 `package.json` 里还没有 lint 脚本，也没有自动化测试运行器。
- 目前也没有单独跑某个测试的命令；主要验证方式是 `npm run build`。

## 架构概览

- `main.ts` 里的 `ObKiPlugin` 是入口类，负责生命周期、持久化、命令、侧边栏图标、快捷键和视图注册。
- 插件运行时状态保存在 `this.data` 和 `this.settings` 中，再通过 Obsidian 的 `loadData` / `saveData` 以及插件数据目录下的每个卡组 JSON 文件进行持久化。
- 卡组状态不只是普通卡片列表：每个卡组还包含复习日志、卡组级设置、微卡组，以及一个学习顺序树。
- `saveObKiData()` 是核心持久化路径：它同步插件级元数据、写出每个卡组文件，并刷新已打开视图。
- `normalizeDeckTree()` 和 `normalizeDeckStudyOrder()` 是主要的一致性修复辅助函数，用来在保存前、加载后修正树结构和顺序结构。
- 自定义工作区视图由 `ObKiDeckView` 实现；卡组浏览、复习流程、批量操作和拖拽交互大多都在这里。
- 设置界面、添加/编辑对话框、移动对话框、健康检查界面和 AI 生成对话框都写在同一个文件里，因此一个功能改动通常会同时影响 UI 和辅助逻辑。
- 复习调度使用 `ts-fsrs`。`gradeCard()` 会把应用内评分映射为 FSRS 评分，更新卡片，记录复习日志，并保存撤销状态。
- AI 制卡对接的是设置里配置的、兼容 OpenAI chat completions 的接口。模型列表优先走 `/models`，也支持手动填写模型名。
- Anki 导出使用 `anki-apkg-export` 和 `sql.js`，`AnkiMediaProcessor` 以及 markdown 辅助函数负责媒体和链接渲染。
- 健康检查会扫描缺失的来源链接、Wiki 链接和嵌入图片。

## 编辑说明

- UI 样式集中在 `styles.css` 的 `.ob-ki-*` 命名空间下。界面改动通常需要同时调整 `main.ts` 里的结构和 `styles.css`。
- 这个代码库目前本质上还是单文件插件，动手前先看清相关辅助函数群，再决定是否拆分抽象。
