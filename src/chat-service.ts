import type { Repository } from './types.js';

export const HELP = 'دستورات:\n/start شروع\n/next نفر بعدی\n/stop پایان گفتگو\n/block مسدود کردن طرف مقابل\n/report گزارش تخلف';
export interface CommandResult { text: string; partnerId?: number | null; partnerNotice?: string; }

export class ChatService {
  constructor(private readonly repo: Repository) {}

  async handleCommand(id: number, command: string): Promise<CommandResult> {
    await this.repo.upsertUser(id);
    if (command === '/start' || command === '/next') {
      const current = await this.repo.getPartner(id);
      if (current) await this.repo.clearPair(id);
      const partner = await this.repo.enqueue(id);
      return partner
        ? { text: 'یک نفر پیدا شد. می‌توانید ناشناس گفتگو کنید.', partnerId: partner, partnerNotice: 'یک نفر به تو وصل شد. گفتگو را شروع کن.' }
        : { text: 'در صف انتظار قرار گرفتی؛ به‌محض پیدا شدن نفر بعدی خبر می‌دهم.' };
    }
    if (command === '/stop') {
      const partner = await this.repo.clearPair(id);
      return { text: 'گفتگو پایان یافت.', partnerId: partner, partnerNotice: partner ? 'گفتگو پایان یافت.' : undefined };
    }
    if (command === '/block') {
      const partner = await this.repo.getPartner(id);
      if (!partner) return { text: 'در حال حاضر در گفتگویی نیستی.' };
      await this.repo.blockUser(id, partner);
      await this.repo.clearPair(id);
      return { text: 'کاربر مسدود و گفتگو پایان یافت.', partnerId: partner, partnerNotice: 'گفتگو پایان یافت.' };
    }
    if (command === '/report') {
      const partner = await this.repo.getPartner(id);
      if (!partner) return { text: 'در حال حاضر در گفتگویی نیستی.' };
      await this.repo.clearPair(id);
      return { text: 'گزارش ثبت شد و گفتگو پایان یافت.', partnerId: partner, partnerNotice: 'گفتگو پایان یافت.' };
    }
    return { text: HELP };
  }

  async handleText(id: number, text: string): Promise<{ partnerId: number | null; text: string }> {
    await this.repo.upsertUser(id);
    const partnerId = await this.repo.getPartner(id);
    if (!partnerId) return { partnerId: null, text: 'هنوز به کسی وصل نیستی. /start را بزن.' };
    if (await this.repo.isBlocked(partnerId, id)) return { partnerId: null, text: 'این گفتگو دیگر در دسترس نیست.' };
    await this.repo.markAction(id);
    return { partnerId, text };
  }
}
