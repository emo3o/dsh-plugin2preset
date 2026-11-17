# dsh-plugin2preset — 插件转模式

把 **功能重、但只在特定场景才用** 的插件（例如 `dsh-rea` 逆向套件）装成一个**同名模式（agent preset）**。这样它的工具与 schema 只在你**主动选用该模式**的会话里加载，其余会话零上下文占用。

适用于 DeepSeek Harness（DSH）桌面端 / Web 端。

## 它解决的痛点

像 `dsh-rea` 这类带一大套 MCP 工具的插件，一旦作为 profile 级 bundle 装进来，它的**全部工具 schema 会注入到每一个会话**——哪怕你这次只是想写个脚本、聊个天，那几十 K token 的工具定义照样塞进请求里，白白吃上下文、拖慢首字、抬高成本。

理想状态是：**这类插件只在真正需要它的会话里出现**。本插件就是干这个的——把插件装进一个同名「模式」，用时再在模式选择器里挑一个**具备所需能力**的会话；不挑它，它就不在你面前出现，也不占你任何上下文。

## 工作方式

- 「直接安装」：老行为，装成全局 bundle，每个会话都加载。
- 「创造为同名模式」：把插件装成 **`enabled: false` 的依赖**（不进全局 bundles），再把 preset 声明写进 profile 的 `cordis.patch.yml` 托管区。重启后该模式出现在模式选择器里；新建会话时选它，插件的工具才在那个会话里加载。

一句话：**装的时候二选一——要么全局常驻，要么收进模式、用时再选。**

## 入口

- **插件页 Add plugin 菜单末尾** —「创造为同名模式…」：输入包名 / GitHub 地址 / 本地路径，弹窗二选一「直接安装 / 创造为同名模式」。
- **核心「安装插件」弹窗** — 底部「创造为同名模式」按钮。
- **dshmarket 安装确认弹窗** — 底部「创造为同名模式」按钮。
- **已装插件详情页头部** —「转为同名模式」：把已经在全局跑着的插件（如已装的 `dsh-rea`）抽出成模式，之后只在选中它的会话里加载。

## 具体实现

1. `pluginManager.installBundle(spec, { enabled: false })` —— 只装成依赖，不选入 `dsh.profile.bundles`，插件不在根平面加载，其余会话零占用。
2. 在 `<profile>/cordis.patch.yml` 的「托管区」写入 preset 声明：
   `preset-<id>` = `@deepseek-ai/dsh-agent-preset`，`plugins` 里挂一行 `{ id, name: <包名> }`。
   托管状态存 `<profile>/storages/dsh-plugin2preset/modes.json`。
3. 重启宿主后，该模式出现在模式选择器里；新建会话时选它，插件的工具才在那个会话里出现。

## 安装

### 方式一：GitHub 直接装（推荐）

在 DSH 的「添加插件」里填 GitHub 地址：

```
github:emo3o/dsh-plugin2preset
```

### 方式二：本地 link 到 profile

```jsonc
// profiles/<profile>/package.json 的 dependencies 里加：
"dsh-plugin2preset": "link:C:\\path\\to\\dsh-plugin2preset"
// 并在 bundles 里加 "dsh-plugin2preset"
```

## 说明

- 只包装声明了 `dsh.bundle` 的包；纯依赖库会被拒绝。
- 装/改模式走宿主 `pluginManager`，本插件不手写 profile 的 `package.json`。
- 需要重启宿主的情况会在弹窗里提示。
- 兼容旧版 marker：从旧版 `dsh-plugin-as-mode` 迁移时，读取旧托管区会自动改写为新 marker。

## 许可证

MIT
