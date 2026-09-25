# استقلال از Manus و راهنمای انتقال/بازیابی

## پاسخ کوتاه

این ربات در زمان اجرا **به Manus یا Atria وابسته نیست**. وبهوک مستقیماً از Telegram به سرور می‌رسد، منطق ربات در همین مخزن عمومی است و وضعیت در PostgreSQL ذخیره می‌شود. حذف حساب Manus به‌تنهایی ربات را خاموش نمی‌کند.

اما ربات همچنان به حساب‌ها و سرویس‌های واقعی زیر وابسته است؛ اگر یکی از آن‌ها حذف، غیرفعال یا بدون اعتبار لازم شود، باید ربات را به جایگزین منتقل کرد:

- **Telegram:** توکن ربات و API تلگرام.
- **میزبان:** در حال حاضر پروژهٔ Vercel شما.
- **دیتابیس:** پروژهٔ Neon شما، شاخهٔ `production`.
- **مخزن سورس:** مخزن عمومی GitHub شما.

کد به این شرکت‌ها قفل نشده است: هر میزبانی سازگار با Node.js و هر PostgreSQL قابل استفاده است. برای مستقل ماندن از Manus، حساب‌های Vercel، Neon، GitHub و Telegram را با ایمیل و روش بازیابی‌ای که خودتان کنترل می‌کنید نگه دارید. اطلاعات ورود و مقادیر secret را در مدیر رمزعبور یا secret manager خودتان ذخیره کنید، نه در چت یا مخزن عمومی.

## وضعیت فعلی

