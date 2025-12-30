// server.js — PDF Satış Sistemi (Express) + Admin Panel + Sipariş/Onay/İndirme
// -------------------------------------------------------------------------
// ✅ /api/products                (müşteri ürün+satıcı)
// ✅ /api/order                   (sipariş oluştur — dekont opsiyonel)
// ✅ /api/order/:orderCode        (sipariş sorgu)
// ✅ /api/downloads?token=...     (token ile indirilebilir liste)
// ✅ /download/:productId?token=  (dosya indir)
//
// ✅ /admin                       (Basic Auth ile admin.html)
// ✅ /api/admin/products          (ürün ekle / listele / sil)
// ✅ /api/admin/orders            (sipariş listele)
// ✅ /api/admin/approve           (sipariş onayla + token süresi + mail opsiyonel)
// ✅ /api/admin/receipt/:orderCode (dekont görüntüle)
//
// NOTLAR:
// 1) package.json "type":"module" olduğu için import kullanır.
// 2) Mail (opsiyonel): npm i nodemailer
//    ENV:
//      MAIL_USER="xxx@gmail.com"
//      MAIL_PASS="16-haneli-app-sifre"
//      PUBLIC_BASE_URL="https://siteadresin.com"   (opsiyonel)
// 3) Admin Basic Auth ENV:
//      ADMIN_USER="admin"
//      ADMIN_PASS="1234"

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import cors from "cors";
import multer from "multer";

const app = express();
const PORT = process.env.PORT || 3001;

// -----------------------------
// Paths
// -----------------------------
const PUBLIC_DIR = path.join(__dirname, "public");

// ✅ Kalıcı disk kökü (Render'da /var/data kullanacağız)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : __dirname;

const FILES_DIR = path.join(DATA_DIR, "files");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const RECEIPTS_DIR = path.join(DATA_DIR, "receipts");
const DB_PATH = path.join(DATA_DIR, "db.json");


// -----------------------------
// Ensure folders
// -----------------------------
for (const p of [PUBLIC_DIR, FILES_DIR, UPLOADS_DIR, RECEIPTS_DIR]) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// -----------------------------
// Config (Seller + Admin Auth)
// -----------------------------
const SELLER = {
  iban: process.env.SELLER_IBAN || "TR00 0000 0000 0000 0000 0000 00",
  accountName: process.env.SELLER_NAME || "Beyin Takımı Yayınları",
};

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "1234";

// -----------------------------
// Basic middlewares
// -----------------------------
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Static files
app.use(express.static(PUBLIC_DIR));
app.use("/files", express.static(FILES_DIR)); // ürün pdfleri
app.use("/uploads", express.static(UPLOADS_DIR)); // opsiyonel
app.use("/receipts", express.static(RECEIPTS_DIR)); // opsiyonel (admin receipt endpoint üzerinden güvenli)

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { products: [], orders: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2), "utf-8");
    return init;
  }
  return safeJsonParse(fs.readFileSync(DB_PATH, "utf-8"), { products: [], orders: [] });
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function nowISO() {
  return new Date().toISOString();
}

function genCode(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex").toUpperCase();
}

function genToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Auth required");
  }
  const b64 = auth.replace("Basic ", "");
  const [u, p] = Buffer.from(b64, "base64").toString("utf-8").split(":");
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  return res.status(401).send("Invalid credentials");
}

function publicBaseUrl(req) {
  // PUBLIC_BASE_URL varsa onu kullan, yoksa request host üzerinden üret
  const env = process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// -----------------------------
// Multer setups
// -----------------------------
function fileFilter(allowedMimes) {
  return (req, file, cb) => {
    if (!allowedMimes || allowedMimes.length === 0) return cb(null, true);
    if (allowedMimes.includes(file.mimetype)) return cb(null, true);
    return cb(new Error("Dosya tipi desteklenmiyor"), false);
  };
}

// Ürün PDF upload
const productUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, FILES_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".pdf";
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: fileFilter(["application/pdf"]),
});

// Dekont upload (image/pdf)
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RECEIPTS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || "";
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: fileFilter([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
});

// -----------------------------
// Admin Page
// -----------------------------
app.get("/admin", requireAdmin, (req, res) => {
  // public içindeki styles.css ve assets kullanıyor; admin.html root'ta
  const adminPath = path.join(__dirname, "admin.html");
  if (!fs.existsSync(adminPath)) return res.status(404).send("admin.html yok");
  res.sendFile(adminPath);
});

// -----------------------------
// Public API
// -----------------------------
app.get("/api/products", (req, res) => {
  const db = readDB();
  res.json({
    seller: SELLER,
    products: (db.products || []).map((p) => ({
      id: p.id,
      title: p.title,
      priceTRY: p.priceTRY,
    })),
  });
});

