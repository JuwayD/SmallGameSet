import { get, onDisconnect, onValue, ref, remove, runTransaction, set, update } from "firebase/database";

import { getDb } from "@/firebase";

// Generate a 4-digit string for fallback usage.
function rand4Digits() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * Allocate a 4-digit room id using a shared counter to reduce collisions.
 * @param path Firebase path prefix for the room collection.
 * @param tries Max attempts before giving up.
 * @returns The allocated room id, or an empty string on failure.
 */
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

/**
 * Create a room record with optional extra data merged into the base.
 * @param path Firebase path prefix for the room collection.
 * @param base Base payload for the room.
 * @param extra Optional custom data to merge.
 * @returns The created room id, or an empty string on failure.
 */
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

/**
 * Subscribe to a room and receive updates.
 * @param path Firebase path prefix for the room collection.
 * @param roomId Room id to subscribe to.
 * @param cb Callback invoked with the room value.
 * @returns The unsubscribe function or null if subscription fails.
 */
export function subscribeRoom(path: string, roomId: string, cb: (value: any) => void) {
  const db = getDb();
  if (!db || !roomId) return null;
  return onValue(ref(db, `${path}/${roomId}`), (snap) => cb(snap.val()));
}

/**
 * Track player presence and mark offline on disconnect.
 * @param path Firebase path prefix for the room collection.
 * @param roomId Room id to update.
 * @param playerKey Player key (slot).
 * @param onlinePayload Data written when online.
 * @param offlinePayload Data written on disconnect.
 * @returns The onDisconnect handler or null if not available.
 */
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

/**
 * Atomically claim a player slot if it is free or left.
 * @param path Firebase path prefix for the room collection.
 * @param roomId Room id to update.
 * @param playerKey Player key (slot).
 * @param payload Data to write into the player slot.
 * @returns True when the slot is claimed successfully.
 */
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

/**
 * Refresh lastActive timestamp to keep the room alive.
 * @param path Firebase path prefix for the room collection.
 * @param roomId Room id to update.
 */
export async function touchRoom(path: string, roomId: string) {
  const db = getDb();
  if (!db || !roomId) return;
  try {
    await update(ref(db, `${path}/${roomId}`), { lastActive: Date.now() });
  } catch {
    // ignore
  }
}

/**
 * Delete the room when all provided player slots are marked left.
 * @param path Firebase path prefix for the room collection.
 * @param roomId Room id to check.
 * @param playerKeys Player slots that must all be left.
 * @returns True when the room is removed or missing.
 */
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
