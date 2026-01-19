import { get, onDisconnect, onValue, ref, remove, runTransaction, set, update } from "firebase/database";

import { getDb } from "@/firebase";

function rand4Digits() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function generateRoomId(path: string, tries = 200) {
  const db = getDb();
  if (!db) return "";

  const counterKey = path.replace(/[^A-Za-z0-9_]/g, "_");

  for (let i = 0; i < tries; i++) {
    const res = await runTransaction(ref(db, `roomCounters/${counterKey}`), (cur) => {
      if (typeof cur !== "number") return 0;
      return cur + 1;
    });

    if (!res.committed) continue;
    const seq = res.snapshot.val() || 0;
    const id = String(1000 + (seq % 9000));

    const snap = await get(ref(db, `${path}/${id}`));
    if (!snap.exists()) return id;
  }
  return "";
}

export async function createRoom(
  path: string,
  base: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  const db = getDb();
  if (!db) return "";
  const id = await generateRoomId(path);
  if (!id) return "";
  await set(ref(db, `${path}/${id}`), { ...base, ...extra });
  return id;
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
