import crypto from 'node:crypto';
import { Chess } from 'chess.js';

export const DUEL_GAMES = {
  ludo: { title: 'منچ', emoji: '🎲', shortName: 'ludo', aliases: [] },
  chess: { title: 'شطرنج', emoji: '♟️', shortName: 'chest_game', aliases: ['chest_play', 'chess_play'] },
  cards: { title: 'پاسور', emoji: '🂡', shortName: 'card', aliases: ['cards'] },
  truth: { title: 'حقیقت یا جرئت', emoji: '🎭', shortName: 'Truth_or_dare', aliases: ['truth_or_dare'] },
};

const MAX_CHAT_LENGTH = 300;
const ROOM_TTL_MINUTES = 120;
const LUDO_FINISH = 57;
const LUDO_SAFE_TRACK = [0, 8, 13, 21, 26, 34, 39, 47];
const TRUTH_BANKS = {
  truth: {
    pg: ['امروز بابت چه چیزی واقعاً خوشحالی؟', 'چه مهارتی را دوست داری یاد بگیری؟', 'بهترین خاطره‌ات از یک دوست چیست؟', 'اگر یک روز آزاد کامل داشتی چه می‌کردی؟', 'کدام ویژگی خودت را بیشتر دوست داری؟', 'آخرین چیزی که باعث خنده‌ات شد چه بود؟', 'دوست داری مردم تو را با چه ویژگی‌ای به یاد بیاورند؟', 'چه غذایی را هیچ‌وقت خسته نمی‌شوی بخوری؟', 'اگر می‌توانستی به گذشته یک توصیه بدهی چه می‌گفتی؟', 'یک هدف کوچک این ماهت چیست؟'],
    pg13: ['آخرین باری که از گفتن حقیقت خجالت کشیدی کی بود؟', 'عجیب‌ترین عادتت چیست؟', 'تا حالا برای رسیدن به چیزی نظرت را کاملاً عوض کرده‌ای؟', 'کدام تصمیم کوچک زندگی‌ات نتیجه بزرگی داشت؟', 'اگر قرار بود یک نفر را برای سفر انتخاب کنی چه کسی بود؟', 'بامزه‌ترین سوتی‌ای که داده‌ای چه بوده؟', 'چه چیزی سریع حالت را بهتر می‌کند؟', 'کدام فیلم یا سریال را مخفیانه چند بار دیده‌ای؟', 'اگر یک هفته جای شخص دیگری بودی چه کسی را انتخاب می‌کردی؟', 'بزرگ‌ترین ریسکی که تا امروز کرده‌ای چه بوده؟'],
    adult: ['با رضایت همه، صمیمی‌ترین ویژگی شخصیتی جذابت چیست؟', 'چه چیزی باعث می‌شود در یک رابطه احساس امنیت و اعتماد کنی؟', 'یک قرار ایده‌آل و صمیمی برای تو چه شکلی است؟', 'کدام تعریف محترمانه بیشتر از همه روی تو اثر می‌گذارد؟', 'یک مرز مهم که دوست داری دیگران همیشه رعایت کنند چیست؟', 'چه نوع توجهی بیشتر از همه تو را تحت‌تأثیر قرار می‌دهد؟', 'چه چیزی باعث می‌شود یک گفت‌وگوی صمیمی برایت لذت‌بخش باشد؟', 'یک ویژگی غیرظاهری که برایت جذاب است چیست؟', 'تا حالا به کسی علاقه داشته‌ای اما آن را پنهان کرده‌ای؟ چرا؟', 'چه چیزی برایت نشانهٔ یک شیمی واقعی بین دو نفر است؟', 'کدام رفتار رمانتیک می‌تواند خیلی سریع تو را هیجان‌زده و خوشحال کند؟', 'اگر بخواهی یک راز کوچک دربارهٔ سلیقهٔ عاطفی‌ات بگویی، چیست؟', 'چه نوع پیامی از یک فرد مورد علاقه‌ات می‌تواند لبخند روی لبت بیاورد؟', 'بزرگ‌ترین چراغ قرمزی که در یک رابطه نادیده گرفته‌ای چه بوده؟', 'چه چیزی باعث می‌شود به یک نفر بیشتر اعتماد کنی؟', 'اگر قرار باشد یک قرار شبانهٔ ایده‌آل طراحی کنی، چه سه چیز در آن می‌گذاری؟', 'کدام ویژگی در صدای یک نفر برایت جذاب است؟', 'چه نوع تعریف صمیمی اما محترمانه‌ای دوست داری بشنوی؟', 'تا حالا برای جلب توجه کسی کاری کرده‌ای که بعداً خنده‌ات بگیرد؟', 'چه چیزی برایت جذاب‌تر است: شوخ‌طبعی، اعتمادبه‌نفس یا مهربانی؟ چرا؟', 'اگر می‌توانستی یک سوال صمیمی از طرف مقابل بپرسی، چه می‌پرسیدی؟', 'کدام خاطرهٔ رمانتیک هنوز تو را خوشحال می‌کند؟', 'چه چیزی می‌تواند یک لحظهٔ معمولی را برایت به یک لحظهٔ خاص تبدیل کند؟', 'در یک رابطه، ترجیح می‌دهی احساسات را مستقیم بگویی یا با رفتار نشان بدهی؟', 'کدام نوع نگاه یا زبان بدن برایت جذاب‌تر است؟', 'اگر طرف مقابلت بخواهد تو را غافلگیر کند، چه سورپرایزی را دوست داری؟', 'چه چیزی باعث می‌شود یک نفر از نظر عاطفی برایت دست‌نیافتنی یا جذاب‌تر به نظر برسد؟', 'تا حالا شده از ترس جواب منفی، احساس واقعی‌ات را نگویی؟', 'کدام ویژگی باعث می‌شود یک آشنایی ساده به علاقه تبدیل شود؟', 'در صمیمیت، چه چیزی برایت مهم‌تر است: هیجان، آرامش یا اعتماد؟', 'اگر بخواهی یک قانون طلایی برای رابطه سالم تعریف کنی، چیست؟', 'چه نوع دعوتی برای یک قرار، تو را بیشتر جذب می‌کند؟', 'کدام خاطره یا آهنگ برایت حس رمانتیک خاصی دارد؟', 'آیا تا حالا به کسی فرصت دوباره داده‌ای و نتیجه‌اش چه شد؟', 'جسورانه‌ترین کاری که برای ابراز علاقه انجام داده‌ای چه بوده؟', 'چه چیزی باعث می‌شود کنار یک نفر خود واقعی‌ات باشی؟']
  },
  dare: {
    pg: ['با سه کلمه یک شعار خنده‌دار برای خودت بساز.', 'یک جمله را مثل گوینده اخبار اجرا کن.', 'برای طرف مقابل یک تعریف واقعی و محترمانه بنویس.', '۲۰ ثانیه بدون خندیدن به یک نقطه نگاه کن.', 'یک اسم مستعار خلاقانه برای خودت انتخاب کن.', 'یک داستان کوتاه سه‌جمله‌ای بساز.', 'با سه ایموجی حال امروزت را توضیح بده.', 'یک آهنگ را فقط با هوم‌هوم اجرا کن.', 'برای دور بعد یک قانون بامزه پیشنهاد بده.', 'یک پیام انگیزشی کوتاه برای طرف مقابل بفرست.'],
    pg13: ['یک خاطره خنده‌دار را با لحن نمایشی تعریف کن.', '۳۰ ثانیه با یک لحن غیرعادی صحبت کن.', 'یک تبلیغ خلاقانه برای اولین وسیله نزدیکت بساز.', 'بدون استفاده از کلمه «من» سه جمله درباره خودت بگو.', 'یک حرکت رقص کوتاه و بی‌خطر اجرا کن.', 'یک لقب دوستانه برای طرف مقابل بساز و دلیلش را بگو.', 'یک جمله سخت را سه بار سریع و درست بگو.', 'داستانی را که طرف مقابل انتخاب می‌کند در ۲۰ ثانیه تعریف کن.', 'یک دیالوگ فیلم را با لحن کاملاً متفاوت اجرا کن.', 'برای نوبت بعد یک چالش محترمانه و قابل انجام طراحی کن.'],
    adult: ['با رضایت طرف مقابل یک تعریف رمانتیک و محترمانه از او بگو.', 'یک پیام کوتاه و صمیمی اما محترمانه برای طرف مقابل بنویس.', 'با رضایت همه، یک ژست رمانتیک کوتاه و بامزه اجرا کن.', 'یک قرار صمیمی و کم‌هزینه برای طرف مقابل طراحی کن.', 'سه کلمه بگو که برایت حال‌وهوای رمانتیک دارند.', 'با رضایت طرف مقابل، یک جملهٔ عاشقانه را نمایشی اجرا کن.', 'یک مرز مهم در صمیمیت را با احترام توضیح بده.', 'یک چالش رمانتیک غیرجنسی و قابل‌ردکردن برای دور بعد پیشنهاد کن.']
  }
};

