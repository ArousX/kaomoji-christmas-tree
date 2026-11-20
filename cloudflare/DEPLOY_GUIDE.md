# GitHub Pages + Cloudflare 共享圣诞树部署指南

只需要 **3 步（约 3 分钟）**，你的 GitHub Pages 圣诞树就能变成**全网所有人都能写信、所有人都能拆信**的共享圣诞树！

---

## 第一步：在 Cloudflare 创建 D1 数据库并部署 Worker

你既可以直接在浏览器里操作（无需装任何软件），也可以用命令行：

### 方式 A：纯网页控制台（最简单）
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 左侧菜单进入 **Storage & Databases -> D1 SQL Database**，点击 **Create**：
   - 数据库名填 `kaomoji-xmas-db`，创建即可（**不用手动建表**，`worker.js` 会在第一次访问时自动建表）。
3. 左侧菜单进入 **Compute (Workers) -> Workers & Pages**，点击 **Create -> Create Worker**：
   - 名字例如填 `kaomoji-xmas-cards`，点 **Deploy**。
4. 点右上角 **Edit code**，把 [worker.js](./worker.js) 的全部代码覆盖粘贴进去，点 **Deploy**。
5. 回到该 Worker 的 **Settings -> Bindings -> Add binding**：
   - Type 选 **D1 database**
   - Variable name **必须填 `DB`**
   - D1 database 选刚才建的 `kaomoji-xmas-db`，保存。
6. 复制 Worker 的域名（例如 `https://kaomoji-xmas-cards.你的子域名.workers.dev`），在浏览器打开 `你的域名/api/health`，看到 `{"ok":true,...}` 就成功了！

### 方式 B：命令行 `wrangler`（或安装 Antigravity 的 Cloudflare 插件）
```bash
cd "d:\file for Google\christmas_tree\cloudflare"
npx wrangler login
npx wrangler d1 create kaomoji-xmas-db
# 把返回的 database_id 填入 wrangler.toml，然后运行：
npx wrangler deploy
```

---

## 第二步：把 Worker 地址填进网页

打开 `d:\file for Google\christmas_tree\kaomoji_tree.html`，搜索 `CLOUDFLARE_API_URL`，把你的 Worker 地址填进去：

```js
const CLOUDFLARE_API_URL = 'https://kaomoji-xmas-cards.你的子域名.workers.dev';
```

> 小提示：当 `CLOUDFLARE_API_URL` 留空时，网页自动使用本地 `localStorage` 模式；填上后会自动切换为 **☁️ 全网共享模式**！

---

## 第三步：上传到 GitHub Pages

1. 新建一个 GitHub 仓库，把 `kaomoji_tree.html` 重命名为 `index.html`（或保留 `kaomoji_tree.html` 作为子路径）推送上去。
2. 在 GitHub 仓库的 **Settings -> Pages** 中选择从 `main` 分支根目录部署。
3. 把生成的 `https://你的用户名.github.io/仓库名/` 链接发给朋友，大家写的每一封信都会挂到这棵 3D 圣诞树上，互相都能看到并拆开！
