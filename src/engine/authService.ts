'use client';

export interface UserAccount {
  username: string;
  savedDecks: {
    id: string;
    name: string;
    createdAt: number;
    mainDeck: any[];
    lifeDeck: any[];
  }[];
}

const STORAGE_KEY_USER = 'bot_current_user';
const STORAGE_KEY_USERS_DB = 'bot_users_db';

export function getStoredUsers(): Record<string, { password: string; account: UserAccount }> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USERS_DB);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getCurrentUser(): UserAccount | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function registerUser(username: string, password: string): { success: boolean; message: string; user?: UserAccount } {
  const cleanUser = username.trim();
  if (!cleanUser || cleanUser.length < 3) {
    return { success: false, message: 'ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร' };
  }
  if (!password || password.length < 4) {
    return { success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' };
  }

  const users = getStoredUsers();
  if (users[cleanUser.toLowerCase()]) {
    return { success: false, message: 'ชื่อผู้ใช้นี้มีคนใช้แล้ว กรุณาเลือกชื่ออื่น' };
  }

  const newAccount: UserAccount = {
    username: cleanUser,
    savedDecks: []
  };

  users[cleanUser.toLowerCase()] = {
    password,
    account: newAccount
  };

  localStorage.setItem(STORAGE_KEY_USERS_DB, JSON.stringify(users));
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(newAccount));
  return { success: true, message: 'สมัครสมาชิกสำเร็จ!', user: newAccount };
}

export function loginUser(username: string, password: string): { success: boolean; message: string; user?: UserAccount } {
  const cleanUser = username.trim().toLowerCase();
  const users = getStoredUsers();

  const found = users[cleanUser];
  if (!found || found.password !== password) {
    return { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }

  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(found.account));
  return { success: true, message: 'เข้าสู่ระบบสำเร็จ!', user: found.account };
}

export function logoutUser(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY_USER);
  }
}

export function saveDeckForUser(username: string, deckName: string, mainDeck: any[], lifeDeck: any[]): UserAccount | null {
  if (typeof window === 'undefined') return null;
  const users = getStoredUsers();
  const key = username.trim().toLowerCase();
  if (!users[key]) return null;

  const newDeck = {
    id: `deck-${Date.now()}`,
    name: deckName.trim() || `เด็คใหม่ ${users[key].account.savedDecks.length + 1}`,
    createdAt: Date.now(),
    mainDeck,
    lifeDeck
  };

  users[key].account.savedDecks.unshift(newDeck);
  localStorage.setItem(STORAGE_KEY_USERS_DB, JSON.stringify(users));
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(users[key].account));
  return users[key].account;
}

export function deleteDeckForUser(username: string, deckId: string): UserAccount | null {
  if (typeof window === 'undefined') return null;
  const users = getStoredUsers();
  const key = username.trim().toLowerCase();
  if (!users[key]) return null;

  users[key].account.savedDecks = users[key].account.savedDecks.filter(d => d.id !== deckId);
  localStorage.setItem(STORAGE_KEY_USERS_DB, JSON.stringify(users));
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(users[key].account));
  return users[key].account;
}