const EXTRA_TRUTH_BANKS = {"truth":{"pg":["اگر می‌توانستی یک عادت خوب را از امروز شروع کنی، چه بود؟","کدام فصل سال را بیشتر دوست داری و چرا؟","آخرین چیزی که یاد گرفتی چه بود؟","چه کاری را همیشه به فردا موکول می‌کنی؟","اگر یک مهارت هنری داشتی، کدام را انتخاب می‌کردی؟","کدام خوراکی یادآور دوران کودکی توست؟","بهترین هدیه‌ای که گرفته‌ای چه بوده؟","کدام صدای ساده برایت آرامش‌بخش است؟","اگر یک روز در شهر دیگری بیدار شوی، کجا را انتخاب می‌کنی؟","چه چیزی سریع تو را سرحال می‌کند؟","دوست داری در چه کاری منظم‌تر باشی؟","کدام بازی یا سرگرمی را هیچ‌وقت خسته‌کننده نمی‌دانی؟","اگر بتوانی یک وسیله جدید اختراع کنی، چه می‌سازى؟","کدام ویژگی را در دوست خوب بیشتر می‌پسندی؟","چه کاری را بهتر از چیزی که دیگران فکر می‌کنند انجام می‌دهی؟","اگر یک ماه مرخصی داشته باشی، روزهایت را چطور می‌گذرانی؟","چه چیزی باعث می‌شود به یک نفر اعتماد کنی؟","کدام تصمیم کوچک نتیجه بزرگی برایت داشت؟","اگر بتوانی یک زبان جدید یاد بگیری، کدام را انتخاب می‌کنی؟","چه چیزی را دوست داری دیگران درباره‌ات درست بدانند؟","آخرین بار چه زمانی از خودت راضی بودی؟","کدام مکان معمولی برایت خاطره‌انگیز است؟","چه کاری را دوست داری با دوستانت بیشتر انجام دهی؟","اگر یک قانون اجتماعی را تغییر دهی، چه تغییری می‌دهی؟","کدام بوی آشنا تو را به یاد خاطره‌ای می‌اندازد؟","چه چیزی برایت نشانه یک روز خوب است؟","در چه موضوعی دوست داری بیشتر مطالعه کنی؟","کدام ویژگی خودت را در سال‌های اخیر بهتر کرده‌ای؟","اگر بتوانی یک پیام به خودِ کودکت بدهی، چه می‌گویی؟","چه چیزی را ساده‌تر از بقیه یاد می‌گیری؟","کدام تجربه باعث شد دیدگاهت عوض شود؟","اگر قرار باشد یک سنت خانوادگی بسازی، چه خواهد بود؟","چه چیزی برایت از پول ارزشمندتر است؟","دوست داری امسال چه خاطره‌ای بسازی؟"],"pg13":["آخرین باری که از تصمیم خودت مطمئن نبودی چه زمانی بود؟","کدام عادتت گاهی خودت را هم کلافه می‌کند؟","تا حالا شده برای حفظ آرامش از حق خودت بگذری؟","کدام تعریف را هنوز یادت مانده است؟","چه چیزی را سخت می‌بخشی؟","اگر کسی بخواهد تو را بهتر بشناسد از چه موضوعی شروع کند؟","کدام ترس کوچک را دوست داری کنار بگذاری؟","تا حالا از یک فرصت خوب به‌خاطر دودلی گذشته‌ای؟","چه زمانی ترجیح می‌دهی سکوت کنی؟","کدام اشتباه به تو درس مهمی داد؟","اگر مجبور شوی یک ماه بدون شبکه‌های اجتماعی باشی، سخت‌ترین بخشش چیست؟","چه چیزی باعث می‌شود نظر دیگران روی تو اثر بگذارد؟","کدام ویژگی را در خودت دیرتر از بقیه شناختی؟","تا حالا شده برای خوشحال‌کردن کسی برنامه خودت را عوض کنی؟","در یک بحث، بیشتر دنبال حق هستی یا آرامش؟","کدام قول را به خودت داده‌ای و هنوز انجام نداده‌ای؟","چه چیزی را درباره آینده بیشتر کنجکاوی؟","اگر یک خاطره را دوباره تجربه کنی، کدام را انتخاب می‌کنی؟","کدام رفتار تو ممکن است اشتباه برداشت شود؟","تا حالا شده از کسی عذرخواهی کنی بدون اینکه مقصر کامل باشی؟","چه چیزی باعث می‌شود گفت‌وگو را ناگهان تمام کنی؟","در دوستی، فاصله گرفتن را سخت‌تر می‌دانی یا خداحافظی را؟","کدام تصمیم را اگر دوباره بگیری، متفاوت عمل می‌کنی؟","چه چیزی را فقط با آدم‌های خیلی نزدیکت در میان می‌گذاری؟","اگر حقیقتی شنیدن برایت سخت باشد، ترجیح می‌دهی مستقیم گفته شود یا آرام‌آرام؟","تا حالا شده ظاهر آرامت احساس واقعی‌ات را پنهان کند؟","چه چیزی باعث می‌شود دوباره به یک نفر فرصت بدهی؟","کدام ویژگی در آدم‌ها زود توجهت را جلب می‌کند؟","اگر بتوانی یک روز از زندگی‌ات را متوقف کنی، کدام روز است؟","چه نوع رقابتی تو را بیشتر هیجان‌زده می‌کند؟","کدام حرف را دوست داشتی زودتر به تو گفته بودند؟","چه چیزی برایت خط قرمز دوستی است؟","تا حالا برای رسیدن به هدفی مسیرت را کاملاً عوض کرده‌ای؟","اگر قرار باشد یک راز بی‌خطر درباره سلیقه‌ات بگویی، چیست؟","چه چیزی تو را بیشتر از شکست می‌ترساند؟"],"adult":["چه نوع توجه محترمانه‌ای بیشتر از همه خوشحالت می‌کند؟","در یک رابطه سالم، اعتماد را چطور نشان می‌دهی؟","چه چیزی باعث می‌شود کنار یک نفر احساس امنیت کنی؟","کدام رفتار رمانتیک ساده برایت جذاب است؟","یک قرار ایده‌آل اما کم‌هزینه برایت چه شکلی است؟","چه مرزی را دوست داری دیگران همیشه رعایت کنند؟","چه نوع گفت‌وگویی را صمیمی و لذت‌بخش می‌دانی؟","کدام ویژگی عاطفی در طرف مقابل برایت مهم‌تر است؟","اگر بخواهی یک تعریف غیرظاهری از خودت بشنوی، چه باشد؟","چه چیزی باعث می‌شود احساساتت را راحت‌تر بیان کنی؟","برای حل سوءتفاهم در رابطه چه روشی را ترجیح می‌دهی؟","کدام نشانه به تو می‌گوید یک رابطه سالم است؟","چه نوع همراهی در روز سخت برایت ارزشمندتر است؟","با رضایت دوطرف، چه سورپرایز ساده‌ای را دوست داری؟","کدام نوع شوخی را در رابطه دوست داری؟","چه چیزی باعث می‌شود یک گفت‌وگو حالت صمیمی پیدا کند؟","در ابراز علاقه، حرف را ترجیح می‌دهی یا عمل را؟","چه چیزی می‌تواند جذابیت یک نفر را برایت بیشتر کند؟","چه مرزی را باید قبل از صمیمی‌تر شدن روشن کرد؟","چه نوع قرار شبانه‌ای را آرام و دوست‌داشتنی می‌دانی؟","اگر طرف مقابل ناراحت باشد، چطور حمایتش می‌کنی؟","کدام ویژگی باعث می‌شود یک نفر قابل اتکا به نظر برسد؟","چه نوع تعریف محترمانه‌ای بیشتر روی تو اثر می‌گذارد؟","برای حفظ حریم شخصی در رابطه چه اهمیتی قائلی؟","چه چیزی برایت نشانه توجه واقعی است؟","در یک رابطه، هیجان را بیشتر دوست داری یا آرامش را؟","چه موضوعی را بهتر است قبل از شروع رابطه روشن کرد؟","کدام رفتار کوچک می‌تواند روز طرف مقابل را بهتر کند؟","با رضایت همه، چه فعالیت دونفره‌ای را دوست داری امتحان کنی؟","چه چیزی باعث می‌شود احساس کنی واقعاً شنیده شده‌ای؟","در رابطه، اختلاف نظر را چطور سالم نگه می‌داری؟","کدام نوع پیام می‌تواند لبخند روی لبت بیاورد؟","چه چیزی باعث می‌شود به یک نفر فرصت شناخت بیشتر بدهی؟","یک قانون طلایی برای صمیمیت سالم چیست؟","کدام ویژگی غیرظاهری برایت بیشترین جذابیت را دارد?"]},"dare":{"pg":["با سه کلمه حال امروزت را تعریف کن.","یک صدای حیوان را اجرا کن تا طرف مقابل حدس بزند.","یک داستان دو جمله‌ای با سه کلمه تصادفی بساز.","نام یک خوراکی را با لحن گوینده خبر بگو.","در ده ثانیه پنج چیز هم‌رنگ پیدا کن.","یک حرکت کششی ساده انجام بده.","یک جمله خنده‌دار برای تبلیغ لیوانت بگو.","با چشم بسته یک شکل ساده در هوا بکش و توضیح بده.","یک ضرب‌المثل را با کلمات خودت بازگو کن.","برای طرف مقابل یک لقب دوستانه پیشنهاد بده.","یک شعر کوتاه دوخطی بداهه بساز.","اسم سه شهر را خیلی سریع بگو.","یک وسیله نزدیکت را مثل گوینده مستند معرفی کن.","یک جمله را با سه لحن متفاوت بگو.","تا نوبت بعد فقط با جمله‌های کوتاه جواب بده.","یک خاطره بامزه را در بیست ثانیه تعریف کن.","یک شعار برای امروزت بساز.","سه چیز بگو که بابتشان سپاسگزار هستی.","یک آهنگ را بدون کلمه با زمزمه اجرا کن.","یک سؤال جالب از طرف مقابل بپرس.","اسم پنج میوه را در پنج ثانیه بگو.","یک پیام انگیزشی کوتاه برای خودت بنویس.","یک حرکت دست بامزه اختراع کن و نام بگذار.","یک وسیله معمولی را گران‌ترین محصول دنیا معرفی کن.","یک جمله را بدون استفاده از حرف «ا» بگو.","یک خاطره خوب را با سه کلمه توصیف کن.","یک قانون بامزه برای دور بعد پیشنهاد بده.","تا ده ثانیه لبخندت را حفظ کن.","یک اسم فیلم خیالی برای امروزت انتخاب کن.","یک تعریف واقعی و محترمانه از طرف مقابل بگو.","سه شغل را با حرکت دست نمایش بده.","یک جمله را مثل ربات بگو.","یک نقاشی خیلی ساده بکش و نامش را بگو.","یک معمای کوتاه برای طرف مقابل بساز."],"pg13":["یک خاطره خجالت‌آور اما بی‌خطر را نمایشی تعریف کن.","سی ثانیه با یک لحن غیرعادی صحبت کن.","یک تبلیغ خلاقانه برای اولین وسیله نزدیکت بساز.","بدون کلمه «من» سه جمله درباره خودت بگو.","یک حرکت رقص کوتاه و بی‌خطر اجرا کن.","یک لقب دوستانه برای طرف مقابل بساز و دلیلش را بگو.","یک جمله سخت را سه بار سریع و درست بگو.","داستانی را که طرف مقابل انتخاب می‌کند در بیست ثانیه تعریف کن.","یک دیالوگ فیلم را با لحن کاملاً متفاوت اجرا کن.","برای نوبت بعد یک چالش محترمانه طراحی کن.","یک تصمیم سخت خیالی را در ده ثانیه توضیح بده.","سه ویژگی خوب خودت را بدون مکث بگو.","یک پیام کوتاه با لحن شاعرانه بنویس.","یک موقعیت روزمره را مثل صحنه فیلم بازی کن.","تا نوبت بعد از کلمه «خوب» استفاده نکن.","یک سؤال غیرمنتظره اما محترمانه بپرس.","یک خاطره را فقط با پنج کلمه تعریف کن.","برای یک شیء معمولی داستان قهرمانی بساز.","یک نظر خودت را با دو دلیل بیان کن.","یک جمله را طوری بگو که انگار راز بزرگی است.","سه انتخاب سخت بین دو گزینه برای طرف مقابل بساز.","یک معرفی سی‌ثانیه‌ای از خودت انجام بده.","یک اتفاق معمولی را خیلی هیجان‌انگیز تعریف کن.","یک قانون جدید برای امتیازدهی پیشنهاد بده.","یک جمله را با لحن مجری مسابقه بگو.","از طرف مقابل بابت یک ویژگی خوب تشکر کن.","یک پایان متفاوت برای یک فیلم معروف پیشنهاد بده.","یک داستان را از آخر به اول تعریف کن.","در سه جمله خودت را برای یک شغل خیالی معرفی کن.","یک جمله بگو که هم جدی باشد هم خنده‌دار.","یک خاطره را بدون گفتن زمان و مکان تعریف کن.","سه چیز بگو که دوست داری در آینده تجربه کنی.","یک عنوان کتاب برای زندگی‌ات انتخاب کن.","یک نقش کوتاه از یک معلم سختگیر اجرا کن."],"adult":["با رضایت طرف مقابل یک تعریف رمانتیک و محترمانه بگو.","یک پیام کوتاه و صمیمی اما محترمانه بنویس.","با رضایت همه یک ژست رمانتیک کوتاه و بامزه اجرا کن.","یک قرار صمیمی و کم‌هزینه طراحی کن.","سه کلمه بگو که برایت حال‌وهوای رمانتیک دارند.","یک جمله عاشقانه را نمایشی و محترمانه اجرا کن.","یک مرز مهم در صمیمیت را با احترام توضیح بده.","یک چالش رمانتیک غیرجنسی و قابل ردکردن پیشنهاد بده.","یک تعریف غیرظاهری از طرف مقابل بگو.","یک پیام صبح‌به‌خیر صمیمی اما محترمانه طراحی کن.","یک خاطره رمانتیک خیالی کوتاه بساز.","سه ویژگی عاطفی مهم خودت را نام ببر.","یک قرار ایده‌آل را در سه مرحله توضیح بده.","یک جمله حمایتگر برای روز سخت طرف مقابل بگو.","با رضایت طرف مقابل یک لقب رمانتیک اما محترمانه پیشنهاد کن.","یک قانون برای گفت‌وگوی سالم دونفره بساز.","یک آهنگ مناسب یک قرار آرام پیشنهاد بده و دلیلش را بگو.","یک سؤال صمیمی اما غیرخصوصی از طرف مقابل بپرس.","یک متن کوتاه تشکر برای همراهی طرف مقابل بنویس.","یک فعالیت دونفره بدون هزینه پیشنهاد بده.","یک موقعیت سوءتفاهم را محترمانه بازی کن و حلش کن.","یک جمله بگو که نشان دهد به حریم شخصی احترام می‌گذاری.","یک تعریف درباره شخصیت طرف مقابل بیان کن.","یک قرار شبانه آرام را با سه جزئیات توصیف کن.","یک پیام دلگرم‌کننده برای شروع روز بنویس.","سه نشانه از اعتماد سالم را در قالب چالش بگو.","یک جمله عاشقانه بدون اشاره به ظاهر بساز.","با رضایت طرف مقابل یک سورپرایز ساده طراحی کن.","یک گفت‌وگوی کوتاه برای آشتی محترمانه اجرا کن.","یک مرز ارتباطی را شفاف و محترمانه بیان کن.","یک ویژگی را بگو که باعث می‌شود کنار کسی احساس آرامش کنی.","یک دعوت صمیمی اما محترمانه برای قرار بساز.","یک تعریف درباره طرز فکر طرف مقابل بگو.","یک قانون طلایی برای رابطه سالم پیشنهاد بده.","یک پیام کوتاه درباره قدردانی از حضور طرف مقابل بنویس."]}};
for (const [type, ratings] of Object.entries(EXTRA_TRUTH_BANKS)) for (const [rating, items] of Object.entries(ratings)) TRUTH_BANKS[type][rating].push(...items);
function truthPrompt(mode = 'tod', rating = 'pg13', history = []) {
  const types = mode === 'truth' ? ['truth'] : mode === 'dare' ? ['dare'] : ['truth', 'dare'];
  const candidates = types.flatMap(type => (TRUTH_BANKS[type][rating] || TRUTH_BANKS[type].pg13).map(text => ({ type, text })));
  const fresh = candidates.filter(item => !history.includes(item.text)); const pool = fresh.length ? fresh : candidates;
  return pool[crypto.randomInt(0, pool.length)];
}