- سورس: [Nashenasm/anonymous-telegram-chat-bot](https://github.com/Nashenasm/anonymous-telegram-chat-bot)، مجوز MIT.
- میزبان production: پروژهٔ `anonymous-telegram-chat-bot` در Vercel.
- دیتابیس production: پروژهٔ Neon `super-voice-25786810`، دیتابیس `neondb`، شاخهٔ `production`.
- نسخهٔ Node پروژهٔ Vercel در زمان بررسی: Node 24؛ برنامه با Node.js 20 یا جدیدتر کار می‌کند.
- کلیدهای لازم در تنظیمات Vercel نگهداری می‌شوند؛ مقدار آن‌ها داخل GitHub قرار نمی‌گیرد.
- مهاجرت جدول‌های پیام ناشناس روی Neon production اجرا و بررسی شده است.
- **هشدار پشتیبان:** در بررسی ۲۵ سپتامبر ۲۰۲۶، history/PITR شاخهٔ production برابر ۲۱٬۶۰۰ ثانیه (۶ ساعت) و schedule مربوط به snapshot خالی بود. PITR برای خطای کوتاه‌مدت مفید است اما جای یک نسخهٔ جداگانه در storage تحت کنترل شما را نمی‌گیرد؛ برای دوره‌های طولانی‌تر، بسته به طرح Neon history window قابل تنظیم است و نگهداری بیشتر ممکن است storage را افزایش دهد. پس ماندگاری داده را بدون backup مستقل و آزمون restore تضمین‌شده فرض نکنید. برای جزئیات جاری [مستند backup Neon](https://neon.com/docs/postgres/backup-restore/backups.md) و [history window](https://neon.com/docs/postgres/backup-restore/history-window.md) را ببینید.

## اگر فقط Manus حذف شود

اگر Vercel، Neon، GitHub و Telegram همچنان فعال باشند، کاری لازم نیست. Manus مسیر وبهوک، پردازش پیام، secrets پروژهٔ Vercel یا دیتابیس Neon را اجرا نمی‌کند و مالک آن سرویس‌ها نیست. حساب Manus را می‌توان حذف کرد و ربات روی زیرساخت‌های بیرونی ادامه می‌دهد.

## انتقال فقط میزبان، با همان دیتابیس

این روش downtime را کم می‌کند و معمولاً ساده‌ترین انتقال است:

1. از مخزن GitHub روی میزبان جدید deploy بگیرید؛ Node.js 20+، `npm ci`، `npm run build` و `npm test` را اجرا کنید.
2. متغیرهای محیطی را در secret manager مقصد وارد کنید: `TELEGRAM_BOT_TOKEN`، `TELEGRAM_WEBHOOK_SECRET`، `DATABASE_URL` و `ADMIN_TELEGRAM_IDS`. برای PostgreSQL بیرونی معمولاً `DATABASE_SSL=true` لازم است. `DB_POOL_MAX` اختیاری است.
3. `DATABASE_URL` را به همان دیتابیس فعلی Neon تنظیم کنید. برای انتقال میزبان، روی دیتابیس schema یا data جدید نسازید.
4. HTTPS و مسیر `POST /api/webhook` را فعال کنید. اگر از اجرای مستقل Node استفاده می‌کنید، `npm start` سرور را روی `0.0.0.0:$PORT` اجرا می‌کند؛ مسیر سلامت آن `GET /health` است.
5. ابتدا از میزبان جدید health check بگیرید. سپس Telegram webhook را به URL جدید منتقل کنید. Telegram برای هر bot یک webhook فعال دارد؛ بعد از تغییر URL، updateها به میزبان جدید می‌روند.
6. پس از تأیید دریافت updateها و کارکرد ربات، میزبان قبلی را متوقف کنید. secrets را فقط پس از اطمینان از انتقال موفق از آن حذف کنید.

برای انتقال webhook، URL را جایگزین کنید و **`drop_pending_updates` را نفرستید** تا updateهای منتظر عمداً دور ریخته نشوند:

```bash
curl --fail-with-body -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://YOUR_NEW_HOST.example/api/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

## انتقال دیتابیس هم‌زمان با میزبان

1. یک دیتابیس PostgreSQL خالی روی مقصد بسازید و دسترسی TLS/SSL را آماده کنید.
2. هنگام کپی، نوشتن هم‌زمان دو نسخهٔ ربات روی دو دیتابیس متفاوت می‌تواند پیام و وضعیت را دوپاره کند. یک پنجرهٔ کوتاه نگهداری در نظر بگیرید: ابتدا وبهوک را موقتاً متوقف یا به مقصدی که همان دیتابیس را می‌خواند هدایت کنید؛ قبل از شروع، پیام‌های در انتظار کاربران را در نظر بگیرید.
3. در محیط امنی که `pg_dump`، `pg_restore` و OpenSSL نصب است، dump را با رمزنگاری سمت کلاینت بسازید. رمز عبور را در password manager نگه دارید؛ فایل dump و عبارت رمز را در GitHub یا چت ارسال نکنید:

```bash
umask 077
set -o pipefail
pg_dump --dbname="$OLD_DATABASE_URL" --format=custom --no-owner --no-privileges \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -out anonymous-bot.dump.enc

# مقصد باید دیتابیس خالی باشد؛ dump شامل schema و داده‌ها است.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in anonymous-bot.dump.enc \
  | pg_restore --dbname="$NEW_DATABASE_URL" --no-owner --no-privileges -
```

4. پس از restore، مقصد را با همان `npm run build`، `npm test` و اتصال برنامه به PostgreSQL بررسی کنید. `DATABASE_URL` میزبان را به دیتابیس جدید تغییر دهید.
5. پس از سالم بودن مقصد، webhook تلگرام را به میزبان جدید منتقل کنید. صف‌ها، وضعیت کاربران، تنظیمات، بلاک‌ها، مجوزهای لینک و پیام‌های معلق باید در dump باشند.
6. بعد از تأیید کارکرد، dump و نسخهٔ قدیمی را فقط طبق سیاست نگهداری و حذف امن خود پاک کنید. دیتابیس قدیمی را زودتر حذف نکنید.

برای دیتابیس تازه و خالی که restore نمی‌شود، schema نصب تازه این است:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
```

**روی دیتابیس حاوی داده، این دستور نصب تازه را اجرا نکنید.** برای ارتقای دیتابیس قدیمی طبق release، فایل migration مربوطه را بخوانید و قبل از اجرا backup بگیرید.

## backup و بازیابی

1. برنامهٔ backup منظم PostgreSQL را در سطح Neon یا سرویس backup مستقل خودتان تنظیم کنید. در بررسی فعلی schedule خودکار Neon خالی و PITR شش‌ساعته بود؛ آن را در کنسول خودتان بازبینی کنید و پیش از افزایش retention، هزینه/نگهداری plan را بررسی کنید. Neon علاوه بر `pg_dump` دستی، [راهنمای بکاپ زمان‌بندی‌شدهٔ pg_dump به S3 با GitHub Actions](https://neon.com/docs/postgres/backup-restore/backups.md) دارد.
2. علاوه بر snapshot داخل همان provider، یک dump دوره‌ای رمزنگاری‌شده را در فضای ذخیره‌سازی جداگانه‌ای که خودتان کنترل می‌کنید نگه دارید. backup روی همان حسابی که ممکن است بسته شود، به‌تنهایی برنامهٔ بازیابی نیست.
3. به‌صورت دوره‌ای restore آزمایشی را روی یک دیتابیس جدا اجرا کنید و سلامت جدول‌ها و اجرای تست‌ها را بررسی کنید. backup تا زمانی که restore آن را امتحان نکرده‌اید، بازیابی تأییدشده نیست.
4. توکن Telegram و `TELEGRAM_WEBHOOK_SECRET` را در مدیر رمزعبور نگه دارید. اگر توکن bot تعویض شد، آن را در میزبانی جدید به‌روزرسانی کنید و webhook را دوباره ثبت کنید.

## نکتهٔ Vercel در مخزن فعلی

پروژهٔ Vercel موجود از preset بدون framework استفاده می‌کند و build آن پوشهٔ `public` را انتظار دارد. فایل `public/.gitkeep` عمدی است؛ در انتقال همین تنظیم پروژه را حفظ کنید یا output directory را در پنل Vercel/تنظیمات مقصد درست تنظیم کنید. APIهای ربات در `api/webhook.js` و `api/admin.js` هستند و محتوای `public` منطق ربات نیست.
