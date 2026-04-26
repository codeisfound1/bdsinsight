// scripts/generate.js
// Chạy bởi GitHub Actions: crawl bài mới → Groq AI → lưu docs/posts.json
// UPGRADED: scrapes og:image thumbnail + SEO slug fields + Cloudinary upload

"use strict";

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SOURCE_URL  = "https://wiki.batdongsan.com.vn/tin-tuc";
const GROQ_URL    = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL  = "llama-3.1-8b-instant";
const POSTS_FILE   = path.join(__dirname, "../docs/posts.json");
const SITEMAP_FILE = path.join(__dirname, "../docs/sitemap.xml");
const ROBOTS_FILE  = path.join(__dirname, "../docs/robots.txt");
const SITE_URL     = process.env.SITE_URL || "https://codeisfound1.github.io/bdsinsight";
const GROQ_KEY    = process.env.GROQ_API_KEY;
const FORCE       = process.env.FORCE === "true";

// Cloudinary config (set in GitHub Secrets)
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!GROQ_KEY) {
  console.error("❌ Thiếu GROQ_API_KEY");
  process.exit(1);
}

// ─── HTTP HELPERS ──────────────────────────────────────────────────────────

function fetchUrl(url, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
        "Accept-Charset": "UTF-8",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout: " + url)); });
  });
}

// Fetch binary (ảnh) trả về Buffer
function fetchBuffer(url, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchBuffer(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error("HTTP " + res.statusCode + " khi tải ảnh: " + url));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] || "image/jpeg" }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout tải ảnh: " + url)); });
  });
}

function postJson(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   "POST",
      headers:  Object.assign({
        "Content-Type":   "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body, "utf8"),
      }, headers || {}),
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error("JSON parse failed: " + text.slice(0, 300))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("Groq timeout")); });
    req.write(body, "utf8");
    req.end();
  });
}

// ─── CLOUDINARY UPLOAD ─────────────────────────────────────────────────────

const crypto = require("crypto");

/**
 * Upload ảnh lên Cloudinary kèm SEO metadata:
 * - public_id: slug của bài viết (URL-friendly, indexable)
 * - folder: bdsinsight/posts
 * - context: alt text + caption để Google Image Search đọc được
 * - tags: từ khoá bài viết
 * - transformation: tự động resize + WebP + lazy-load friendly
 *
 * Trả về object { url, secureUrl, width, height, format, publicId }
 * hoặc null nếu không có Cloudinary config / lỗi
 */
async function uploadToCloudinary(imageUrl, slug, altText, tags) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.log("⚠️ Cloudinary chưa cấu hình, dùng URL gốc");
    return null;
  }

  try {
    console.log("☁️ Đang upload ảnh lên Cloudinary:", imageUrl);

    const timestamp  = Math.floor(Date.now() / 1000).toString();
    const publicId   = "bdsinsight/posts/" + slug;
    const tagsStr    = (tags || []).slice(0, 5).join(",") || "batdongsan";

    // Context cho SEO: Google đọc alt + caption từ đây
    const contextStr = "alt=" + altText.replace(/[|=]/g, " ") +
                       "|caption=" + altText.replace(/[|=]/g, " ");

    // Params phải sort theo alphabet để tạo signature đúng
    const signParams = [
      "context=" + contextStr,
      "folder=bdsinsight/posts",
      "overwrite=true",
      "public_id=" + slug,
      "tags=" + tagsStr,
      "timestamp=" + timestamp,
      "upload_preset=",
    ].filter(p => !p.endsWith("=")).join("&");

    const signature = crypto
      .createHash("sha1")
      .update(signParams + CLOUDINARY_API_SECRET)
      .digest("hex");

    // Dùng upload-by-URL (fetch) để không phải tải ảnh về máy
    const formData = [
      ["file",      imageUrl],
      ["public_id", slug],
      ["folder",    "bdsinsight/posts"],
      ["overwrite", "true"],
      ["tags",      tagsStr],
      ["context",   contextStr],
      ["timestamp", timestamp],
      ["api_key",   CLOUDINARY_API_KEY],
      ["signature", signature],
    ];

    const boundary = "----BDSInsight" + Date.now();
    const bodyParts = formData.map(([k, v]) =>
      "--" + boundary + "\r\n" +
      "Content-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" +
      v + "\r\n"
    );
    const bodyStr = bodyParts.join("") + "--" + boundary + "--\r\n";
    const bodyBuf = Buffer.from(bodyStr, "utf8");

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.cloudinary.com",
        path:     "/v1_1/" + CLOUDINARY_CLOUD_NAME + "/image/upload",
        method:   "POST",
        headers:  {
          "Content-Type":   "multipart/form-data; boundary=" + boundary,
          "Content-Length": bodyBuf.length,
        },
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (e) { reject(new Error("Cloudinary JSON parse lỗi")); }
        });
      });
      req.on("error", reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error("Cloudinary timeout")); });
      req.write(bodyBuf);
      req.end();
    });

    if (result.error) {
      console.warn("⚠️ Cloudinary lỗi:", result.error.message);
      return null;
    }

    // Tạo URL đã transform: WebP, resize 1200x630 (OG standard), auto quality
    const transformedUrl = result.secure_url.replace(
      "/upload/",
      "/upload/f_auto,q_auto,w_1200,h_630,c_fill,g_auto/"
    );

    console.log("✅ Cloudinary upload thành công:", result.public_id);
    console.log("   URL gốc  :", result.secure_url);
    console.log("   URL SEO  :", transformedUrl);

    return {
      url:       transformedUrl,          // URL đã tối ưu (WebP, resize)
      rawUrl:    result.secure_url,       // URL gốc trên Cloudinary
      publicId:  result.public_id,
      width:     result.width,
      height:    result.height,
      format:    result.format,
      alt:       altText,                 // Alt text cho <img alt="">
    };

  } catch (err) {
    console.warn("⚠️ Upload Cloudinary thất bại:", err.message, "→ dùng URL gốc");
    return null;
  }
}

