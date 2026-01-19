import { get, limitToLast, onValue, push, query, ref, remove, set, update } from "firebase/database";

import { getDb } from "@/firebase";

export type ChatMessage = {
  id?: string;
  userId: string;
  text: string;
  createdAt: number;
  name?: string;
};

/**
 * Send a chat message for a room.
 * @param path Chat collection path prefix.
 * @param roomId Room id to write into.
 * @param message Message payload (userId/text required).
 * @returns The generated message id, or an empty string on failure.
 */
export async function sendChatMessage(
  path: string,
  roomId: string,
  message: Omit<ChatMessage, "id" | "createdAt"> & { createdAt?: number }
) {
  const db = getDb();
  if (!db || !roomId) return "";
  const createdAt = message.createdAt ?? Date.now();
  const msgRef = push(ref(db, `${path}/${roomId}/messages`));
  await set(msgRef, { ...message, createdAt });
  await update(ref(db, `${path}/${roomId}`), { lastActive: Date.now() });
  return msgRef.key ?? "";
}

/**
 * Subscribe to the latest chat messages for a room.
 * @param path Chat collection path prefix.
 * @param roomId Room id to subscribe to.
 * @param limit Max number of messages to return.
 * @param cb Callback with ordered message list.
 * @returns The unsubscribe function or null if subscription fails.
 */
export function subscribeChatMessages(
  path: string,
  roomId: string,
  limit: number,
  cb: (messages: ChatMessage[]) => void
) {
  const db = getDb();
  if (!db || !roomId) return null;
  const q = query(ref(db, `${path}/${roomId}/messages`), limitToLast(limit));
  return onValue(q, (snap) => {
    const data = snap.val() || {};
    const list = Object.entries(data).map(([id, value]) => ({
      id,
      ...(value as ChatMessage),
    }));
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    cb(list);
  });
}

/**
 * Remove all chat messages for a room.
 * @param path Chat collection path prefix.
 * @param roomId Room id to clear.
 */
export async function clearChatMessages(path: string, roomId: string) {
  const db = getDb();
  if (!db || !roomId) return;
  await remove(ref(db, `${path}/${roomId}/messages`));
}
