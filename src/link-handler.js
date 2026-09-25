import { createLink, revokeLink } from './link-service.js';

const PERSIAN = {
  off: 'لینک اختصاصی شما باطل شد.',
  created: 'لینک اختصاصی شما ساخته شد:',
  safety: 'این لینک را فقط با افراد مورد اعتماد خود به اشتراک بگذارید. هر زمان خواستید با /link off آن را باطل کنید.',
  invalid: 'مدت زمان نامعتبر است. یک عدد بین ۱ تا ۱۶۸ ساعت وارد کنید؛ نمونه: /link 24',
};

export async function handleLinkCommand({ pool, userId, args, baseUrl, send }) {
  try {
    if (args[0] === 'off') {
      await revokeLink(pool, userId);
      await send(PERSIAN.off);
      return;
    }
    const raw = args[0];
    const hours = raw === undefined || raw === '' ? 168 : Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      await send(PERSIAN.invalid);
      return;
    }
    const url = await createLink(pool, userId, baseUrl, hours);
    await send(`${PERSIAN.created}\n${url}\n\n${PERSIAN.safety}`);
  } catch (error) {
    console.error('link_command_error', error?.message || 'unknown');
    await send('در پردازش لینک خطایی رخ داد. لطفاً بعداً دوباره تلاش کنید.');
  }
}
