export type ChatStatus = 'idle' | 'waiting' | 'chatting';

export interface UserState {
  telegramId: number;
  status: ChatStatus;
  partnerId: number | null;
  blockedIds: number[];
  lastActionAt: Date | null;
}

export interface Repository {
  getUser(id: number): Promise<UserState | null>;
  upsertUser(id: number): Promise<UserState>;
  enqueue(id: number): Promise<number | null>;
  removeFromQueue(id: number): Promise<void>;
  pairUsers(a: number, b: number): Promise<void>;
  getPartner(id: number): Promise<number | null>;
  clearPair(id: number): Promise<number | null>;
  blockUser(id: number, blockedId: number): Promise<void>;
  isBlocked(id: number, otherId: number): Promise<boolean>;
  markAction(id: number): Promise<void>;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
