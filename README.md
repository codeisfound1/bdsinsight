# 🏠 BĐS Insight AI

Blog bất động sản tự động, chạy **hoàn toàn trên GitHub** — không cần server, không cần Netlify.

```
your-blog/
├── .github/
│   └── workflows/
│       └── generate.yml   # Tự động chạy mỗi ngày + manual trigger
├── docs/
│   ├── index.html          # Frontend — GitHub Pages serve từ đây
│   └── posts.json          # Database bài viết (tự động commit bởi Actions)
├── scripts/
│   ├── generate.js         # Script crawl + Groq AI + lưu posts.json
│   └── package.json        # Dependencies (chỉ node-fetch)
└── package.json
```

## 🚀 Deploy trong 3 bước

### Bước 1 — Fork / Push lên GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/TEN_BAN/TEN_REPO.git
git push -u origin main
```

### Bước 2 — Thêm Secret

Vào **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|------|-------|
| `GROQ_API_KEY` | Key từ [console.groq.com](https://console.groq.com) (free) |

### Bước 3 — Bật GitHub Pages

Vào **Settings → Pages**:
- Source: **Deploy from a branch**
- Branch: `main` / folder: `/docs`
- Nhấn **Save**

Blog sẽ live tại: `https://TEN_BAN.github.io/TEN_REPO/`

---

## ⚡ Đăng bài thủ công

Vào tab **Actions** → chọn workflow **"Tạo bài blog tự động"** → nhấn **Run workflow**.

## 🕐 Lịch tự động

Mỗi ngày lúc **7:00 sáng** (giờ Việt Nam), Actions tự chạy, crawl bài mới, sinh nội dung bằng Groq AI rồi commit `posts.json` vào repo. GitHub Pages tự cập nhật sau ~30 giây.

## 🔧 Tùy chỉnh

Mở `scripts/generate.js`, thay đổi:
```js
const SOURCE_URL = "https://wiki.batdongsan.com.vn/tin-tuc"; // Nguồn crawl
const GROQ_MODEL = "llama-3.1-8b-instant";                   // Model AI
```

Mở `.github/workflows/generate.yml`, thay đổi lịch:
```yaml
- cron: '0 0 * * *'   # 7:00 sáng VN (00:00 UTC)
# - cron: '0 */12 * * *' # Mỗi 12 tiếng
```
