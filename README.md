# Anonymous Telegram Chat

ربات چت ناشناس دوطرفه برای Telegram با جفت‌سازی تصادفی، ترجیح جنسیتی، صف انتظار، قطع مکالمه، بلاک، پروفایل، مانو کوین و پنل مدیریتی ساده. این پروژه در زمان اجرا به Manus یا Atria وابسته نیست و روی Vercel، هر Node.js host، VPS یا کانتینر اجرا می‌شود.

## قابلیت‌های اصلی

- چت ناشناس تصادفی با دکمه‌های معمولی داخل ربات، ترجیح جنسیتی دوطرفه، صف انتظار، قطع مکالمه، بلاک و گزارش.
- لینک ناشناس ثابت برای هر کاربر با رضایت‌گیری قبل از نمایش پیام و دکمه‌های inline فقط در همان جریان پیام ناشناس.
- پروفایل با مانو کوین، تاریخ عضویت با ساعت ۲۴ساعته، آیدی عددی، جنسیت و باقی‌ماندهٔ مانو پلاس.
- کاربر جدید در اولین ورود ۲۰ مانو کوین می‌گیرد؛ ورود از لینک اختصاصی ۵ مانو کوین برای صاحب لینک و ورود از لینک ناشناس ۳ مانو کوین برای صاحب لینک ثبت می‌کند.
- اکانت پلاس با قیمت‌های ثابت: ۱ ماهه ۱۰۰، ۳ ماهه ۲۵۰، ۶ ماهه ۴۵۰ و ۱۲ ماهه ۸۰۰ مانو کوین. تأیید خرید با دکمه‌های inline انجام می‌شود.
- کاربر پلاس یک نشان قابل تغییر دارد؛ مدیران همیشه پلاس نامحدود هستند و نشان پیش‌فرض مدیر سه ✨ است. کاربران معمولی نشان ندارند.

## اجرای مستقل

Node.js 20 یا جدیدتر و PostgreSQL لازم است:

```bash
cp .env.example .env
npm ci
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
npm run build
npm test
npm start
```

برای پایگاه‌دادهٔ موجود، ابتدا backup بگیرید و سپس `db/schema-v4.sql` را اجرا کنید. این migration ستون‌های پلاس، نشان، نقش، کد دعوت و جدول خرید پلاس را اضافه می‌کند. روی دیتابیس حاوی داده، `schema.sql` را دوباره به‌عنوان نصب تازه اجرا نکنید.

متغیرهای ضروری عبارت‌اند از `TELEGRAM_BOT_TOKEN`، `TELEGRAM_WEBHOOK_SECRET`، `DATABASE_URL` و `ADMIN_TELEGRAM_IDS`. `BOT_USERNAME` اختیاری است؛ اگر تنظیم نشود، نام کاربری ربات از Telegram `getMe` خوانده می‌شود. توکن‌ها را commit نکنید.

## تست و build

```bash
npm run build
npm test
```

تست‌های فعلی شامل قرارداد دکمه‌ها، مسیر لینک ناشناس، idempotency، سازگاری ترجیحات، schema پلاس/دعوت و محدودیت ۱۵ ثانیه‌ای قطع مکالمه است.

## Vercel و webhook

برای Vercel، فایل `api/webhook.js` به‌عنوان Function استفاده می‌شود. پس از استقرار، متغیرهای محیطی را در پروژهٔ Vercel قرار دهید و webhook را ثبت کنید:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_HOST.example/api/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d "drop_pending_updates=true"
```

مسیر سلامت اجرای مستقل `GET /health` و مسیر webhook `POST /api/webhook` است.

## استقلال و انتقال

سورس، migrationها، تست‌ها و راهنمای انتقال در همین مخزن هستند. اجرای production هیچ درخواست runtime به Manus یا Atria نمی‌فرستد؛ Atria فقط می‌تواند در مرحلهٔ توسعه و review استفاده شود. برای انتقال، repository را روی میزبان جدید deploy کنید، متغیرهای محیطی را در secret manager مقصد قرار دهید، PostgreSQL را با dump/restore منتقل کنید و webhook Telegram را به URL جدید تغییر دهید. جزئیات در [راهنمای استقلال و بازیابی](docs/independence-and-recovery.md) آمده است.

## مجوز

MIT