function roomId() { return crypto.randomBytes(12).toString('hex'); }
function accessToken() { return crypto.randomBytes(32).toString('base64url'); }
function playerSide(session, playerId) {
  const id = Number(playerId);
  if (Number(session.player_one) === id) return 'one';
  if (Number(session.player_two) === id) return 'two';
  return null;
}
function initialState(type, playerOne, playerTwo) {
  const current = type === 'ludo' ? (crypto.randomInt(0, 2) === 0 ? Number(playerOne) : Number(playerTwo)) : Number(playerOne);
  if (type === 'ludo') { const palette = ['red', 'blue', 'yellow', 'green']; const first = palette[crypto.randomInt(0, palette.length)]; const remaining = palette.filter(color => color !== first); const second = remaining[crypto.randomInt(0, remaining.length)]; const colors = { [playerOne]: first, [playerTwo]: second }; return { positions: { [playerOne]: [-1, -1, -1, -1], [playerTwo]: [-1, -1, -1, -1] }, playerColors: colors, current, lastRoll: null, pendingRoll: null, moves: 0, winner: null }; }
  if (type === 'chess') { const fen = new Chess().fen(); return { rulesVersion: 'fide-2023', board: chessBoard(), current, winner: null, moves: 0, fen, startFen: fen, pgn: '', inCheck: false }; }
  if (type === 'truth') return { current, prompt: null, promptType: null, rounds: 0, winner: null, mode: 'tod', rating: 'pg13', history: [], questionQueue: [], questionQueueKey: 'tod:pg13', lastAction: null };
  if (type === 'cards') {
    const deck = Array.from({ length: 52 }, (_, card) => card);
    for (let i = deck.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return { rulesVersion: 'war-1', decks: { [playerOne]: deck.slice(0, 26), [playerTwo]: deck.slice(26) }, pot: [], ready: { [playerOne]: false, [playerTwo]: false }, scores: { [playerOne]: 26, [playerTwo]: 26 }, current: Number(playerOne), round: 0, winner: null, lastBattle: null, result: null };
  }
  return { current, prompt: null, promptType: null, rounds: 0, winner: null };
}
function chessBoard() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  board[0] = back.map(piece => `b${piece}`); board[1] = Array(8).fill('bp');
  board[6] = Array(8).fill('wp'); board[7] = back.map(piece => `w${piece}`);
  return board;
}
function chessFenFromBoard(board, current, session, moves = 0) {
  const ranks = (Array.isArray(board) ? board : chessBoard()).map(row => {
    let run = 0, out = '';
    for (const cell of (Array.isArray(row) ? row : [])) {
      if (!cell) { run++; continue; }
      if (run) { out += String(run); run = 0; }
      const symbol = String(cell[1] || '').toLowerCase();
      out += cell[0] === 'w' ? symbol.toUpperCase() : symbol;
    }
    if (run) out += String(run);
    return out || '8';
  }).join('/');
  const initial = JSON.stringify(board) === JSON.stringify(chessBoard()) && Number(moves) === 0;
  const side = Number(current) === Number(session.player_one) ? 'w' : 'b';
  return `${ranks} ${side} ${initial ? 'KQkq' : '-'} - 0 ${Math.floor(Number(moves || 0) / 2) + 1}`;
}
function chessFromState(state, session) {
  const game = new Chess();
  const pgn = String(state.pgn || '').trim();
  if (pgn) { game.loadPgn(pgn); return game; }
  const fen = String(state.fen || chessFenFromBoard(state.board, state.current, session, state.moves));
  game.load(fen);
  return game;
}
function chessBoardFromGame(game) {
  return game.board().map(row => row.map(piece => piece ? `${piece.color}${piece.type}` : null));
}
function chessSquare(row, col) { return `${String.fromCharCode(97 + col)}${8 - row}`; }
function chessCoord(square) { return [8 - Number(square[1]), square.charCodeAt(0) - 97]; }
function chessPositionKey(game) {
  const fields = game.fen().split(' ');
  const canEnPassant = fields[3] !== '-' && game.moves({ verbose: true }).some(move => String(move.flags).includes('e'));
  return `${fields[0]} ${fields[1]} ${fields[2]} ${canEnPassant ? fields[3] : '-'}`;
}
function chessRepetitionCount(game, startFen) {
  const replay = new Chess();
  if (startFen) replay.load(startFen);
  const counts = new Map();
  const add = () => { const key = chessPositionKey(replay); counts.set(key, (counts.get(key) || 0) + 1); };
  add();
  for (const move of game.history({ verbose: true })) {
    replay.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
    add();
  }
  return counts.get(chessPositionKey(game)) || 1;
}
function availableChessMoves(session, state, playerId) {
  if (Number(state.current) !== Number(playerId) || session.status !== 'active') return {};
  const game = chessFromState(state, session);
  const color = Number(session.player_one) === Number(playerId) ? 'w' : 'b';
  if (game.turn() !== color) return {};
  const moves = {};
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const square = chessSquare(row, col), piece = game.get(square);
    if (!piece || piece.color !== color) continue;
    const targets = game.moves({ square, verbose: true }).map(move => chessCoord(move.to));
    if (targets.length) moves[`${row},${col}`] = [...new Map(targets.map(target => [`${target[0]},${target[1]}`, target])).values()];
  }
  return moves;
}
function safeState(state) { return JSON.parse(JSON.stringify(state)); }
function publicState(session, playerId, messages = []) {
  const side = playerSide(session, playerId);
  if (!side) return null;
  const rawState = session.state || {};
  const state = safeState(rawState);
  if (session.game_type === 'cards' && rawState.rulesVersion === 'war-1') {
    delete state.decks;
    delete state.pot;
  }
  const now = Date.now();
  const status = session.status === 'active' && session.ends_at && new Date(session.ends_at).getTime() <= now ? 'finished' : session.status;
  let canClaimDraw = false;
  if (session.game_type === 'chess' && status === 'active' && Number(rawState.current) === Number(playerId)) {
    try { const chess = chessFromState(rawState, session); canClaimDraw = chess.isThreefoldRepetition() || chess.isDrawByFiftyMoves(); } catch {}
  }
  return {
    room: session.room_id, token: session.access_token, game: session.game_type,
    title: DUEL_GAMES[session.game_type]?.title || session.game_type,
    emoji: DUEL_GAMES[session.game_type]?.emoji || '🎮',
    player: Number(playerId), side, opponent: Number(session.player_one) === Number(playerId) ? Number(session.player_two) : Number(session.player_one),
    status, ready: side === 'one' ? Boolean(session.ready_one) : Boolean(session.ready_two),
    opponentReady: side === 'one' ? Boolean(session.ready_two) : Boolean(session.ready_one),
    state, legalMoves: session.game_type === 'chess' ? availableChessMoves(session, rawState, playerId) : {}, canClaimDraw,
    messages: messages.map(row => ({ id: row.id, sender: Number(row.sender_id), text: row.deleted_at ? '' : row.text, replyToId: row.reply_to_id ? Number(row.reply_to_id) : null, replyText: row.reply_text || null, reactions: row.reactions || [], deleted: Boolean(row.deleted_at), edited: Boolean(row.edited_at), createdAt: row.created_at })),
  };
}
export async function ensureDuelSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS duel_game_sessions (
    room_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, game_type TEXT NOT NULL,
    player_one BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    player_two BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    ready_one BOOLEAN NOT NULL DEFAULT FALSE, ready_two BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished','cancelled')),
    state JSONB NOT NULL DEFAULT '{}'::jsonb, winner BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ends_at TIMESTAMPTZ,
    CHECK (player_one <> player_two), CHECK (game_type IN ('ludo','chess','cards','truth'))
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS duel_game_messages (
    id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL REFERENCES duel_game_sessions(room_id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, text TEXT NOT NULL,
    reply_to_id BIGINT REFERENCES duel_game_messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query('ALTER TABLE duel_game_messages ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES duel_game_messages(id) ON DELETE SET NULL');
  await client.query('ALTER TABLE duel_game_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ');
  await client.query('ALTER TABLE duel_game_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
  await client.query(`CREATE TABLE IF NOT EXISTS duel_game_message_reactions (
    message_id BIGINT NOT NULL REFERENCES duel_game_messages(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (message_id,user_id,emoji)
  )`);
  await client.query('ALTER TABLE duel_game_message_reactions DROP CONSTRAINT IF EXISTS duel_game_message_reactions_emoji_check');
  await client.query("DELETE FROM duel_game_message_reactions a USING duel_game_message_reactions b WHERE a.message_id=b.message_id AND a.user_id=b.user_id AND a.ctid < b.ctid");
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS duel_game_message_reactions_one_per_user_idx ON duel_game_message_reactions(message_id,user_id)');
  await client.query('CREATE INDEX IF NOT EXISTS duel_game_sessions_players_idx ON duel_game_sessions(player_one, player_two, status, created_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS duel_game_messages_room_idx ON duel_game_messages(room_id, id DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS duel_game_message_reactions_message_idx ON duel_game_message_reactions(message_id)');
}

export async function createDuelSession(pool, gameType, playerOne, playerTwo) {
  if (!DUEL_GAMES[gameType]) throw new Error('invalid_game');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await ensureDuelSchema(client);
    await client.query("UPDATE duel_game_sessions SET status='cancelled', updated_at=NOW() WHERE status IN ('waiting','active') AND game_type=$3 AND ((player_one=$1 AND player_two=$2) OR (player_one=$2 AND player_two=$1))", [playerOne, playerTwo, gameType]);
    const row = (await client.query(`INSERT INTO duel_game_sessions(room_id,access_token,game_type,player_one,player_two,state) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [roomId(), accessToken(), gameType, playerOne, playerTwo, JSON.stringify(initialState(gameType, playerOne, playerTwo))])).rows[0];
    await client.query('COMMIT'); return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function loadSession(pool, room, token) { return (await pool.query("SELECT * FROM duel_game_sessions WHERE room_id=$1 AND access_token=$2 AND (game_type='truth' OR created_at > NOW() - (($3::text || ' minutes')::interval))", [room, token, ROOM_TTL_MINUTES])).rows[0] || null; }
async function loadMessages(pool, room, viewerId) {
  return (await pool.query(`SELECT m.id,m.sender_id,m.text,m.reply_to_id,m.created_at,m.edited_at,m.deleted_at,CASE WHEN rm.deleted_at IS NULL THEN rm.text ELSE NULL END AS reply_text,
    COALESCE((SELECT json_agg(json_build_object('emoji',x.emoji,'count',x.count,'me',x.me) ORDER BY x.emoji)
      FROM (SELECT r.emoji,COUNT(*)::int AS count,BOOL_OR(r.user_id=$2) AS me
            FROM duel_game_message_reactions r WHERE r.message_id=m.id GROUP BY r.emoji) x),'[]'::json) AS reactions
    FROM duel_game_messages m LEFT JOIN duel_game_messages rm ON rm.id=m.reply_to_id
    WHERE m.room_id=$1 ORDER BY m.id DESC LIMIT 60`, [room, viewerId])).rows.reverse();
}

export async function latestDuelSession(pool, playerId, gameType = null) {
  const params = [playerId]; const where = ["$1 IN (player_one,player_two)", "status IN ('waiting','active')", "(game_type='truth' OR created_at > NOW() - INTERVAL '120 minutes')"];
  if (gameType) { params.push(gameType); where.push(`game_type=$${params.length}`); }
  return (await pool.query(`SELECT * FROM duel_game_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 1`, params)).rows[0] || null;
}

function assertActive(session, playerId) { if (!session || !playerSide(session, playerId)) throw new Error('session_not_found'); if (session.status !== 'active') throw new Error('game_not_active'); }
function otherPlayer(session, id) { return Number(session.player_one) === Number(id) ? Number(session.player_two) : Number(session.player_one); }
function setWinner(state, session, winner) { state.winner = winner == null ? null : Number(winner); session.winner = state.winner; session.status = 'finished'; }
function normalizeLudoPieces(state, playerId) {
  const raw = state.positions?.[playerId];
  const pieces = Array.isArray(raw) ? raw : [Number(raw || -1), -1, -1, -1];
  state.positions ||= {};
  state.positions[playerId] = Array.from({ length: 4 }, (_, index) => {
    const value = Number(pieces[index]); return Number.isFinite(value) ? Math.max(-1, Math.min(LUDO_FINISH, value)) : -1;
  });
  return state.positions[playerId];
}
export const LUDO_COLOR_OFFSETS = { red: 0, yellow: 13, blue: 26, green: 39 };
function ludoPlayerOffset(state, session, playerId) { const color = state?.playerColors?.[String(playerId)]; return LUDO_COLOR_OFFSETS[color] ?? (Number(session.player_one) === Number(playerId) ? 0 : 26); }
function ludoTrackIndex(state, session, playerId, position) { return (position + ludoPlayerOffset(state, session, playerId)) % 52; }
function ludoCanMove(piece, roll) { return piece >= 0 ? piece + roll <= LUDO_FINISH : roll === 6; }
function ludoRoll(state, session, playerId) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  if (state.pendingRoll?.player === Number(playerId)) return;
  const pieces = normalizeLudoPieces(state, playerId);
  const roll = crypto.randomInt(1, 7);
  const legalPieces = pieces.map((position, index) => ludoCanMove(position, roll) ? index : -1).filter(index => index >= 0);
  state.lastRoll = roll; state.lastRollBy = Number(playerId); state.rolls = Number(state.rolls || 0) + 1; state.turnStartedAt = Date.now();
  if (!legalPieces.length) {
    state.pendingRoll = null;
    state.lastMove = { type: 'dead_roll', player: Number(playerId), roll };
    state.current = otherPlayer(session, playerId);
    return;
  }
  state.pendingRoll = { player: Number(playerId), roll };
  state.lastMove = { type: 'roll', player: Number(playerId), roll };
  // A forced move is automatic; the player only chooses when multiple legal tokens exist.
  if (legalPieces.length === 1) {
    ludoMove(state, session, playerId, { piece: legalPieces[0] });
    if (state.lastMove) state.lastMove.forced = true;
  }
}
function ludoMove(state, session, playerId, payload = {}) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const pending = state.pendingRoll; if (!pending || Number(pending.player) !== Number(playerId)) throw new Error('roll_required');
  const pieceIndex = Number(payload.piece); if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex > 3) throw new Error('invalid_move');
  const pieces = normalizeLudoPieces(state, playerId); const position = pieces[pieceIndex]; const roll = Number(pending.roll);
  if (!ludoCanMove(position, roll)) throw new Error('invalid_move');
  const from = position; if (position < 0) pieces[pieceIndex] = 0; else pieces[pieceIndex] = position + roll;
  const movedPosition = pieces[pieceIndex]; let captured = false; let reachedHome = movedPosition === LUDO_FINISH;
  if (movedPosition >= 0 && movedPosition < 52) {
    const landing = ludoTrackIndex(state, session, playerId, movedPosition); const safe = LUDO_SAFE_TRACK.includes(landing);
    if (!safe) for (const opponentId of [session.player_one, session.player_two].filter(id => Number(id) !== Number(playerId))) {
      const opponents = normalizeLudoPieces(state, opponentId);
      opponents.forEach((opponentPosition, index) => { if (opponentPosition >= 0 && opponentPosition < 52 && ludoTrackIndex(state, session, opponentId, opponentPosition) === landing) { opponents[index] = -1; captured = true; } });
    }
  }
  state.pendingRoll = null; state.lastPiece = pieceIndex; state.moves = Number(state.moves || 0) + 1;
  state.lastMove = { type: 'move', player: Number(playerId), piece: pieceIndex, from, to: movedPosition, roll, captured, reachedHome, safe: movedPosition >= 0 && movedPosition < 52 && LUDO_SAFE_TRACK.includes(ludoTrackIndex(state, session, playerId, movedPosition)) };
  if (pieces.every(piece => piece >= LUDO_FINISH)) setWinner(state, session, playerId);
  else if (roll !== 6) state.current = otherPlayer(session, playerId);
  state.turnStartedAt = Date.now();
}
function chessMove(state, session, playerId, payload = {}) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const rawFrom = payload?.from || {}, rawTo = payload?.to || {};
  const from = { row: rawFrom.row ?? rawFrom.r, col: rawFrom.col ?? rawFrom.c };
  const to = { row: rawTo.row ?? rawTo.r, col: rawTo.col ?? rawTo.c };
  const valid = [from.row, from.col, to.row, to.col].every(Number.isInteger) && [from.row, from.col, to.row, to.col].every(x => x >= 0 && x < 8);
  if (!valid) throw new Error('invalid_move');
  const game = chessFromState(state, session);
  const fromSquare = chessSquare(from.row, from.col), toSquare = chessSquare(to.row, to.col);
  const color = Number(session.player_one) === Number(playerId) ? 'w' : 'b';
  if (game.turn() !== color) throw new Error('not_your_turn');
  const piece = game.get(fromSquare);
  if (!piece || piece.color !== color) throw new Error('invalid_move');
  const promotes = piece.type === 'p' && (to.row === (color === 'w' ? 0 : 7));
  const promotion = String(payload.promotion || '').toLowerCase();
  if (promotes && !['q', 'r', 'b', 'n'].includes(promotion)) throw new Error('promotion_required');
  let played;
  try { played = game.move({ from: fromSquare, to: toSquare, ...(promotes ? { promotion } : {}) }); }
  catch { throw new Error('invalid_move'); }
  state.startFen ||= state.fen || chessFenFromBoard(state.board, state.current, session, state.moves);
  state.fen = game.fen(); state.pgn = game.pgn(); state.board = chessBoardFromGame(game);
  state.moves = game.history().length;
  state.current = game.turn() === 'w' ? Number(session.player_one) : Number(session.player_two);
  state.inCheck = game.isCheck();
  state.lastMove = { san: played.san, from: played.from, to: played.to, promotion: played.promotion || null, check: state.inCheck };
  state.result = null;
  if (game.isCheckmate()) { state.result = 'checkmate'; setWinner(state, session, playerId); }
  else if (game.isStalemate()) { state.result = 'stalemate'; setWinner(state, session, null); }
  else if (game.isInsufficientMaterial()) { state.result = 'dead_position'; setWinner(state, session, null); }
  else if (chessRepetitionCount(game, state.startFen) >= 5) { state.result = 'fivefold_repetition'; setWinner(state, session, null); }
  else if (Number(game.fen().split(' ')[4]) >= 150) { state.result = 'seventy_five_moves'; setWinner(state, session, null); }
}
function claimChessDraw(state, session, playerId) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const game = chessFromState(state, session);
  if (game.isThreefoldRepetition()) state.result = 'threefold_claim';
  else if (game.isDrawByFiftyMoves()) state.result = 'fifty_move_claim';
  else throw new Error('draw_not_claimable');
  setWinner(state, session, null);
}
function cardMove(state, session, playerId) {
  if (state.rulesVersion === 'war-1') throw new Error('use_reveal_action');
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const card = crypto.randomInt(1, 14); state.lastCard = card; state.scores[playerId] = Number(state.scores[playerId] || 0) + card; state.round += 1;
  if (state.round >= 10) { const a = state.scores[session.player_one]; const b = state.scores[session.player_two]; setWinner(state, session, a === b ? null : (a > b ? session.player_one : session.player_two)); } else state.current = otherPlayer(session, playerId);
}
function warRank(card) { return Math.floor(Number(card) / 4) + 2; }
function warResetReady(state, session) { state.ready = { [session.player_one]: false, [session.player_two]: false }; }
function updateWarScores(state, session) {
  state.scores = { [session.player_one]: state.decks[session.player_one].length, [session.player_two]: state.decks[session.player_two].length };
}
function cardReveal(state, session, playerId) {
  if (state.rulesVersion !== 'war-1') throw new Error('invalid_action');
  const key = String(playerId);
  state.ready ||= {};
  // Make duplicate taps/network retries harmless on slow mobile connections.
  if (state.ready[key]) return;
  state.ready[key] = true;
  if (!state.ready[String(session.player_one)] || !state.ready[String(session.player_two)]) return;
  resolveWarBattle(state, session);
}
function resolveWarBattle(state, session) {
  const one = String(session.player_one), two = String(session.player_two);
  const decks = state.decks, pot = Array.isArray(state.pot) ? state.pot : [];
  const sequence = [];
  let winner = null, forcedWin = false, draw = false, guard = 0;
  while (guard++ < 60) {
    if (!decks[one].length || !decks[two].length) {
      winner = decks[one].length ? Number(one) : decks[two].length ? Number(two) : null;
      break;
    }
    const first = decks[one].shift(), second = decks[two].shift();
    pot.push(first, second);
    sequence.push({ one: first, two: second, faceDown: 0 });
    if (warRank(first) !== warRank(second)) { winner = warRank(first) > warRank(second) ? Number(one) : Number(two); break; }
    let tied = true;
    while (tied) {
      const canOne = decks[one].length >= 4, canTwo = decks[two].length >= 4;
      if (!canOne || !canTwo) {
        if (canOne && !canTwo) winner = Number(one);
        else if (canTwo && !canOne) winner = Number(two);
        else draw = true;
        forcedWin = Boolean(winner);
        tied = false;
        break;
      }
      for (let i = 0; i < 3; i++) pot.push(decks[one].shift(), decks[two].shift());
      const warOne = decks[one].shift(), warTwo = decks[two].shift();
      pot.push(warOne, warTwo);
      sequence.push({ one: warOne, two: warTwo, faceDown: 3 });
      if (warRank(warOne) !== warRank(warTwo)) { winner = warRank(warOne) > warRank(warTwo) ? Number(one) : Number(two); tied = false; }
    }
    break;
  }
  if (winner !== null) {
    decks[String(winner)].push(...pot.splice(0));
    if (forcedWin) {
      const loser = String(Number(winner) === Number(one) ? two : one);
      decks[String(winner)].push(...decks[loser].splice(0));
    }
  }
  state.pot = pot;
  state.round = Number(state.round || 0) + 1;
  state.lastBattle = { sequence, winner, draw, forcedWin, potCount: sequence.reduce((sum, item) => sum + 2 + item.faceDown * 2, 0) };
  state.result = null;
  state.current = otherPlayer(session, Number(state.current) || Number(one));
  warResetReady(state, session);
  updateWarScores(state, session);
  if (draw) { state.result = 'war_exhaustion_draw'; setWinner(state, session, null); }
  else if (winner !== null && (!decks[one].length || !decks[two].length)) { state.result = forcedWin ? 'war_exhaustion' : 'all_cards'; setWinner(state, session, winner); }
  else if (!decks[one].length || !decks[two].length) {
    const last = decks[one].length ? Number(one) : decks[two].length ? Number(two) : null;
    state.result = 'all_cards'; setWinner(state, session, last);
  }
}
function truthMove(state, session, playerId, payload = {}) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const command = String(payload.command || 'start'); const mode = ['truth', 'dare', 'tod'].includes(payload.mode) ? payload.mode : (state.mode || 'tod'); const rating = ['pg', 'pg13', 'adult'].includes(payload.rating) ? payload.rating : (state.rating || 'pg13');
  state.mode = mode; state.rating = rating; state.history = Array.isArray(state.history) ? state.history : [];
  if (command === 'complete') {
    if (!state.prompt) throw new Error('no_prompt'); state.history.push(state.prompt); state.prompt = null; state.promptType = null; state.rounds = Number(state.rounds || 0) + 1; state.current = otherPlayer(session, playerId); return;
  }
  if (command === 'reroll' && !state.prompt) throw new Error('no_prompt');
  if (command === 'reroll' && state.prompt && !state.history.includes(state.prompt)) state.history.push(state.prompt);
  const queueKey = `${mode}:${rating}`;
  if (state.questionQueueKey !== queueKey) { state.questionQueueKey = queueKey; state.questionQueue = []; }
  const types = mode === 'truth' ? ['truth'] : mode === 'dare' ? ['dare'] : ['truth', 'dare'];
  const candidates = types.flatMap(type => (TRUTH_BANKS[type][rating] || TRUTH_BANKS[type].pg13).map(text => ({ type, text })));
  if (!Array.isArray(state.questionQueue) || !state.questionQueue.length) {
    const fresh = candidates.filter(item => !state.history.includes(item.text)); if (!fresh.length) throw new Error('truth_question_bank_exhausted'); state.questionQueue = fresh.slice();
    for (let i = state.questionQueue.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [state.questionQueue[i], state.questionQueue[j]] = [state.questionQueue[j], state.questionQueue[i]]; }
  }
  const picked = state.questionQueue.shift(); state.prompt = picked.text; state.promptType = picked.type === 'truth' ? 'حقیقت' : 'جرئت'; state.lastAction = command; state.updatedAt = Date.now();
}

async function advanceExpiredLudoTurn(pool, room, token) {
  const snapshot = await loadSession(pool, room, token);
  if (!snapshot || snapshot.game_type !== 'ludo' || snapshot.status !== 'active') return;
  const snapshotState = snapshot.state || {};
  const startedAt = Number(snapshotState.turnStartedAt);
  if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < 15000) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = (await client.query('SELECT * FROM duel_game_sessions WHERE room_id=$1 AND access_token=$2 FOR UPDATE', [room, token])).rows[0];
    if (!session || session.game_type !== 'ludo' || session.status !== 'active') { await client.query('COMMIT'); return; }
    const state = session.state || {};
    const now = Date.now(), currentStartedAt = Number(state.turnStartedAt);
    if (!Number.isFinite(currentStartedAt) || currentStartedAt <= 0) {
      state.turnStartedAt = now;
      await client.query('UPDATE duel_game_sessions SET state=$2::jsonb,updated_at=NOW() WHERE room_id=$1', [room, JSON.stringify(state)]);
      await client.query('COMMIT'); return;
    }
    if (now - currentStartedAt < 15000) { await client.query('COMMIT'); return; }
    const currentPlayer = Number(state.current);
    if (state.pendingRoll?.player === currentPlayer) {
      const positions = normalizeLudoPieces(state, currentPlayer), roll = Number(state.pendingRoll.roll);
      const legalPieces = positions.map((position, index) => ludoCanMove(position, roll) ? index : -1).filter(index => index >= 0);
      if (legalPieces.length) {
        const piece = legalPieces[crypto.randomInt(0, legalPieces.length)];
        ludoMove(state, session, currentPlayer, { piece });
        if (state.lastMove) { state.lastMove.auto = true; state.lastMove.autoReason = 'piece-timeout'; }
      } else {
        state.pendingRoll = null; state.current = otherPlayer(session, currentPlayer);
        state.lastMove = { type: 'dead_roll', player: currentPlayer, roll, auto: true };
      }
    } else {
      ludoRoll(state, session, currentPlayer);
      if (state.pendingRoll?.player === currentPlayer) {
        const positions = normalizeLudoPieces(state, currentPlayer), roll = Number(state.pendingRoll.roll);
        const legalPieces = positions.map((position, index) => ludoCanMove(position, roll) ? index : -1).filter(index => index >= 0);
        if (legalPieces.length) {
          const piece = legalPieces[crypto.randomInt(0, legalPieces.length)];
          ludoMove(state, session, currentPlayer, { piece });
          if (state.lastMove) { state.lastMove.auto = true; state.lastMove.autoReason = 'turn-timeout'; }
        }
      } else if (state.lastMove) state.lastMove.auto = true;
    }
    state.turnStartedAt = Date.now();
    await client.query('UPDATE duel_game_sessions SET state=$2::jsonb,status=$3,winner=$4,updated_at=NOW() WHERE room_id=$1', [room, JSON.stringify(state), session.status, session.winner]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function duelState(pool, room, token, playerId) {
  await advanceExpiredLudoTurn(pool, room, token);
  const session = await loadSession(pool, room, token);
  if (!session) return null;
  return publicState(session, playerId, await loadMessages(pool, room, playerId));
}
export async function duelAction(pool, room, token, playerId, action, payload = {}) {
  if (['chat','reaction','edit','delete'].includes(action)) {
    const session = await loadSession(pool, room, token); if (!session || !playerSide(session, playerId)) return null;
    if (action === 'chat') {
      const text = String(payload.text || '').trim().slice(0, MAX_CHAT_LENGTH); if (!text) throw new Error('empty_message');
      const rawReplyTo = payload.replyTo ?? payload.reply_to_id; const replyTo = rawReplyTo == null || rawReplyTo === '' ? null : Number(rawReplyTo);
      if (replyTo !== null && (!Number.isSafeInteger(replyTo) || !(await pool.query('SELECT 1 FROM duel_game_messages WHERE id=$1 AND room_id=$2',[replyTo,room])).rowCount)) throw new Error('invalid_reply');
      await pool.query('INSERT INTO duel_game_messages(room_id,sender_id,text,reply_to_id) VALUES($1,$2,$3,$4)', [room, playerId, text, replyTo]);
    } else if (action === 'edit' || action === 'delete') {
      const messageId = Number(payload.messageId);
      const row = (await pool.query('SELECT sender_id,deleted_at FROM duel_game_messages WHERE id=$1 AND room_id=$2',[messageId,room])).rows[0];
      if (!row) throw new Error('message_not_found');
      if (Number(row.sender_id) !== Number(playerId)) throw new Error('not_message_owner');
      if (row.deleted_at) throw new Error('message_deleted');
      if (action === 'edit') {
        const text = String(payload.text || '').trim().slice(0, MAX_CHAT_LENGTH); if (!text) throw new Error('empty_message');
        await pool.query('UPDATE duel_game_messages SET text=$3,edited_at=NOW() WHERE id=$1 AND room_id=$2',[messageId,room,text]);
      } else {
        await pool.query("UPDATE duel_game_messages SET text='',reply_to_id=NULL,deleted_at=NOW() WHERE id=$1 AND room_id=$2",[messageId,room]);
        await pool.query('DELETE FROM duel_game_message_reactions WHERE message_id=$1',[messageId]);
      }
    } else {
      const messageId = Number(payload.messageId); const emoji = String(payload.emoji || '').trim();
      const emojiLength = Array.from(emoji).length;
      if (!Number.isSafeInteger(messageId) || !emoji || emojiLength > 16 || /[\u0000-\u001f\u007f\s]/u.test(emoji)) throw new Error('invalid_reaction');
      if (!(await pool.query('SELECT 1 FROM duel_game_messages WHERE id=$1 AND room_id=$2',[messageId,room])).rowCount) throw new Error('message_not_found');
      const existing = await pool.query('SELECT 1 FROM duel_game_message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3',[messageId,playerId,emoji]);
      await pool.query('DELETE FROM duel_game_message_reactions WHERE message_id=$1 AND user_id=$2',[messageId,playerId]);
      if (!existing.rowCount) await pool.query('INSERT INTO duel_game_message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3)',[messageId,playerId,emoji]);
    }
    return duelState(pool, room, token, playerId);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const session = (await client.query('SELECT * FROM duel_game_sessions WHERE room_id=$1 AND access_token=$2 FOR UPDATE', [room, token])).rows[0];
    if (!session || !playerSide(session, playerId)) { await client.query('ROLLBACK'); return null; }
    if (action === 'ready') { if (!['waiting','active'].includes(session.status)) throw new Error('game_not_active'); const column = Number(playerId) === Number(session.player_one) ? 'ready_one' : 'ready_two'; const otherReady = Number(playerId) === Number(session.player_one) ? session.ready_two : session.ready_one; const active = Boolean(otherReady); await client.query(`UPDATE duel_game_sessions SET ${column}=TRUE,status=CASE WHEN $2 THEN 'active' ELSE status END,ends_at=CASE WHEN $2 AND game_type <> 'truth' THEN NOW()+INTERVAL '2 hours' WHEN $2 AND game_type = 'truth' THEN NULL ELSE ends_at END,updated_at=NOW() WHERE room_id=$1`, [room, active]); }
    else if (action === 'leave') { const state = session.state || {}; state.leftPlayer = Number(playerId); state.leftAt = Date.now(); await client.query("UPDATE duel_game_sessions SET status='cancelled',state=$2::jsonb,updated_at=NOW() WHERE room_id=$1", [room, JSON.stringify(state)]); }
    else { assertActive(session, playerId); const state = session.state || {}; if (session.game_type === 'ludo' && action === 'roll') ludoRoll(state, session, playerId); else if (session.game_type === 'ludo' && action === 'move') ludoMove(state, session, playerId, payload); else if (session.game_type === 'chess' && action === 'move') chessMove(state, session, playerId, payload); else if (session.game_type === 'chess' && action === 'claim_draw') claimChessDraw(state, session, playerId); else if (session.game_type === 'cards' && action === 'reveal') cardReveal(state, session, playerId); else if (session.game_type === 'cards' && action === 'draw') cardMove(state, session, playerId); else if (session.game_type === 'truth' && action === 'truth') truthMove(state, session, playerId, payload); else throw new Error('invalid_action'); await client.query('UPDATE duel_game_sessions SET state=$2::jsonb,status=$3,winner=$4,updated_at=NOW() WHERE room_id=$1', [room, JSON.stringify(state), session.status, session.winner]); }
    await client.query('COMMIT'); return duelState(pool, room, token, playerId);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
