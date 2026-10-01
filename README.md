# emdash-plugin-neodb

[emdash](https://www.npmjs.com/package/emdash) 的 [NeoDB](https://neodb.social) 插件:把 NeoDB 条目(书影音游戏)变成文章里的条目卡片,并对外提供一个「书影音 shelf」JSON 接口,配合宿主主题渲染个人标记页。

- 插件 ID:`neodb`,包名 `emdash-plugin-neodb`,MIT。
- 管理界面与元数据标签(类型 / 作者 / 想看 / 看过……)为中文——NeoDB 生态以中文为主,暂无英文版计划。

## 安装

插件以源码形式分发(宿主用 Vite/Astro 直接编译 TS),没有构建产物。

1. 把本目录拷进宿主仓库的 `plugins/neodb/`(或在 workspace 里引用):

   ```jsonc
   // 宿主 package.json
   "workspaces": ["plugins/*"],
   "dependencies": { "emdash-plugin-neodb": "*" }
   ```

2. 在 `astro.config.mjs` 注册:

   ```js
   import { neodbPlugin } from 'emdash-plugin-neodb';

   export default defineConfig({
     integrations: [
       emdash({ /* ... */ plugins: [neodbPlugin()] }),
     ],
   });
   ```

3. **`optimizeDeps` hack(重要)**:插件的后台页 import 了 `emdash/plugin-utils`,而 emdash 自身的 Vite `optimizeDeps` 列表不包含它。首次访问后台时 Vite 才发现这个依赖,会触发中途重新预构建和整页 reload(504 Outdated Optimize Dep、React 双份报 `dispatcher is null`)。宿主需要预先声明:

   ```js
   // astro.config.mjs
   vite: {
     optimizeDeps: { include: ['emdash/plugin-utils'] },
   },
   ```

4. 宿主需已配置 React 集成(`@astrojs/react`,后台页是 React 组件)。

## 设置

后台「插件 → NeoDB → Settings」:

| 设置 | 必填 | 说明 |
|---|---|---|
| `token` | 是 | NeoDB 个人 API token。在 [neodb.social/settings/](https://neodb.social/settings/) 页面「API Token」处创建。没有它,shelf 路由与个人标记抓取会直接报错。 |
| `mediaToken` | 是 | EmDash API token，仅授予 `media:read`、`media:write`，用于把新上传和复用的封面归入 `neodb-posters`，不依赖访客登录。 |
| `language` | 否 | 请求 NeoDB API 的 `Accept-Language`,影响返回的标题与简介语言。默认 `zh-CN`(可选 `en`)。 |
| `posterUrlTemplate` | 否 | shelf 海报 URL 模板,见下。 |

### `posterUrlTemplate`

占位符:`{origin}` = 媒体公开 origin(取环境变量 `S3_PUBLIC_URL` 的 origin)、`{key}` = 媒体 storageKey、`{width}` = 目标宽度(96 / 192)、`{height}` = 目标高度(128 / 256)。

- **留空**(默认):直接返回媒体库公开 URL(`/_emdash/api/media/file/<key>`,原图,由 emdash 的媒体路由服务,不做任何变换)。
- **非空**:按模板替换生成。插件本身不假设任何 CDN;如果宿主在 Cloudflare 后面并开通了 Image Transformations,可以用:

  ```
  {origin}/cdn-cgi/image/width={width}%2Cformat=auto%2Cmetadata=none%2Conerror=redirect/{key}
  ```

  (需要与设置项出现之前的硬编码输出逐字节一致时,用全参数版本:`{origin}/cdn-cgi/image/width={width}%2Cheight={height}%2Cfit=cover%2Cquality=80%2Cformat=auto%2Cmetadata=none%2Conerror=redirect/{key}`。)

模板用到 `{origin}` 时宿主必须设置 `S3_PUBLIC_URL`;模板不含 `{origin}` 则不需要。注意:shelf 内部缓存 1 小时,改模板后最长 1 小时内旧 URL 仍会出缓存。

## 编辑器用法

在文章编辑器里粘贴一个 NeoDB 条目链接(如 `https://neodb.social/movie/xxxxx`)或 TMDB 链接,会变成 `neodb` 卡片块。保存时 `content:beforeSave` 钩子:

1. 向 NeoDB 抓取条目快照(标题、原名、年份、评分、简介、外链清单、类型元数据、你的标记 / 评分 / 短评),写进块内,渲染不再依赖 NeoDB 在线;
2. 把海报下载并上传到 emdash 媒体库的 `neodb-posters` 目录(去重:同一 uuid 只存一份)。

TMDB 链接走 NeoDB 的 catalog/fetch 代理,首次抓取可能需要轮询等待。

## 公开路由

### `GET /_emdash/api/plugins/neodb/shelf`

| 参数 | 取值 | 默认 |
|---|---|---|
| `type` | `movie` / `book` / `music` / `game` / `drama` | `movie` |
| `status` | `wishlist` / `progress` / `complete` / `dropped` | `complete` |
| `page` | 1–50 | `1` |

- 无需认证;限流 **60 次/分钟/IP**(超出 429);`Cache-Control: public, max-age=300`。
- 返回 `{ ok, page, pages, count, items: [{ uuid, title, year, rating, mine, marked, coverKey, poster, poster2x, url, category }] }`。
- 内部缓存 1 小时(按 type/status/page)。

### `POST /_emdash/api/plugins/neodb/refresh`

需要 `plugins:manage` 权限(后台管理员)。全量扫描文章里的 `neodb` 块,强制重拉快照、补传海报并写回(已发布的文章保持发布状态)。并发锁 10 分钟。`GET` 同路径返回上次刷新状态。

## 后台「刷新」页

后台侧栏「NeoDB」:显示上次刷新时间与结果(posts / blocks / uploaded / skipped / failed 明细),按钮触发上面的 refresh。

## 环境变量

| 变量 | 说明 |
|---|---|
| `EMDASH_INTERNAL_ORIGIN` | **必需**。插件 REST 自调用(媒体查询、文件夹、发布文章)用的内部 origin,如 `http://localhost:4331` 或内网地址。缺失时刷新 / 海报入库直接报错。 |
| `S3_PUBLIC_URL` | 仅当 `posterUrlTemplate` 用到 `{origin}` 时必需。 |

## 能力清单

- `network:request` — 抓 NeoDB API 与海报原图(仅 `neodb.social`)。
- `content:write` — `content:beforeSave` 填快照;refresh 写回文章。
- `media:write` — 海报上传 / 查询 / 归档到 `neodb-posters` 目录。
- `allowedHosts: neodb.social` — 出网仅此一家。

## 宿主前提

- emdash **0.36.0**(实测依赖的 `ctx.media / ctx.kv / ctx.storage / ctx.content / ctx.http`、`admin.settingsSchema`、`portableTextBlocks`、public/管理 routes、`content:beforeSave`)。
- 卡片图(正文里的海报)由宿主的 Astro image service 负责:卡片组件用 `astro:assets` 的 `getImage` + `Astro.locals.emdash.getPublicMediaUrl`,宿主没配 image service(或 service 要求外部域白名单)时卡片图不工作。
- shelf 海报 URL 形状完全由 `posterUrlTemplate` 决定(见上)。

## 已知限制

- 元数据标签、状态名、后台 UI 全中文。
- 卡片渲染组件 `NeodbCard.astro` 通过 `componentsEntry` 注入宿主;RSS / 摘要里的卡片渲染由宿主主题自己实现(本插件不提供 HTML 串)。
- shelf 数据来自 NeoDB「我的 shelf」,单用户视角。

## License

MIT — 见 [LICENSE](./LICENSE)。