// ─── POSTS STORAGE ─────────────────────────────────────────────────────────

function loadPosts() {
  try {
    if (fs.existsSync(POSTS_FILE)) {
      return JSON.parse(fs.readFileSync(POSTS_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("Không đọc được posts.json, tạo mới:", e.message);
  }
  return { posts: [], publishedUrls: [] };
}

function savePosts(data) {
  fs.mkdirSync(path.dirname(POSTS_FILE), { recursive: true });
  fs.writeFileSync(POSTS_FILE, JSON.stringify(data, null, 2), "utf8");
  console.log("\u2705 Da luu " + data.posts.length + " bai vao docs/posts.json");
  saveSitemap(data.posts);
  saveRobots();
}

function saveSitemap(posts) {
  const base = SITE_URL.replace(/\/$/, "");
  const today = new Date().toISOString().slice(0, 10);

  const pages = [
    { loc: base + "/", priority: "1.0", changefreq: "daily", lastmod: today },
  ].concat(posts.map((p) => ({
    loc:        base + "/#" + (p.slug || p.id),
    priority:   "0.8",
    changefreq: "monthly",
    lastmod:    p.publishedAt ? p.publishedAt.slice(0, 10) : today,
  })));

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...pages.map((u, i) => {
      const post = posts[i - 1]; // homepage is index 0
      const imgTag = post && post.image && post.image.url
        ? "\n    <image:image>\n" +
          "      <image:loc>" + post.image.url + "</image:loc>\n" +
          "      <image:title>" + (post.title || "").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])) + "</image:title>\n" +
          "      <image:caption>" + (post.image.alt || post.title || "").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])) + "</image:caption>\n" +
          "    </image:image>"
        : "";
      return "  <url>\n" +
        "    <loc>"        + u.loc        + "</loc>\n" +
        "    <lastmod>"    + u.lastmod    + "</lastmod>\n" +
        "    <changefreq>" + u.changefreq + "</changefreq>\n" +
        "    <priority>"   + u.priority   + "</priority>" +
        imgTag + "\n" +
        "  </url>";
    }),
    "</urlset>",
  ].join("\n");

  fs.writeFileSync(SITEMAP_FILE, xml, "utf8");
  console.log("\ud83d\uddfa\ufe0f  Sitemap: " + pages.length + " URLs -> docs/sitemap.xml");
}

function saveRobots() {
  const base = SITE_URL.replace(/\/$/, "");
  const content =
    "User-agent: *\n" +
    "Allow: /\n\n" +
    "Sitemap: " + base + "/sitemap.xml\n";
  fs.writeFileSync(ROBOTS_FILE, content, "utf8");
  console.log("\ud83e\udd16 robots.txt updated");
}

// ─── CRAWL ─────────────────────────────────────────────────────────────────

async function crawlArticleList() {
  console.log("🔍 Đang crawl danh sách:", SOURCE_URL);
  const html = await fetchUrl(SOURCE_URL);
  const links = new Set();
  let m;

  const abs = /href="(https?:\/\/wiki\.batdongsan\.com\.vn\/tin-tuc\/[^"?#]{5,})"/g;
  while ((m = abs.exec(html)) !== null) links.add(m[1]);

  const rel = /href="(\/tin-tuc\/[^"?#]{5,})"/g;
  while ((m = rel.exec(html)) !== null)
    links.add("https://wiki.batdongsan.com.vn" + m[1]);

  const result = Array.from(links)
    .filter((u) => u !== SOURCE_URL && !u.endsWith("/tin-tuc"))
    .slice(0, 10);

  console.log("📋 Tìm thấy " + result.length + " bài viết");
  return result;
}

