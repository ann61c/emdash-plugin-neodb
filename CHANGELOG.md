# Changelog

## 0.1.0

首发。

- NeoDB 条目卡片:编辑器粘贴 NeoDB / TMDB 链接生成 `neodb` 块,`content:beforeSave` 自动抓取快照(标题、年份、评分、简介、外链、演职员、个人标记),海报入库 `neodb-posters` 媒体目录。
- 公开路由 `GET /_emdash/api/plugins/neodb/shelf`(书影音 shelf 数据,分页、限流、缓存)。
- 后台「刷新」页与 `POST /_emdash/api/plugins/neodb/refresh`:全量重拉快照并写回文章。
- 设置:`token`(必填)、`language`(默认 `zh-CN`)、`posterUrlTemplate`(海报 URL 模板,留空用媒体库公开 URL)。
