const clone = value => JSON.parse(JSON.stringify(value));


const PUBLIC_SCREENS = {
  connect: { title: 'آماده‌ای؟', message: 'برای شروع، انتخابت را با دقت ثبت کن؛ ناشناس مناسب پیدا می‌شود.', buttons: [], feedback: {} },
  preference: { title: 'انتخاب ترجیح', message: 'دوست داری گفت‌وگو با چه کسی شکل بگیرد؟', buttons: [{ id: 'male', label: 'پسر' }, { id: 'female', label: 'دختر' }, { id: 'any', label: 'مهم نیست' }], feedback: {} },
  gender: { title: 'یک قدم کوچک', message: 'جنسیت خودت را انتخاب کن تا جفت‌سازی دوطرفه و منصفانه باشد.', buttons: [{ id: 'male', label: 'پسرم' }, { id: 'female', label: 'دخترم' }], feedback: {} },
  waiting: { title: 'در صف انتظار', message: 'چراغ جست‌وجو روشن است؛ به‌محض پیدا شدن گزینهٔ مناسب خبرت می‌کنیم.', buttons: [{ id: 'cancel', label: 'انصراف' }], feedback: {} },
  chat: { title: 'مکالمه برقرار است', message: 'یک سلام ساده می‌تواند شروع یک داستان خوب باشد.', buttons: [{ id: 'disconnect', label: 'قطع مکالمه' }], feedback: {} },
  confirm_stop: { title: 'پایان مکالمه؟', message: 'اگر گفت‌وگو را ببندی، این فرصت همین‌جا تمام می‌شود.', buttons: [{ id: 'confirm', label: 'اره مطمئنم' }, { id: 'continue', label: 'نه ادامه میدم' }], feedback: {} },
  after_stop: { title: 'حالا چه؟', message: 'می‌توانی دوباره وارد گفت‌وگو شوی یا این ارتباط را ببندی.', buttons: [{ id: 'block', label: 'بلاکش کن' }, { id: 'later', label: 'بعدا وصلش کن' }], feedback: {} },
  block_reason: { title: 'دلیل بلاک', message: 'یک دلیل را انتخاب کن تا گزارش داخلی دقیق‌تر بماند.', buttons: [{ id: 'rude', label: 'باهاش حال نکردم' }, { id: 'abusive', label: 'بی ادب بود' }, { id: 'wrong_gender', label: 'جنسیتش اشتباه بود' }, { id: 'advertising', label: 'تبلیغ فرستاد' }, { id: 'later', label: 'بذار بعدا هم وصل بشم' }], feedback: {} },
  profile: { title: 'پروفایل من', message: 'جزئیاتت را ببین و امضای ایموجی خودت را بساز.', buttons: [{ id: 'emoji', label: 'ظاهر ایموجی پلاس' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  emoji: { title: 'ظاهر ایموجی پلاس', message: 'امضای ایموجی خودت را انتخاب کن؛ این نشانه کنار پیام‌هایت دیده می‌شود.', buttons: [{ id: 'reset', label: 'ریست ایموجی' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  coins: { title: 'مانو کوین', message: 'هر کوین، یک قدم برای باز کردن امکانات بیشتر است.', buttons: [{ id: 'free_coins', label: 'افزایش مانو کوین رایگان' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  plus: { title: 'اکانت پلاس', message: 'یک تجربهٔ آرام‌تر، زیباتر و پرامکانات‌تر.', buttons: [{ id: 'back', label: 'بازگشت' }], feedback: {} },
  anonymous_link: { title: 'لینک ناشناس', message: 'لینک تو آمادهٔ یک گفت‌وگوی امن و ناشناس است.', buttons: [{ id: 'back', label: 'بازگشت' }], feedback: {} },
};
const PRIVATE_SCREENS = {
  reports: { title: 'گزارش‌ها', message: 'هر گزارش یک سیگنال است؛ آن را با دقت بررسی کن.', buttons: [{ id: 'user_reports', label: 'گزارش‌های کاربران' }, { id: 'report_channels', label: 'کانال‌های گزارش' }, { id: 'technical', label: 'بخش فنی' }, { id: 'back', label: 'بازگشت پنل' }], feedback: {} },
  technical: { title: 'بخش فنی مالک', message: 'ابزارهای پشتیبان‌گیری و مشاهدهٔ سلامت ربات.', buttons: [{ id: 'source', label: 'فایل اوپن سورس' }, { id: 'database', label: 'بک آپ دیتابیس' }, { id: 'server', label: 'وضعیت سرور' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  ads: { title: 'مدیریت تبلیغات', message: 'جریان توجه کاربران را با نظم مدیریت کن.', buttons: [{ id: 'join', label: 'جویین اجباری' }, { id: 'broadcast', label: 'پیام همگانی' }, { id: 'welcome', label: 'پیام خوش‌آمد' }, { id: 'connection_ad', label: 'تبلیغ اتصال' }, { id: 'mid_ad', label: 'تبلیغ میان مکالمه' }, { id: 'back', label: 'بازگشت پنل' }], feedback: {} },
  control: { title: 'کنترل ربات', message: 'ظاهر و رفتار سطح کاربر را با حوصله تنظیم کن.', buttons: [{ id: 'public_appearance', label: 'بخش ظاهری پابلیک' }, { id: 'private_appearance', label: 'بخش ظاهری پرایویسی' }, { id: 'templates', label: 'قالب‌های آماده' }, { id: 'toggle', label: 'روشن/خاموش کردن ربات' }, { id: 'back', label: 'بازگشت پنل' }], feedback: {} },
  appearance: { title: 'استودیو ظاهر', message: 'اینجا هر کلمه، فاصله و دکمه یک انتخاب طراحی است.', buttons: [{ id: 'templates', label: 'قالب‌های آماده' }, { id: 'edit', label: 'ویرایش لایه‌ها' }, { id: 'layout', label: 'چیدمان' }, { id: 'reset', label: 'بازگردانی پیش‌فرض' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  user_search: { title: 'کنترل کاربران', message: 'آیدی عددی کاربر را بفرست تا کارت وضعیت او ساخته شود.', buttons: [{ id: 'back', label: 'بازگشت' }], feedback: {} },
};
const DEEP_THEME_COPY = {
  luxury: {
    connect: { title: 'درِ گفت‌وگو باز است', message: 'یک انتخاب کوچک بکن؛ ما بقیهٔ مسیر را آرام و بی‌سروصدا جلو می‌بریم.', buttons: [] },
    preference: { title: 'هم‌صحبت امشب را انتخاب کن', message: 'دوست داری گفت‌وگو با چه کسی شکل بگیرد؟ انتخابت خصوصی می‌ماند.', buttons: [{ id: 'male', label: 'با یک آقا' }, { id: 'female', label: 'با یک خانم' }, { id: 'any', label: 'فرقی ندارد' }] },
    gender: { title: 'یک معرفی کوتاه', message: 'برای یک جفت‌سازی منصفانه، جنسیت خودت را انتخاب کن. همین‌قدر ساده.', buttons: [{ id: 'male', label: 'من آقا هستم' }, { id: 'female', label: 'من خانم هستم' }] },
    waiting: { title: 'چراغ جست‌وجو روشن است', message: 'در صف هستی. پنجره را باز بگذار؛ وقتی هم‌صحبت مناسب پیدا شد، خبرت می‌کنیم.', buttons: [{ id: 'cancel', label: 'توقف جست‌وجو' }] },
    chat: { title: 'اتاق گفت‌وگو آماده است', message: 'یک سلام کوتاه کافی است. اینجا لازم نیست نقش بازی کنی.', buttons: [{ id: 'disconnect', label: 'پایان محترمانه' }] },
    confirm_stop: { title: 'پایان این گفت‌وگو؟', message: 'اگر مطمئنی، گفت‌وگو بسته می‌شود و انتخاب بعدی دست خودت است.', buttons: [{ id: 'confirm', label: 'بله، تمامش کنیم' }, { id: 'continue', label: 'نه، ادامه می‌دهم' }] },
    after_stop: { title: 'حالا انتخاب با توست', message: 'می‌توانی دوباره وارد صف شوی یا این ارتباط را برای همیشه ببندی.', buttons: [{ id: 'block', label: 'این ارتباط را نمی‌خواهم' }, { id: 'later', label: 'شاید بعداً' }] },
    block_reason: { title: 'یک دلیل انتخاب کن', message: 'این انتخاب به ما کمک می‌کند گزارش‌ها را بهتر بفهمیم؛ طرف مقابل دلیل را نمی‌بیند.', buttons: [{ id: 'rude', label: 'رفتارش مناسب نبود' }, { id: 'abusive', label: 'بی‌احترامی کرد' }, { id: 'wrong_gender', label: 'جنسیت درست نبود' }, { id: 'advertising', label: 'تبلیغ می‌فرستاد' }, { id: 'later', label: 'فعلاً منصرف شدم' }] },
    profile: { title: 'کارت شخصی من', message: 'اینجا خلاصه‌ای از تجربهٔ تو نگه‌داری می‌شود؛ کوتاه، روشن و فقط برای خودت.', buttons: [{ id: 'emoji', label: 'امضای ایموجی من' }, { id: 'back', label: 'بازگشت به لابی' }] },
    emoji: { title: 'امضای اختصاصی', message: 'یک نشانهٔ کوچک انتخاب کن تا پیام‌هایت امضای خودت را داشته باشند.', buttons: [{ id: 'reset', label: 'بازگردانی به ✨' }, { id: 'back', label: 'برگشت به کارت من' }] },
    coins: { title: 'کیف مانو کوین', message: 'کوین‌ها برای بازکردن انتخاب‌های بیشترند؛ موجودی تو همین‌جا دیده می‌شود.', buttons: [{ id: 'free_coins', label: 'دریافت کوین رایگان' }, { id: 'back', label: 'بازگشت به لابی' }] },
    plus: { title: 'اتاق Plus', message: 'اگر تجربهٔ خلوت‌تر و امکانات بیشتری می‌خواهی، اینجا نقطهٔ شروع است.', buttons: [{ id: 'back', label: 'بعداً بررسی می‌کنم' }] },
    anonymous_link: { title: 'لینک دعوت ناشناس', message: 'لینک تو آماده است؛ آن را با کسی به اشتراک بگذار که می‌خواهی بدون مقدمه با تو حرف بزند.', buttons: [{ id: 'back', label: 'بازگشت به لابی' }] },
    reports: { title: 'دفتر گزارش‌ها', message: 'هر گزارش یک سرنخ است؛ قبل از تصمیم، جزئیات را آرام بخوان.', buttons: [{ id: 'user_reports', label: 'گزارش‌های کاربران' }, { id: 'report_channels', label: 'کانال‌های گزارش' }, { id: 'technical', label: 'بخش فنی' }, { id: 'back', label: 'بازگشت پنل' }] },
    technical: { title: 'اتاق ابزار مالک', message: 'فایل‌ها و وضعیت سرویس را با انتخاب خودت دریافت کن.', buttons: [{ id: 'source', label: 'دریافت سورس' }, { id: 'database', label: 'دریافت دیتابیس' }, { id: 'server', label: 'خواندن وضعیت سرور' }, { id: 'back', label: 'بازگشت' }] },
    ads: { title: 'میز تبلیغات', message: 'پیام درست را در زمان درست بفرست؛ مزاحم تجربهٔ کاربر نشو.', buttons: [{ id: 'join', label: 'جویین اجباری' }, { id: 'broadcast', label: 'پیام همگانی' }, { id: 'welcome', label: 'پیام خوش‌آمد' }, { id: 'connection_ad', label: 'پیام هنگام اتصال' }, { id: 'mid_ad', label: 'پیام میان مکالمه' }, { id: 'back', label: 'بازگشت پنل' }] },
    control: { title: 'اتاق طراحی ربات', message: 'ظاهر ربات را از اولین سلام تا آخرین دکمه، یک‌دست نگه دار.', buttons: [{ id: 'public_appearance', label: 'ظاهر بخش عمومی' }, { id: 'private_appearance', label: 'ظاهر پنل خصوصی' }, { id: 'templates', label: 'قالب‌های آماده' }, { id: 'toggle', label: 'روشن/خاموش کردن' }, { id: 'back', label: 'بازگشت پنل' }] },
    user_search: { title: 'پروندهٔ کاربر', message: 'آیدی عددی را بفرست تا کارت وضعیت او را ببینیم.', buttons: [{ id: 'back', label: 'بازگشت پنل' }] },
  },
  halloween: {
    connect: { title: 'درِ کلبه باز شد', message: 'یک انتخاب کن؛ شاید امشب پشت این دکمه، یک آشنایی عجیب منتظرت باشد.', buttons: [] },
    preference: { title: 'چه کسی آن‌طرف است؟', message: 'چراغ کدو را روی انتخابت بگذار. این تصمیم فقط برای جفت‌سازی استفاده می‌شود.', buttons: [{ id: 'male', label: 'یک آقا، اگر جرأت داری' }, { id: 'female', label: 'یک خانم، اگر جرأت داری' }, { id: 'any', label: 'هرکس که بیدار است' }] },
    gender: { title: 'شناسنامهٔ سایه‌ها', message: 'برای اینکه جفت‌سازی اشتباه نشود، خودت را معرفی کن.', buttons: [{ id: 'male', label: 'آقا هستم' }, { id: 'female', label: 'خانم هستم' }] },
    waiting: { title: 'در مه منتظریم', message: 'هنوز کسی پیدا نشده؛ نگران نباش، اینجا چراغ جست‌وجو روشن می‌ماند.', buttons: [{ id: 'cancel', label: 'برگشت از مه' }] },
    chat: { title: 'یک سایه پیدا شد', message: 'گفت‌وگو شروع شده. اول سلام کن؛ حتی ارواح هم از سلام خوششان می‌آید.', buttons: [{ id: 'disconnect', label: 'بستن درِ گفت‌وگو' }] },
    confirm_stop: { title: 'در را ببندیم؟', message: 'این گفت‌وگو همین‌جا تمام می‌شود. مطمئنی؟', buttons: [{ id: 'confirm', label: 'بله، در را ببند' }, { id: 'continue', label: 'نه، هنوز اینجام' }] },
    after_stop: { title: 'ردپا باقی بماند؟', message: 'می‌توانی این آشنایی را ببندی یا فقط فعلاً کنار بکشی.', buttons: [{ id: 'block', label: 'این سایه را بلاک کن' }, { id: 'later', label: 'فعلاً بی‌خیال' }] },
    block_reason: { title: 'چه چیزی ترسناک بود؟', message: 'دلیل را انتخاب کن تا گزارش ما دقیق‌تر شود.', buttons: [{ id: 'rude', label: 'رفتارش ترسناک بود' }, { id: 'abusive', label: 'حرف بد زد' }, { id: 'wrong_gender', label: 'جنسیت اشتباه بود' }, { id: 'advertising', label: 'تبلیغ شبح‌وار فرستاد' }, { id: 'later', label: 'نه، منصرف شدم' }] },
    profile: { title: 'دفترچهٔ جادو', message: 'سکه‌ها، نشان‌ها و رازهای کوچک اکانتت اینجاست.', buttons: [{ id: 'emoji', label: 'ساختن امضای جادویی' }, { id: 'back', label: 'برگشت به کلبه' }] },
    emoji: { title: 'امضای جادویی', message: 'یک یا چند ایموجی انتخاب کن تا سایه‌ات امضای مخصوص داشته باشد.', buttons: [{ id: 'reset', label: 'بازگشت به ✨' }, { id: 'back', label: 'برگشت' }] },
    coins: { title: 'کیسهٔ سکه‌ها', message: 'سکه‌هایت را ببین و اگر خوش‌شانس بودی، چندتای رایگان بگیر.', buttons: [{ id: 'free_coins', label: 'احضار سکهٔ رایگان' }, { id: 'back', label: 'برگشت به کلبه' }] },
    plus: { title: 'پلاسِ نیمه‌شب', message: 'راهی برای خلوت‌تر و ویژه‌تر کردن شب‌های گفت‌وگو.', buttons: [{ id: 'back', label: 'بعداً برمی‌گردم' }] },
    anonymous_link: { title: 'لینک احضار', message: 'این لینک را بفرست؛ هرکس بازش کند، مستقیم به تو نزدیک می‌شود.', buttons: [{ id: 'back', label: 'برگشت به کلبه' }] },
    reports: { title: 'اتاق شواهد', message: 'هر گزارش یک تکه از پازل است؛ قبل از قضاوت، همه‌چیز را ببین.', buttons: [{ id: 'user_reports', label: 'شواهد کاربران' }, { id: 'report_channels', label: 'کانال‌های خبر' }, { id: 'technical', label: 'آزمایشگاه فنی' }, { id: 'back', label: 'فرار از اتاق' }] },
    technical: { title: 'آزمایشگاه فنی', message: 'فایل و وضعیت ربات را بدون طلسم اضافی دریافت کن.', buttons: [{ id: 'source', label: 'بازکردن سورس' }, { id: 'database', label: 'برداشتن دیتابیس' }, { id: 'server', label: 'چک‌کردن سلامت' }, { id: 'back', label: 'بازگشت' }] },
    ads: { title: 'اتاق پیام‌ها', message: 'قبل از فرستادن هر پیام، ببین قرار است چه کسی آن را ببیند.', buttons: [{ id: 'join', label: 'جویین اجباری' }, { id: 'broadcast', label: 'پخش همگانی' }, { id: 'welcome', label: 'سلام اول ورود' }, { id: 'connection_ad', label: 'پیام اتصال' }, { id: 'mid_ad', label: 'پیام وسط چت' }, { id: 'back', label: 'خروج از اتاق' }] },
    control: { title: 'اتاق فرمان شبانه', message: 'ظاهر و ریتم ربات را طوری بچین که انگار از اول همین‌جا بوده.', buttons: [{ id: 'public_appearance', label: 'چهرهٔ عمومی' }, { id: 'private_appearance', label: 'چهرهٔ مدیر' }, { id: 'templates', label: 'جادوهای آماده' }, { id: 'toggle', label: 'روشن/خاموش' }, { id: 'back', label: 'بازگشت' }] },
    user_search: { title: 'پروندهٔ سایه', message: 'آیدی عددی را بفرست تا ردپای کاربر را ببینیم.', buttons: [{ id: 'back', label: 'بازگشت' }] },
  },
  friendly: {
    connect: { title: 'بزن بریم', message: 'فقط بگو دنبال چه گفت‌وگویی هستی؛ بقیه‌اش را ربات جمع می‌کند.', buttons: [] },
    preference: { title: 'هم‌صحبتت را انتخاب کن', message: 'چه کسی برای یک گفت‌وگوی خوب مناسب‌تر است؟ انتخابت کاملاً شخصی می‌ماند.', buttons: [{ id: 'male', label: 'یک دوست پسر' }, { id: 'female', label: 'یک دوست دختر' }, { id: 'any', label: 'هرکسی خوبه' }] },
    gender: { title: 'تو خودت را چطور معرفی می‌کنی؟', message: 'فقط برای اینکه آدم مناسب‌تری پیدا کنیم، یکی را انتخاب کن.', buttons: [{ id: 'male', label: 'پسرم' }, { id: 'female', label: 'دخترم' }] },
    waiting: { title: 'داریم می‌گردیم', message: 'هنوز کسی پیدا نشده. چند لحظه صبر کن؛ هر وقت جور شد، خبرت می‌کنیم.', buttons: [{ id: 'cancel', label: 'بی‌خیال، لغو کن' }] },
    chat: { title: 'وصل شدی!', message: 'سلام کن و راحت باش. مکالمهٔ خوب از یک جملهٔ ساده شروع می‌شود.', buttons: [{ id: 'disconnect', label: 'پایان گفت‌وگو' }] },
    confirm_stop: { title: 'مکالمه را ببندیم؟', message: 'اگر الان تمامش کنی، هر وقت خواستی می‌توانی دوباره شروع کنی.', buttons: [{ id: 'confirm', label: 'آره، تمومش کنیم' }, { id: 'continue', label: 'نه، ادامه بدیم' }] },
    after_stop: { title: 'حالا چی؟', message: 'می‌توانی دوباره دوست پیدا کنی یا این ارتباط را کنار بگذاری.', buttons: [{ id: 'block', label: 'دیگه نمی‌خوامش' }, { id: 'later', label: 'بعداً تصمیم می‌گیرم' }] },
    block_reason: { title: 'چی اذیتت کرد؟', message: 'یکی را انتخاب کن؛ این کمک می‌کند تجربهٔ بعدی بهتر شود.', buttons: [{ id: 'rude', label: 'خوب رفتار نکرد' }, { id: 'abusive', label: 'بی‌احترامی کرد' }, { id: 'wrong_gender', label: 'جنسیتش درست نبود' }, { id: 'advertising', label: 'تبلیغ فرستاد' }, { id: 'later', label: 'نه، فعلاً نمی‌خوام بلاک کنم' }] },
    profile: { title: 'پروفایل من', message: 'اطلاعات کوچکت را مرتب و ساده اینجا می‌بینی.', buttons: [{ id: 'emoji', label: 'ساختن امضای ایموجی' }, { id: 'back', label: 'برگشت به خانه' }] },
    emoji: { title: 'امضای ایموجی', message: 'یک ایموجی انتخاب کن تا کنار پیام‌هایت بنشیند.', buttons: [{ id: 'reset', label: 'برگرداندن ایموجی' }, { id: 'back', label: 'برگشت' }] },
    coins: { title: 'مانو کوین‌های من', message: 'موجودی‌ات را ببین و اگر لازم داشتی، کوین رایگان بگیر.', buttons: [{ id: 'free_coins', label: 'گرفتن کوین رایگان' }, { id: 'back', label: 'برگشت به خانه' }] },
    plus: { title: 'امکانات Plus', message: 'اگر دوست داری تجربه‌ات آرام‌تر و کامل‌تر باشد، این بخش را ببین.', buttons: [{ id: 'back', label: 'بعداً می‌بینم' }] },
    anonymous_link: { title: 'لینک ناشناس من', message: 'لینکت را برای یک نفر بفرست تا راحت و مستقیم با تو حرف بزند.', buttons: [{ id: 'back', label: 'برگشت به خانه' }] },
    reports: { title: 'گزارش‌ها', message: 'بیایید گزارش‌ها را ساده و منصفانه بررسی کنیم.', buttons: [{ id: 'user_reports', label: 'گزارش کاربران' }, { id: 'report_channels', label: 'کانال گزارش' }, { id: 'technical', label: 'ابزارهای فنی' }, { id: 'back', label: 'برگشت پنل' }] },
    technical: { title: 'ابزارهای فنی', message: 'هر چیزی که برای نگهداری ربات لازم داری، مرتب همین‌جاست.', buttons: [{ id: 'source', label: 'گرفتن سورس' }, { id: 'database', label: 'گرفتن دیتابیس' }, { id: 'server', label: 'دیدن وضعیت' }, { id: 'back', label: 'برگشت' }] },
    ads: { title: 'مدیریت پیام‌ها', message: 'پیام‌ها را ساده، کوتاه و به‌موقع نگه داریم.', buttons: [{ id: 'join', label: 'جویین اجباری' }, { id: 'broadcast', label: 'پیام همگانی' }, { id: 'welcome', label: 'پیام خوش‌آمد' }, { id: 'connection_ad', label: 'پیام اتصال' }, { id: 'mid_ad', label: 'پیام وسط مکالمه' }, { id: 'back', label: 'برگشت پنل' }] },
    control: { title: 'کنترل ربات', message: 'از ظاهر عمومی تا پنل خودت را یک‌جا و با حوصله تنظیم کن.', buttons: [{ id: 'public_appearance', label: 'ظاهر کاربران' }, { id: 'private_appearance', label: 'ظاهر مدیریت' }, { id: 'templates', label: 'قالب‌های آماده' }, { id: 'toggle', label: 'روشن/خاموش' }, { id: 'back', label: 'برگشت پنل' }] },
    user_search: { title: 'پیدا کردن کاربر', message: 'آیدی عددی را بفرست تا اطلاعات پایه‌اش را ببینی.', buttons: [{ id: 'back', label: 'برگشت پنل' }] },
  },
};
function styleScreens(screens, style) {
  const config = { luxury: { glyph: '✦', open: '╭────── ✦ ──────╮', close: '╰────── ✦ ──────╯' }, halloween: { glyph: '🕯', open: '╭────── 🕸 ──────╮', close: '╰────── 🎃 ──────╯' }, friendly: { glyph: '✧', open: '╭────── 👋 ──────╮', close: '╰────── 😊 ──────╯' } }[style];
  const copy = DEEP_THEME_COPY[style] || {};
  if (!config) return clone(screens);
  return Object.fromEntries(Object.entries(screens).map(([id, screen]) => {
    const override = copy[id] || {}; const next = { ...clone(screen), ...override };
    return [id, { ...next, title: `${config.glyph} ${next.title}`, message: `${config.open}\n${next.message}\n${config.close}`, buttons: (next.buttons || []).map(item => ({ ...item, label: `${config.glyph} ${item.label}` })) }];
  }));
}

const PUBLIC_BASE = {
  title: 'منوی اصلی',
  message: 'به چت ناشناس خوش آمدی.',
  layout: 'rows',
  screens: PUBLIC_SCREENS,
  buttons: [
    [{ id: 'connect', label: 'وصل کن به ناشناس' }, { id: 'anonymous_link', label: 'لینک ناشناس من' }],
    [{ id: 'profile', label: 'پروفایل من' }],
    [{ id: 'coins', label: 'افزایش مانو کوین' }, { id: 'plus', label: 'اکانت پلاس' }],
  ],
  feedback: {
    connect: 'برای اتصال، گزینه‌های جنسیت و ترجیح خودت را انتخاب کن.',
    connect_prompt: 'دوست داری به چه کسی وصل شوی؟',
    waiting: 'در صف انتظار قرار گرفتی؛ هنوز کسی با این انتخاب پیدا نشده است. به‌محض اتصال خبرت می‌دهم.',
    connected: 'اتصال برقرار شد؛ گفت‌وگو را شروع کن.',
    anonymous_link: 'لینک ناشناس خودت را مدیریت کن.',
    profile: 'پروفایل شما',
    coins: 'افزایش مانو کوین',
    plus: 'اکانت پلاس',
    back: 'بازگشت',
  },
};

const PRIVATE_BASE = {
  title: 'پنل مدیریت',
  message: 'مرکز کنترل ربات؛ یک بخش را انتخاب کن.',
  layout: 'rows',
  screens: PRIVATE_SCREENS,
  buttons: [
    [{ id: 'ads', label: 'تبلیغات' }, { id: 'control', label: 'کنترل ربات' }],
    [{ id: 'users', label: 'کنترل کاربران' }, { id: 'status', label: 'وضعیت ربات' }],
    [{ id: 'reports', label: 'گزارش‌ها' }, { id: 'admins', label: 'مدیران' }],
    [{ id: 'exit', label: 'خروج از پنل' }],
  ],
  feedback: {
    ads: 'مدیریت تبلیغات',
    control: 'کنترل ربات',
    users: 'آیدی عددی کاربر را بفرست.',
    status: 'وضعیت ربات',
    reports: 'گزارش‌ها',
    admins: 'مدیران فعلی',
    exit: 'از پنل مدیریت خارج شدی.',
    back: 'بازگشت پنل',
  },
};

export const APPEARANCE_SECTIONS = {
  public: { key: 'appearance_public', title: 'پابلیک', base: PUBLIC_BASE },
  private: { key: 'appearance_private', title: 'پرایویسی', base: PRIVATE_BASE },
};

export const APPEARANCE_TEMPLATES = {
  default: { name: 'پیش‌فرض فعلی', description: 'همان ظاهر فعلی ربات، بدون تغییر در منطق فنی.', public: PUBLIC_BASE, private: PRIVATE_BASE },
  luxury: {
    name: 'لوکس', description: 'لحن رسمی‌تر با قاب‌بندی و ایموجی‌های شیک.',
    public: { ...PUBLIC_BASE, layout: 'columns2', screens: styleScreens(PUBLIC_SCREENS, 'luxury'), title: '✦ چت ناشناس لوکس ✦', message: '╭────── ✦ ──────╮\n  به فضای گفت‌وگوی لوکس خوش آمدی\n╰────── ✦ ──────╯', buttons: [[{ id: 'connect', label: '✦ شروع گفت‌وگوی ناشناس' }, { id: 'anonymous_link', label: '⌁ لینک اختصاصی من' }], [{ id: 'profile', label: '♕ پروفایل من' }], [{ id: 'coins', label: '◈ مانو کوین' }, { id: 'plus', label: '♛ اکانت پلاس' }]] },
    private: { ...PRIVATE_BASE, layout: 'columns2', screens: styleScreens(PRIVATE_SCREENS, 'luxury'), title: '♛ کنسول مدیریت لوکس', message: '╭────── ♛ ──────╮\n  مرکز فرماندهی ربات\n╰────── ♛ ──────╯', buttons: [[{ id: 'ads', label: '◈ تبلیغات' }, { id: 'control', label: '⚙ کنترل ربات' }], [{ id: 'users', label: '♙ کاربران' }, { id: 'status', label: '◉ وضعیت ربات' }], [{ id: 'reports', label: '⚑ گزارش‌ها' }, { id: 'admins', label: '♛ مدیران' }], [{ id: 'exit', label: '↩ خروج از پنل' }]] },
  },
  halloween: {
    name: 'هالووینی', description: 'ظاهر سرگرم‌کنندهٔ نارنجی و مرموز، بدون تغییر زیرساخت.',
    public: { ...PUBLIC_BASE, layout: 'rows', screens: styleScreens(PUBLIC_SCREENS, 'halloween'), title: '🎃 کلبهٔ چت ناشناس 🎃', message: '🕯 شب بخیر! آماده‌ای با یک ناشناس مرموز آشنا شوی؟ 🕸', buttons: [[{ id: 'connect', label: '🦇 احضار یک ناشناس' }, { id: 'anonymous_link', label: '🕸 لینک من' }], [{ id: 'profile', label: '🧛 پروفایل' }], [{ id: 'coins', label: '🪙 مانو کوین' }, { id: 'plus', label: '🔮 اکانت پلاس' }]] },
    private: { ...PRIVATE_BASE, layout: 'rows', screens: styleScreens(PRIVATE_SCREENS, 'halloween'), title: '🎃 اتاق کنترل تاریک', message: '🕯 مدیر محترم، یک عملیات را انتخاب کن.', buttons: [[{ id: 'ads', label: '🕸 تبلیغات' }, { id: 'control', label: '🧪 کنترل ربات' }], [{ id: 'users', label: '🧛 کاربران' }, { id: 'status', label: '👁 وضعیت' }], [{ id: 'reports', label: '⚰ گزارش‌ها' }, { id: 'admins', label: '🧙 مدیران' }], [{ id: 'exit', label: '🚪 خروج' }]] },
  },
  friendly: {
    name: 'فرندلی', description: 'لحن گرم و ساده برای استفادهٔ روزمره.',
    public: { ...PUBLIC_BASE, layout: 'single', screens: styleScreens(PUBLIC_SCREENS, 'friendly'), title: 'سلام رفیق! 👋', message: 'خوش اومدی! از دکمه‌های زیر هر چیزی خواستی انتخاب کن 😊', buttons: [[{ id: 'connect', label: '😊 پیدا کردن یک دوست' }, { id: 'anonymous_link', label: '🔗 لینک من' }], [{ id: 'profile', label: '🙋 پروفایل من' }], [{ id: 'coins', label: '🪙 سکه‌هام' }, { id: 'plus', label: '⭐ امکانات پلاس' }]] },
    private: { ...PRIVATE_BASE, layout: 'single', screens: styleScreens(PRIVATE_SCREENS, 'friendly'), title: '👋 پنل مدیریت دوستانه', message: 'همه‌چیز آماده است؛ یک گزینه را انتخاب کن.', buttons: [[{ id: 'ads', label: '📣 تبلیغات' }, { id: 'control', label: '🛠 کنترل ربات' }], [{ id: 'users', label: '👥 کاربران' }, { id: 'status', label: '📊 وضعیت ربات' }], [{ id: 'reports', label: '📝 گزارش‌ها' }, { id: 'admins', label: '👑 مدیران' }], [{ id: 'exit', label: '👋 خروج' }]] },
  },
};

const DEEP_THEME_FEEDBACK = {
  luxury: { public: { connect: 'انتخابت را انجام بده؛ یک گفت‌وگوی خوب از همین‌جا شروع می‌شود.', connect_prompt: 'چه نوع هم‌صحبتی برای امشب مناسب توست؟', waiting: 'در صف آرام بمان؛ وقتی انتخاب مناسب پیدا شد، خودمان خبر می‌دهیم.', connected: 'اتصال برقرار شد. یک سلام کوتاه، بهترین شروع است.', anonymous_link: 'لینک اختصاصی تو آمادهٔ اشتراک‌گذاری است.', profile: 'کارت شخصی تو', coins: 'کیف مانو کوین', plus: 'اتاق Plus', back: 'بازگشت به لابی' }, private: { ads: 'میز تبلیغات آماده است.', control: 'اتاق طراحی ربات', users: 'پروندهٔ کاربر را باز کن.', status: 'وضعیت لحظه‌ای ربات', reports: 'دفتر گزارش‌ها', admins: 'مدیران فعلی', exit: 'از کنسول خارج شدی.', back: 'بازگشت به پنل اصلی' } },
  halloween: { public: { connect: 'یکی از درها را انتخاب کن؛ هرکدام به یک مسیر می‌رسد.', connect_prompt: 'امشب دنبال کدام هم‌صحبت می‌گردی؟', waiting: 'در مه منتظریم؛ وقتی کسی پیدا شد، چراغت روشن می‌شود.', connected: 'یک سایه پیدا شد. با یک سلام شروع کن.', anonymous_link: 'لینک احضار آماده است.', profile: 'دفترچهٔ جادو', coins: 'کیسهٔ سکه‌ها', plus: 'پلاس نیمه‌شب', back: 'برگشت به کلبه' }, private: { ads: 'اتاق پیام‌ها باز است.', control: 'اتاق فرمان شبانه', users: 'پروندهٔ سایه را پیدا کن.', status: 'نبض ربات', reports: 'اتاق شواهد', admins: 'شورای مدیران', exit: 'از اتاق فرمان خارج شدی.', back: 'بازگشت به اتاق اصلی' } },
  friendly: { public: { connect: 'انتخابت را بزن؛ ما کمک می‌کنیم گفت‌وگوی خوبی شروع شود.', connect_prompt: 'دوست داری با چه کسی حرف بزنی؟', waiting: 'داریم می‌گردیم. اگر جور شد، خودمان صدایت می‌کنیم.', connected: 'وصل شدی! حالا یک سلام ساده بفرست.', anonymous_link: 'لینک ناشناس تو آماده است.', profile: 'پروفایل من', coins: 'مانو کوین‌های من', plus: 'امکانات Plus', back: 'برگشت به خانه' }, private: { ads: 'مدیریت پیام‌ها', control: 'کنترل ربات', users: 'پیدا کردن کاربر', status: 'وضعیت ربات', reports: 'گزارش‌ها', admins: 'مدیران فعلی', exit: 'از پنل خارج شدی.', back: 'برگشت به پنل' } },
};
function themeFeedback(templateId, section) { return clone(DEEP_THEME_FEEDBACK[templateId]?.[section] || {}); }

function merge(base, value) {
  if (Array.isArray(base)) return Array.isArray(value) ? value : clone(base);
  if (base && typeof base === 'object') {
    const out = {};
    for (const key of Object.keys(base)) out[key] = merge(base[key], value?.[key]);
    for (const [key, item] of Object.entries(value || {})) if (!(key in out)) out[key] = item;
    return out;
  }
  return value === undefined ? base : value;
}

export function normalizeAppearance(section, value) {
  const definition = APPEARANCE_SECTIONS[section] || APPEARANCE_SECTIONS.public;
  try { return merge(definition.base, typeof value === 'string' ? JSON.parse(value) : (value || {})); } catch { return clone(definition.base); }
}
export function templateAppearance(templateId, section) { const template = APPEARANCE_TEMPLATES[templateId] || APPEARANCE_TEMPLATES.default; const appearance = normalizeAppearance(section, template[section]); if (templateId !== 'default') appearance.feedback = { ...appearance.feedback, ...themeFeedback(templateId, section) }; return appearance; }
export function appearanceKeyboard(appearance) {
  const rows = Array.isArray(appearance?.buttons) ? appearance.buttons : [];
  const labels = rows.flat().filter(button => button?.enabled !== false).map(button => String(button.label || button.id || '').slice(0, 64)).filter(Boolean);
  if (appearance?.layout === 'single') return labels.map(label => [label]);
  if (appearance?.layout === 'columns2') { const result = []; for (let i = 0; i < labels.length; i += 2) result.push(labels.slice(i, i + 2)); return result; }
  return rows.map(row => row.map(button => String(button.label || button.id || '').slice(0, 64)).filter(Boolean)).filter(row => row.length);
}
export function appearanceScreen(appearance, id) { return appearance?.screens?.[id] || {}; }
export function screenText(appearance, id, fallback) { return String(appearanceScreen(appearance, id).message || fallback); }
export function screenKeyboard(appearance, id, fallbackRows = []) { const screen = appearanceScreen(appearance, id); return (screen.buttons?.length ? [screen.buttons.filter(item => item?.enabled !== false).map(item => item.label || item.id)] : fallbackRows); }
export function appearanceButton(appearance, id, fallback) { for (const row of appearance?.buttons || []) for (const item of row || []) if (item.id === id) return item.label || fallback; return fallback; }
export function appearanceFeedback(appearance, id, fallback) { return String(appearance?.feedback?.[id] || fallback); }
export function appearanceItems(section, appearance) {
  const items = [{ path: 'title', label: 'عنوان منو', value: appearance.title }, { path: 'message', label: 'متن منو', value: appearance.message }, { path: 'layout', label: 'نوع چیدمان', value: appearance.layout }];
  for (const [screenId, screen] of Object.entries(appearance.screens || {})) {
    items.push({ path: `screens.${screenId}.title`, label: `عنوان صفحه ${screenId}`, value: screen.title });
    items.push({ path: `screens.${screenId}.message`, label: `متن صفحه ${screenId}`, value: screen.message });
    for (const [index, item] of (screen.buttons || []).entries()) items.push({ path: `screens.${screenId}.buttons.${index}.label`, label: `دکمه ${screenId} ${item.id}`, value: item.label });
    for (const [key, value] of Object.entries(screen.feedback || {})) items.push({ path: `screens.${screenId}.feedback.${key}`, label: `پاسخ داخلی ${screenId} ${key}`, value });
  }
  for (const [rowIndex, row] of (appearance.buttons || []).entries()) for (const [colIndex, button] of (row || []).entries()) items.push({ path: `buttons.${rowIndex}.${colIndex}.label`, label: `نام دکمه ${button.id}`, value: button.label });
  for (const [id, value] of Object.entries(appearance.feedback || {})) items.push({ path: `feedback.${id}`, label: `پاسخ ${id}`, value });
  return items;
}
export function setAppearancePath(appearance, path, value) { const out = clone(appearance); const parts = path.split('.'); let current = out; for (let i = 0; i < parts.length - 1; i += 1) current = current[parts[i]]; current[parts.at(-1)] = value; return out; }
export function templateListText() { return Object.entries(APPEARANCE_TEMPLATES).map(([id, item], index) => `${index + 1}. ${item.name} — ${item.description} (${id})`).join('\n'); }
export function templateIdFromText(value) { const text = String(value || '').trim().toLowerCase(); const entries = Object.entries(APPEARANCE_TEMPLATES); const numeric = Number(text); if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) return entries[numeric - 1][0]; return entries.find(([id, item]) => id === text || item.name === value.trim())?.[0] || null; }