// ✅ Sipariş oluştur (dekont opsiyonel)
// Front-end index.html: name="dekont"
// Bazı eski sürümlerde name="receipt" olabiliyor.
// Bu yüzden ikisini de kabul ediyoruz.
app.post(
  "/api/order",
  receiptUpload.fields([
    { name: "dekont", maxCount: 1 },
    { name: "receipt", maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const fullName = String(req.body?.fullName || "").trim();
      const email = String(req.body?.email || "").trim();
      const phone = String(req.body?.phone || "").trim();
      const transferRef = String(req.body?.transferRef || "").trim();

      let items = req.body?.items;
      if (typeof items === "string") items = safeJsonParse(items, null);

      if (!fullName || !email || !phone) {
        return res.status(400).json({ error: "Eksik bilgi (Ad Soyad / E-posta / Telefon)." });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Sepet boş. En az 1 ürün seçmelisin." });
      }

      const db = readDB();
      const selected = items
        .map((id) => (db.products || []).find((p) => p.id === id))
        .filter(Boolean);

      if (selected.length !== items.length) {
        return res.status(400).json({ error: "Geçersiz ürün seçimi var." });
      }

      const totalTRY = selected.reduce((sum, p) => sum + Number(p.priceTRY || 0), 0);
      const orderCode = genCode(4);
      const downloadToken = genToken(24);

      const file =
        (req.files?.dekont && req.files.dekont[0]) ||
        (req.files?.receipt && req.files.receipt[0]) ||
        null;

      const order = {
        orderId: crypto.randomUUID(),
        orderCode,
        fullName,
        email,
        phone,
        transferRef,
        items: selected.map((p) => ({ id: p.id, title: p.title, priceTRY: p.priceTRY })),
        totalTRY,
        status: "pending",
        downloadToken,
        tokenExpiresAt: null,
        createdAt: nowISO(),
        approvedAt: null,
        receiptPath: file ? file.path : null,
        receiptOriginalName: file ? file.originalname : null,
      };

      db.orders = db.orders || [];
      db.orders.push(order);
      writeDB(db);

      res.json({
        ok: true,
        orderCode,
        totalTRY,
        iban: SELLER.iban,
        accountName: SELLER.accountName,
      });
    } catch (err) {
      res.status(500).json({ error: "Sunucu hatası: " + (err?.message || "Hata") });
    }
  }
);

app.get("/api/order/:orderCode", (req, res) => {
  const code = String(req.params.orderCode || "").trim().toUpperCase();
  const db = readDB();
  const o = (db.orders || []).find((x) => x.orderCode === code);
  if (!o) return res.status(404).json({ error: "Sipariş bulunamadı." });

  res.json({
    orderCode: o.orderCode,
    status: o.status,
    totalTRY: o.totalTRY,
    items: o.items || [],
    createdAt: o.createdAt,
    approvedAt: o.approvedAt,
    downloadToken: o.status === "approved" ? o.downloadToken : null,
  });
});

app.get("/api/downloads", (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).json({ error: "Token boş." });

  const db = readDB();
  const o = (db.orders || []).find((x) => x.downloadToken === token);
  if (!o) return res.status(404).json({ error: "Token bulunamadı." });

  if (o.status !== "approved") return res.status(403).json({ error: "Sipariş onaylı değil." });

  if (o.tokenExpiresAt) {
    const exp = new Date(o.tokenExpiresAt).getTime();
    if (Number.isFinite(exp) && Date.now() > exp) {
      return res.status(403).json({ error: "İndirme linki süresi dolmuş." });
    }
  }

  res.json({
    items: o.items || [],
    tokenExpiresAt: o.tokenExpiresAt,
  });
});