// ─── Extract thumbnail/og:image from HTML ──────────────────────────────────
function extractImage(html, baseUrl) {
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m && m[1] && m[1].startsWith("http")) return m[1];

  m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (m && m[1] && m[1].startsWith("http")) return m[1];

  const bodyMatch = html.match(/<(?:article|main|div[^>]+class=["'][^"']*(?:content|body|post)[^"']*["'])[^>]*>([\s\S]{0,8000})/i);
  const searchArea = bodyMatch ? bodyMatch[1] : html;
  const imgRe = /<img[^>]+src=["']([^"']{10,})["'][^>]*/gi;
  while ((m = imgRe.exec(searchArea)) !== null) {
    let src = m[0];
    const wAttr = src.match(/width=["'](\d+)["']/i);
    const hAttr = src.match(/height=["'](\d+)["']/i);
    if (wAttr && parseInt(wAttr[1]) < 200) continue;
    if (hAttr && parseInt(hAttr[1]) < 150) continue;
    const imgSrc = m[1];
    if (imgSrc.startsWith("data:")) continue;
    if (imgSrc.startsWith("http")) return imgSrc;
    if (imgSrc.startsWith("/")) {
      try { return new URL(imgSrc, baseUrl).href; } catch(_) {}
    }
  }

  return null;
}

async function crawlArticleContent(url) {
  console.log("📄 Đang đọc:", url);
  const html = await fetchUrl(url);

  let title = "";
  const h1 = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i);
  if (h1) title = decodeHtmlEntities(h1[1].trim());
  if (!title) {
    const t = html.match(/<title>([^<]+)<\/title>/i);
    if (t) title = decodeHtmlEntities(t[1].replace(/\s*[-|].*$/, "").trim());
  }

  let description = "";
  const dm = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  if (dm) description = decodeHtmlEntities(dm[1]);

  const imageUrl = extractImage(html, url);
  if (imageUrl) console.log("🖼️ Ảnh thumbnail:", imageUrl);
  else          console.log("⚠️ Không tìm thấy ảnh, dùng fallback");

  const content = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3500);

  return {
    url,
    title: title || "Bài viết bất động sản",
    description,
    imageUrl, // raw URL, chưa upload Cloudinary
    content: decodeHtmlEntities(content),
  };
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// ─── GROQ AI ───────────────────────────────────────────────────────────────

async function generateWithGroq(article) {
  console.log("🤖 Đang tạo bài với Groq:", article.title);

  const systemPrompt =
    "Bạn là chuyên gia phân tích bất động sản Việt Nam. " +
    "Nhiệm vụ: nhận thông tin bài viết gốc và TRẢ VỀ DUY NHẤT một JSON object hợp lệ, " +
    "mã hóa UTF-8. Không có text nào khác, không markdown, không code block, không giải thích.";

  const userPrompt =
    "Dựa trên bài viết sau, hãy viết một bài blog chuyên sâu bằng tiếng Việt có dấu đầy đủ, " +
    "sau đó trả về JSON.\n\n" +
    "NGUỒN:\n" +
    "Tiêu đề: " + article.title + "\n" +
    "Mô tả: " + article.description + "\n" +
    "Nội dung: " + article.content + "\n\n" +
    "YÊU CẦU:\n" +
    "- Toàn bộ nội dung phải bằng tiếng Việt có dấu đầy đủ\n" +
    "- Viết lại hoàn toàn, không sao chép nguyên văn\n" +
    "- Phân tích chuyên sâu, thêm góc nhìn thực tiễn\n" +
    "- Độ dài 500-700 từ\n\n" +
    "CHỈ trả về JSON object dưới đây, KHÔNG có gì khác:\n" +
    '{"title":"Tiêu đề bài blog tiếng Việt","summary":"Tóm tắt 1-2 câu tiếng Việt",' +
    '"tags":["bất động sản","chung cư","đầu tư"],' +
    '"content":"<p>Đoạn mở đầu...</p><h2>Tiêu đề phần 1</h2><p>Nội dung...</p>' +
    '<h2>Tiêu đề phần 2</h2><p>Nội dung...</p><h2>Kết luận</h2><p>Lời khuyên...</p>",' +
    '"readTime":5}';

  const res = await postJson(
    GROQ_URL,
    {
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      temperature: 0.4,
      max_tokens:  2048,
    },
    { "Authorization": "Bearer " + GROQ_KEY }
  );

  if (res.error) throw new Error("Groq error: " + JSON.stringify(res.error));

  const raw = ((res.choices || [])[0] || {}).message || {};
  const text = (raw.content || "").trim();
  console.log("📥 Groq raw (300c):", text.slice(0, 300));

  return parseJson(text, article);
}

function parseJson(text, article) {
  try { const p = JSON.parse(text); if (p && p.title) return p; } catch (_) {}

  const s = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { const p = JSON.parse(s); if (p && p.title) return p; } catch (_) {}

  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc)          { esc = false; continue; }
      if (ch === "\\")  { esc = true;  continue; }
      if (ch === '"')   { inStr = !inStr; continue; }
      if (inStr)        continue;
      if (ch === "{")   depth++;
      else if (ch === "}") { if (--depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try { const p = JSON.parse(text.slice(start, end + 1)); if (p && p.title) return p; } catch (_) {}
    }
  }

  console.warn("⚠️ Dùng regex fallback để parse JSON");
  const field = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "i"));
    return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : null;
  };
  const arr = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s*:\\s*\\[([^\\]]+)\\]', "i"));
    return m ? (m[1].match(/"([^"]+)"/g) || []).map((x) => x.replace(/"/g, "")) : [];
  };
  const num = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)', "i"));
    return m ? parseInt(m[1]) : 5;
  };

  const title = field("title") || article.title;
  if (!title) throw new Error("Không parse được Groq response:\n" + text.slice(0, 400));

  return {
    title,
    summary:  field("summary")  || article.description || "",
    content:  field("content")  || "<p>" + (article.content || "").slice(0, 500) + "</p>",
    tags:     arr("tags").length ? arr("tags") : ["bất động sản"],
    readTime: num("readTime"),
  };
}

