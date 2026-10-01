# Changelog

## 0.2.0

需要 EmDash 1.0.1 及以上(peer `emdash ^1.0.1`)。

- 新设置 `mediaToken`(必填才能归档海报):只授予 `media:read`、`media:write` 的 EmDash API token,用于把海报归入 `neodb-posters` 目录,不再依赖访客登录。缺失时直接报错。
- 新设置 `internalToken`:主题 SSR 调 shelf 时带上,绕过公开限流。
- shelf 缓存按 NeoDB 账号和语言区分;后台「刷新」完成后清空缓存;shelf 响应改为 `no-store`。
- 刷新:识别分栏、嵌套内容里的卡片;带 `_rev` 写回,有未发布修改或状态变化的文章跳过并列出;同一时间只允许一次刷新(409);失败原因用中文显示。
- 只展示公开(visibility 0)的个人标记,私密标记不再写进卡片。
- NeoDB 上游失败时保留已有标记;外部请求加 8 秒超时。

## 0.1.0

首发。

- NeoDB 条目卡片:编辑器粘贴 NeoDB / TMDB 链接生成 `neodb` 块,`content:beforeSave` 自动抓取快照(标题、年份、评分、简介、外链、演职员、个人标记),海报入库 `neodb-posters` 媒体目录。
- 公开路由 `GET /_emdash/api/plugins/neodb/shelf`(书影音 shelf 数据,分页、限流、缓存)。
- 后台「刷新」页与 `POST /_emdash/api/plugins/neodb/refresh`:全量重拉快照并写回文章。
- 设置:`token`(必填)、`language`(默认 `zh-CN`)、`posterUrlTemplate`(海报 URL 模板,留空用媒体库公开 URL)。