app.get("/download/:productId", (req, res) => {
  const token = String(req.query.token || "").trim();
  const productId = String(req.params.productId || "").trim();

  if (!token) return res.status(400).send("Token gerekli");
  if (!productId) return res.status(400).send("Ürün gerekli");

  const db = readDB();
  const o = (db.orders || []).find((x) => x.downloadToken === token);
  if (!o) return res.status(404).send("Token bulunamadı");

  if (o.status !== "approved") return res.status(403).send("Sipariş onaylı değil");

  if (o.tokenExpiresAt) {
    const exp = new Date(o.tokenExpiresAt).getTime();
    if (Number.isFinite(exp) && Date.now() > exp) {
      return res.status(403).send("Link süresi dolmuş");
    }
  }

  const hasItem = (o.items || []).some((it) => it.id === productId);
  if (!hasItem) return res.status(403).send("Bu ürün bu siparişte yok");

  const p = (db.products || []).find((x) => x.id === productId);
  if (!p) return res.status(404).send("Ürün bulunamadı");

  const filePath = p.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Dosya bulunamadı");

  const filename = (p.title || "dosya").replace(/[\\/:*?"<>|]+/g, "_") + ".pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.sendFile(path.resolve(filePath));
});

// -----------------------------
// Admin API
// -----------------------------
app.post("/api/admin/products", requireAdmin, productUpload.single("pdf"), (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const priceTRY = Number(req.body?.priceTRY || 0);

    if (!title) return res.status(400).json({ error: "Başlık boş olamaz." });
    if (!Number.isFinite(priceTRY) || priceTRY <= 0) {
      return res.status(400).json({ error: "Fiyat geçersiz." });
    }
    if (!req.file?.path) return res.status(400).json({ error: "PDF yüklenmedi." });

    const db = readDB();
    const product = {
      id: crypto.randomUUID(),
      title,
      priceTRY,
      filePath: req.file.path,
      createdAt: nowISO(),
    };

    db.products = db.products || [];
    db.products.push(product);
    writeDB(db);

    res.json({ ok: true, product: { id: product.id, title: product.title, priceTRY: product.priceTRY } });
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası: " + (err?.message || "Hata") });
  }
});

app.get("/api/admin/products", requireAdmin, (req, res) => {
  const db = readDB();
  res.json((db.products || []).map((p) => ({ id: p.id, title: p.title, priceTRY: p.priceTRY, createdAt: p.createdAt })));
});

app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "").trim();
  const db = readDB();

  const idx = (db.products || []).findIndex((p) => p.id === id);
  if (idx < 0) return res.status(404).json({ error: "Ürün bulunamadı." });

  const p = db.products[idx];

  // Dosyayı silmeyi dene (yoksa sorun çıkarma)
  try {
    if (p.filePath && fs.existsSync(p.filePath)) fs.unlinkSync(p.filePath);
  } catch {}

  db.products.splice(idx, 1);
  writeDB(db);

  res.json({ ok: true });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const db = readDB();
  res.json(
    (db.orders || []).map((o) => ({
      orderCode: o.orderCode,
      status: o.status,
      totalTRY: o.totalTRY,
      items: o.items || [],
      createdAt: o.createdAt,
      approvedAt: o.approvedAt,
      receiptPath: o.receiptPath || null,
      fullName: o.fullName,
      email: o.email,
      phone: o.phone,
      transferRef: o.transferRef || "",
    }))
  );
});

// Onayla + token süresi + mail opsiyonel
app.post("/api/admin/approve", requireAdmin, async (req, res) => {
  try {
    const orderCode = String(req.body?.orderCode || "").trim().toUpperCase();
    if (!orderCode) return res.status(400).json({ error: "orderCode boş." });

    const db = readDB();
    const o = (db.orders || []).find((x) => x.orderCode === orderCode);
    if (!o) return res.status(404).json({ error: "Sipariş bulunamadı." });

    o.status = "approved";
    o.approvedAt = nowISO();

    // token süresi: 7 gün
    const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
    o.tokenExpiresAt = new Date(exp).toISOString();

    writeDB(db);

    // Mail (opsiyonel)
    let mailInfo = null;
    const MAIL_USER = process.env.MAIL_USER;
    const MAIL_PASS = process.env.MAIL_PASS;

    if (MAIL_USER && MAIL_PASS) {
      try {
        const nodemailer = (await import("nodemailer")).default;
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: MAIL_USER, pass: MAIL_PASS },
        });

        const base = publicBaseUrl(req);
        const orderLink = `${base}/order.html`;
        const text =
          `Merhaba ${o.fullName},\n\n` +
          `Siparişiniz onaylandı.\n` +
          `Sipariş Kodu: ${o.orderCode}\n` +
          `Toplam: ${o.totalTRY} TL\n\n` +
          `İndirme için: ${orderLink}\n` +
          `Sipariş kodunu girerek dosyalarınızı indirebilirsiniz.\n\n` +
          `Link geçerlilik: ${o.tokenExpiresAt}\n`;

        const info = await transporter.sendMail({
          from: `Beyin Takımı Yayınları <${MAIL_USER}>`,
          to: o.email,
          subject: `Siparişiniz Onaylandı • ${o.orderCode}`,
          text,
        });

        mailInfo = { ok: true, messageId: info?.messageId || null };
      } catch (e) {
        mailInfo = { ok: false, error: e?.message || "mail hata" };
      }
    }

    res.json({
      ok: true,
      orderCode: o.orderCode,
      tokenExpiresAt: o.tokenExpiresAt,
      mail: mailInfo,
    });
  } catch (err) {
    res.status(500).json({ error: "Sunucu hatası: " + (err?.message || "Hata") });
  }
});

// Dekont görüntüle (admin)
app.get("/api/admin/receipt/:orderCode", requireAdmin, (req, res) => {
  const code = String(req.params.orderCode || "").trim().toUpperCase();
  const db = readDB();
  const o = (db.orders || []).find((x) => x.orderCode === code);
  if (!o) return res.status(404).send("Sipariş bulunamadı");
  if (!o.receiptPath || !fs.existsSync(o.receiptPath)) return res.status(404).send("Dekont yok");

  return res.sendFile(path.resolve(o.receiptPath));
});

// -----------------------------
// Error handler (multer vb.)
// -----------------------------
app.use((err, req, res, next) => {
  if (!err) return next();
  return res.status(400).json({ error: err.message || "Hata oluştu" });
});

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`✅ Admin: http://localhost:${PORT}/admin (Basic Auth)`);
});