// ─── SLUGIFY ───────────────────────────────────────────────────────────────

function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(50));
  console.log("🚀 BDS Blog Generator bắt đầu -", new Date().toISOString());
  console.log("=".repeat(50));

  const data = loadPosts();
  console.log("📚 Hiện có:", data.posts.length, "bài, đã dùng:", data.publishedUrls.length, "URL");

  const urls = await crawlArticleList();
  const newUrls = FORCE
    ? urls
    : urls.filter((u) => !data.publishedUrls.includes(u));

  if (newUrls.length === 0) {
    console.log("ℹ️ Không có bài mới. Kết thúc.");
    return;
  }

  console.log("✨ Xử lý bài chưa đăng:", newUrls[0]);
  const article = await crawlArticleContent(newUrls[0]);

  if (!article.content || article.content.length < 80) {
    console.warn("⚠️ Nội dung quá ngắn, bỏ qua:", article.url);
    data.publishedUrls.push(article.url);
    savePosts(data);
    return;
  }

  const generated = await generateWithGroq(article);

  const slug = slugify(generated.title || article.title);
  const tags  = generated.tags || ["bất động sản"];

  // Upload ảnh lên Cloudinary với SEO metadata
  // altText = tiêu đề bài viết (mô tả ngắn gọn cho Google Image)
  let imageObj = null;
  if (article.imageUrl) {
    const altText = (generated.title || article.title).slice(0, 120);
    const cloudResult = await uploadToCloudinary(article.imageUrl, slug, altText, tags);
    if (cloudResult) {
      imageObj = cloudResult;
    } else {
      // Fallback: dùng URL gốc nếu Cloudinary chưa cấu hình / lỗi
      imageObj = {
        url:    article.imageUrl,
        rawUrl: article.imageUrl,
        alt:    (generated.title || article.title).slice(0, 120),
      };
    }
  }

  const post = {
    id:          Date.now().toString(),
    title:       generated.title   || article.title,
    summary:     generated.summary || "",
    content:     generated.content || "",
    tags,
    readTime:    generated.readTime || 5,
    // image là object thay vì string thuần:
    // { url, rawUrl, publicId?, width?, height?, format?, alt }
    // Frontend dùng: post.image.url cho <img src>, post.image.alt cho <img alt>
    image:       imageObj,
    sourceUrl:   "/tin-tuc/" + article.url.split("/tin-tuc/")[1],  // path only, no domain
    sourceTitle: article.title,
    publishedAt: new Date().toISOString(),
    slug,
  };

  data.posts.unshift(post);
  data.publishedUrls.push(article.url);
  savePosts(data);

  console.log("🎉 Đã đăng:", post.title);
  if (post.image) {
    console.log("🖼️ Thumbnail URL :", post.image.url);
    console.log("   Alt text      :", post.image.alt);
    if (post.image.publicId) console.log("   Cloudinary ID :", post.image.publicId);
  }
  console.log("=".repeat(50));
}

main().catch((err) => {
  console.error("❌ Lỗi nghiêm trọng:", err.message);
  process.exit(1);
});
