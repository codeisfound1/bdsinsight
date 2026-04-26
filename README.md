# 🏠 BĐS Insight AI

Blog bất động sản tự động, chạy **hoàn toàn trên GitHub** — không cần server, không cần Netlify.

```
your-blog/
├── .github/
│   └── workflows/
│       └── generate.yml   # Tự động chạy mỗi ngày + manual trigger
├── docs/
│   ├── index.html          # Frontend — GitHub Pages serve từ đây
│   ├── posts.json          # Database bài viết (tự động commit bởi Actions)
│   ├── sitemap.xml         # Sitemap tự động, kèm image:image cho Google
│   └── robots.txt          # Trỏ về sitemap
├── scripts/
│   ├── generate.js         # Script crawl + Groq AI + Cloudinary + lưu posts.json
│   └── package.json
└── package.json
```

## 🚀 Deploy trong 4 bước

### Bước 1 — Fork / Push lên GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/TEN_BAN/TEN_REPO.git
git push -u origin main
```

### Bước 2 — Thêm Secrets

Vào **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value | Bắt buộc |
|------|-------|-----------|
| `GROQ_API_KEY` | Key từ [console.groq.com](https://console.groq.com) (free) | ✅ |
| `CLOUDINARY_CLOUD_NAME` | Cloud name từ [cloudinary.com](https://cloudinary.com) dashboard | Khuyến nghị |
| `CLOUDINARY_API_KEY` | API Key trong Cloudinary dashboard | Khuyến nghị |
| `CLOUDINARY_API_SECRET` | API Secret trong Cloudinary dashboard | Khuyến nghị |

> Nếu không thêm Cloudinary secrets, script vẫn chạy bình thường — ảnh dùng URL gốc từ nguồn crawl.

### Bước 3 — Bật GitHub Pages

Vào **Settings → Pages**:
- Source: **Deploy from a branch**
- Branch: `main` / folder: `/docs`
- Nhấn **Save**

Blog sẽ live tại: `https://TEN_BAN.github.io/TEN_REPO/`

### Bước 4 — Chạy lần đầu

Vào tab **Actions** → chọn workflow **"Tạo bài blog tự động"** → nhấn **Run workflow**.

---

## 🖼️ Xử lý ảnh với Cloudinary (SEO)

Khi cấu hình Cloudinary, mỗi ảnh crawl về được upload lên Cloudinary với:

| Tối ưu | Chi tiết |
|--------|----------|
| **public_id** | Dùng slug bài viết (`bdsinsight/posts/ten-bai-viet`) — URL dễ đọc, Google index được |
| **Alt text** | Tự động điền từ tiêu đề bài viết — bắt buộc cho Google Image Search |
| **Context** | `alt` + `caption` lưu trong metadata Cloudinary |
| **Tags** | Từ khoá bài viết gắn vào asset |
| **Transform** | `f_auto` (WebP/AVIF), `q_auto`, resize `1200×630` (chuẩn OG) |
| **Sitemap** | Mỗi bài có `<image:image>` với `loc` + `title` + `caption` cho Google |

**Cấu trúc `image` trong `posts.json` sau khi upload:**

```json
{
  "image": {
    "url":      "https://res.cloudinary.com/CLOUD/image/upload/f_auto,q_auto,w_1200,h_630,c_fill,g_auto/bdsinsight/posts/ten-bai-viet",
    "rawUrl":   "https://res.cloudinary.com/CLOUD/image/upload/bdsinsight/posts/ten-bai-viet",
    "publicId": "bdsinsight/posts/ten-bai-viet",
    "width":    1200,
    "height":   630,
    "format":   "jpg",
    "alt":      "Tiêu đề bài viết đầy đủ"
  }
}
```

**Dùng trong frontend:**
```js
// Lấy URL ảnh (tương thích cả object lẫn string cũ)
var src = post.image && typeof post.image === 'object' ? post.image.url : post.image;
var alt = post.image && post.image.alt ? post.image.alt : post.title;
```

---

## ⚡ Đăng bài thủ công

Vào tab **Actions** → chọn workflow **"Tạo bài blog tự động"** → nhấn **Run workflow**.

Tuỳ chọn **force = true** để đăng lại dù URL đã tồn tại.

## 🕐 Lịch tự động

Mỗi ngày lúc **7:00 sáng** (giờ Việt Nam), Actions tự chạy, crawl bài mới, sinh nội dung bằng Groq AI, upload ảnh lên Cloudinary, rồi commit `posts.json` + `sitemap.xml` vào repo. GitHub Pages tự cập nhật sau ~30 giây.

## 🔧 Tùy chỉnh

Mở `scripts/generate.js`, thay đổi:
```js
const SOURCE_URL = "https://wiki.batdongsan.com.vn/tin-tuc"; // Nguồn crawl
const GROQ_MODEL = "llama-3.1-8b-instant";                   // Model AI
```

Mở `.github/workflows/generate.yml`, thay đổi lịch:
```yaml
- cron: '0 0 * * *'    # 7:00 sáng VN (00:00 UTC)
# - cron: '0 */12 * * *' # Mỗi 12 tiếng
```
