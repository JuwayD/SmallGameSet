import { get, onDisconnect, onValue, ref, remove, runTransaction, update } from "firebase/database";

import { getDb } from "@/firebase";

function rand4Digits() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function generateRoomId(path: string, tries = 30) {
  const db = getDb();
  if (!db) return "";

  for (let i = 0; i < tries; i++) {
    const id = rand4Digits();
    const snap = await get(ref(db, `${path}/${id}`));
    if (!snap.exists()) return id;
  }
  return "";
}

export function subscribeRoom(path: string, roomId: string, cb: (value: any) => void) {
  const db = getDb();
  if (!db || !roomId) return null;
  return onValue(ref(db, `${path}/${roomId}`), (snap) => cb(snap.val()));
}

export function setupPresence(
  path: string,
  roomId: string,
  playerKey: string,
  onlinePayload: Record<string, unknown>,
  offlinePayload: Record<string, unknown>
) {
  const db = getDb();
  if (!db || !roomId || !playerKey) return null;
  const playerRef = ref(db, `${path}/${roomId}/players/${playerKey}`);
  const handler = onDisconnect(playerRef);
  handler.update(offlinePayload);
  update(playerRef, onlinePayload);
  return handler;
}

export async function claimPlayer(
  path: string,
  roomId: string,
  playerKey: string,
  payload: Record<string, unknown>
) {
  const db = getDb();
  if (!db || !roomId || !playerKey) return false;
  const res = await runTransaction(
    ref(db, `${path}/${roomId}/players/${playerKey}`),
    (cur) => {
      if (cur && cur.left === false) return;
      return payload;
    },
    { applyLocally: false }
  );
  return !!res.committed;
}

export async function touchRoom(path: string, roomId: string) {
  const db = getDb();
  if (!db || !roomId) return;
  try {
    await update(ref(db, `${path}/${roomId}`), { lastActive: Date.now() });
  } catch {
    // ignore
  }
}

export async function cleanupIfAllLeft(path: string, roomId: string, playerKeys: string[]) {
  const db = getDb();
  if (!db || !roomId) return false;
  try {
    const snap = await get(ref(db, `${path}/${roomId}`));
    const v = snap.val();
    if (!v) return true;
    const allLeft = playerKeys.every((key) => v?.players?.[key]?.left);
    if (allLeft) {
      await remove(ref(db, `${path}/${roomId}`));
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}
