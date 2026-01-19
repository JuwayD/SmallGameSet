// @ts-nocheck
import {
  get,
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
  update,
} from "firebase/database";
import { claimPlayer, cleanupIfAllLeft, createRoom as createRoomRecord, setupPresence, touchRoom } from "@/utils/room";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { getDb } from "@/firebase";

/** ================= Utils ================= */

const ROOM_TTL_MS = 1000 * 60 * 30;
const ROOM_HARD_TTL_MS = 1000 * 60 * 120;
const HEARTBEAT_MS = 1000 * 30;
const CLEANUP_INTERVAL_MS = 1000 * 60;

const HELP_TEXT = "目标：猜中对方密数。\n\n规则：\n- 创建房间后分享 4 位房间号，另一位加入。\n- 双方设置密数后开始对局，轮流猜测对方密数。\n- 猜中即胜，未加入无法开始。";

/**
 * Check that a string is exactly len digits.
 */
function isDigits(str: string, len: number) {
  return new RegExp(`^\\d{${len}}$`).test(str);
}

/**
 * Count exact-position hits for a guess.
 */
function hitsCount(secret: string, guess: string) {
  let hits = 0;
  for (let i = 0; i < secret.length; i++) {
    if(secret[i] == guess[i]){
      hits++
    }
  }
  return hits;
}

/** ================= UI ================= */

/**
 * Shared button component with variants.
 */
function Btn({ title, onPress, disabled, kind, small }: any) {
  return (
    <TouchableOpacity
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.btn,
        small && styles.btnSmall,
        kind === "danger" && styles.btnDanger,
        kind === "ghost" && styles.btnGhost,
        disabled && styles.btnDis,
      ]}
    >
      <Text style={[styles.btnText, kind === "ghost" && styles.btnTextGhost]}>
        {title}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Choice button used for toggles.
 */
function ChoiceBtn({ title, onPress, active }: any) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.choiceBtn, active && styles.choiceBtnActive]}
    >
      <Text style={[styles.choiceText, active && styles.choiceTextActive]}>
        {title}
      </Text>
    </TouchableOpacity>
  );
}

/** ================= Main ================= */

/**
 * Screen component for the guess-number game.
 */
export default function GuessNumber() {
  const [roomId, setRoomId] = useState("");
  const [joinId, setJoinId] = useState("");
  const [me, setMe] = useState<"A" | "B" | "">("");
  const [room, setRoom] = useState<any>(null);

  const [secret, setSecret] = useState("");
  const [guess, setGuess] = useState("");
  const [helpVisible, setHelpVisible] = useState(false);
  const navigation = useNavigation();
  const leavingRef = useRef(false);
  const disconnectRef = useRef<ReturnType<typeof onDisconnect> | null>(null);

  // 弹框
  const [digitsModal, setDigitsModal] = useState(false);
  const [starterModal, setStarterModal] = useState(false);

  const isHost = me === "A";
  const digits = room?.digits ?? 4;
  const starter = room?.starter ?? "A";
  const guesses = room?.guesses ?? [];

  const myTurn = useMemo(
    () => room?.status === "playing" && room?.turn === me,
    [room, me]
  );

  const canHostConfigure =
    isHost && (room?.status === "configuring" || room?.status === "over");

  /**
   * Reset local state when leaving or cleanup happens.
   */
  function resetLocal() {
    setRoomId("");
    setJoinId("");
    setMe("");
    setRoom(null);
    setSecret("");
    setGuess("");
    setDigitsModal(false);
    setStarterModal(false);
  }

  /** -------- 监听房间 -------- */
  useEffect(() => {
    if (!roomId) return;
    const db = getDb();
    if (!db) return;

    const r = ref(db, `rooms/${roomId}`);
    return onValue(r, (snap) => {
      const v = snap.val();
      if (!v) {
        setRoom(null);
        return;
      }
      // 兼容旧数据
      if (!Array.isArray(v.guesses)) v.guesses = [];
      if (v?.players?.A && v.players.A.left == null) v.players.A.left = false;
      if (v?.players?.B && v.players.B.left == null) v.players.B.left = true; // 未进入默认 true
      setRoom(v);
    });
  }, [roomId]);

    /** -------- 清理长时间闲置房间 -------- */
  useEffect(() => {
    const db = getDb();
    if (!db) return;

    const run = async () => {
      try {
        const snap = await get(ref(db, 'rooms'));
        const rooms = snap.val();
        if (!rooms) return;
        const now = Date.now();
        await Promise.all(
          Object.entries(rooms).map(async ([id, v]: any) => {
            const last = v?.lastActive ?? v?.createdAt ?? 0;
            if (!last) return;
            const age = now - last;
            const aLeft = v?.players?.A?.left ?? true;
            const bLeft = v?.players?.B?.left ?? true;
            if ((aLeft && bLeft) || (age > ROOM_TTL_MS && aLeft && bLeft) || age > ROOM_HARD_TTL_MS) {
              await remove(ref(db, `rooms/${id}`));
            }
          })
        );
      } catch {
        // ignore
      }
    };

    run();
    const timer = setInterval(run, CLEANUP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  /** -------- 断线自动离开（关键） -------- */
  useEffect(() => {
    if (!roomId || !me) return;
    const db = getDb();
    if (!db) return;

    const handler = setupPresence("rooms", roomId, me, { left: false }, { left: true, secret: "" });
    if (handler) disconnectRef.current = handler;

    return () => {
      handler?.cancel();
      if (disconnectRef.current === handler) {
        disconnectRef.current = null;
      }
    };
  }, [roomId, me]);

  /** -------- 心跳更新活跃时间 -------- */
  useEffect(() => {
    if (!roomId || !me) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await touchRoom("rooms", roomId);
    };
    tick();
    const timer = setInterval(tick, HEARTBEAT_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [roomId, me]);

  /** -------- 双方离开 => 自动删房 -------- */
  useEffect(() => {
    if (!roomId || !room) return;
    const aLeft = !!room?.players?.A?.left;
    const bLeft = !!room?.players?.B?.left;

    if (aLeft && bLeft) {
      const db = getDb();
      if (db) {
        disconnectRef.current?.cancel();
        disconnectRef.current = null;
        cleanupIfAllLeft("rooms", roomId, ["A", "B"]).catch(() => {});
      }
      resetLocal();
    }
  }, [roomId, room]);

  /** ================== Actions ================== */

  /** 创建房间：4位数字+避碰撞 */
  /**
   * Create a new room with default settings.
   */
  async function createRoom() {
    const base = {
      status: "configuring",
      digits: 4,
      starter: "A",
      turn: "",
      winner: "",
      round: 1,
      createdAt: Date.now(),
      lastActive: Date.now(),
      players: {
        A: { secret: "", left: false },
        B: { secret: "", left: true },
      },
      guesses: [],
    };

    const id = await createRoomRecord("rooms", base);
    if (!id) {
      alert("房间号生成失败");
      return;
    }

    setRoomId(id);
    setMe("A");
  }

  /** 加入房间：原子占位B（防多人/重复进入） */
  /**
   * Join a room as player B if available.
   */
  async function joinRoom() {
    const db = getDb();
    if (!db) return;

    const id = joinId.trim();
    if (!/^\d{4}$/.test(id)) {
      alert("房间号必须是4位数字");
      return;
    }

    // 先确认房间存在
    const roomSnap = await get(ref(db, `rooms/${id}`));
    if (!roomSnap.exists()) {
      alert("房间不存在");
      return;
    }

    // ✅ 修复点2：用 transaction 抢占 B
    const res = await runTransaction(
      ref(db, `rooms/${id}/players/B`),
      (cur) => {
        // 已被占用且在线（left=false） -> 拒绝
        if (cur && cur.left === false) return;
        // 否则占位成功
        return { secret: "", left: false, joinedAt: Date.now() };
      },
      { applyLocally: false }
    );

    if (!res.committed) {
      alert("房间已满（B 已被占用）");
      return;
    }

    await update(ref(db, `rooms/${id}`), { lastActive: Date.now() });
    setRoomId(id);
    setMe("B");
  }

  /** 仅设置自己的密数（明文只显示自己） */
  /**
   * Save the current player's secret.
   */
  async function confirmSecret() {
    const db = getDb();
    if (!db || !roomId || !me) return;

    if (!isDigits(secret, digits)) {
      alert(`密数必须是 ${digits} 位数字`);
      return;
    }

    await update(ref(db, `rooms/${roomId}/players/${me}`), {
      secret,
      left: false,
    });
    touchRoom("rooms", roomId);
  }

  /** 房主：设置位数（弹框） */
  /**
   * Host sets the digit length for this room.
   */
  async function applyDigits(n: number) {
    const db = getDb();
    if (!db || !isHost) return;
    await update(ref(db, `rooms/${roomId}`), { digits: n });
    setDigitsModal(false);
  }

  /** 房主：设置先手（弹框） */
  /**
   * Host sets which player starts the round.
   */
  async function applyStarter(s: "A" | "B") {
    const db = getDb();
    if (!db || !isHost) return;
    await update(ref(db, `rooms/${roomId}`), { starter: s });
    setStarterModal(false);
  }

  /** 房主：开始本轮 */
  /**
   * Start a round after both secrets are ready.
   */
  async function startRound() {
    const db = getDb();
    if (!db || !isHost) return;

    const a = room?.players?.A?.secret || "";
    const b = room?.players?.B?.secret || "";

    // 如果 B 根本没加入，b 会是 ""，自然无法开始
    if (!isDigits(a, digits) || !isDigits(b, digits)) {
      alert("双方必须先设置好本轮密数（B 需要先加入并设置）");
      return;
    }

    await update(ref(db, `rooms/${roomId}`), {
      status: "playing",
      turn: starter,
      winner: "",
    });
    touchRoom("rooms", roomId);
  }

  /** 提交猜测：transaction 追加历史，避免并发覆盖 */
  /**
   * Submit a guess and resolve win/turn logic.
   */
  async function submitGuess() {
    const db = getDb();
    if (!db || !myTurn) return;

    if (!isDigits(guess, digits)) {
      alert(`猜测必须是 ${digits} 位数字`);
      return;
    }

    const opp = me === "A" ? "B" : "A";
    const oppSecret = room?.players?.[opp]?.secret || "";
    if (!oppSecret) {
      alert("对方还没设置密数");
      return;
    }

    const hits = hitsCount(oppSecret, guess);
    const record = { by: me, guess, hits, at: Date.now(), round: room?.round || 1 };

    await runTransaction(ref(db, `rooms/${roomId}/guesses`), (cur) => {
      const arr = Array.isArray(cur) ? cur : [];
      arr.push(record);
      return arr;
    });
    touchRoom("rooms", roomId);

    if (guess === oppSecret) {
      await update(ref(db, `rooms/${roomId}`), {
        status: "over",
        winner: me,
      });
      return;
    }

    await update(ref(db, `rooms/${roomId}`), { turn: opp });
    setGuess("");
  }

  /** 结束后重开新一轮 */
  /**
   * Reset room state for a new round.
   */
  async function restartNewRound() {
    const db = getDb();
    if (!db || !roomId) return;

    await runTransaction(ref(db, `rooms/${roomId}`), (cur) => {
      if (!cur) return cur;

      const nextRound = (cur.round || 1) + 1;
      cur.status = "configuring";
      cur.turn = "";
      cur.winner = "";
      cur.guesses = [];
      cur.round = nextRound;

      // 强制重新设密数（公平）
      if (cur.players?.A) cur.players.A.secret = "";
      if (cur.players?.B) cur.players.B.secret = "";

      // left 不改：离开的还是离开
      return cur;
    });

    setSecret("");
    setGuess("");
    touchRoom("rooms", roomId);
  }

  /** 退房：标记 left=true；监听会处理删房 */
  /**
   * Leave the room and cleanup presence.
   */
  async function leaveRoom() {
    const db = getDb();
    if (!db || !roomId || !me) {
      resetLocal();
      return;
    }

    await update(ref(db, `rooms/${roomId}/players/${me}`), {
      left: true,
      secret: "",
    });

    disconnectRef.current?.cancel();
    disconnectRef.current = null;

    await cleanupIfAllLeft("rooms", roomId, ["A", "B"]).catch(() => {});

    resetLocal();
  }

  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e) => {
      if (leavingRef.current || !roomId || !me) return;
      e.preventDefault();
      leavingRef.current = true;
      Promise.resolve(leaveRoom())
        .catch(() => {})
        .finally(() => {
          navigation.dispatch(e.data.action);
        });
    });

    return sub;
  }, [navigation, roomId, me]);

  /** ================== Render ================== */

  return (
    <ScrollView style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>联机猜数</Text>
        <TouchableOpacity style={styles.helpBtn} onPress={() => setHelpVisible(true)}>
          <Text style={styles.helpBtnText}>帮助</Text>
        </TouchableOpacity>
      </View>

      {!roomId && (
        <View style={styles.card}>
          <Btn title="创建房间（4位数字）" onPress={createRoom} />
          <TextInput
            style={styles.input}
            placeholder="输入4位房间号加入"
            value={joinId}
            onChangeText={setJoinId}
            keyboardType="number-pad"
            maxLength={4}
          />
          <Btn title="加入房间" onPress={joinRoom} disabled={!joinId.trim()} />
        </View>
      )}

      {roomId && room && (
        <View style={styles.card}>
          <Text style={styles.line}>房间：{roomId}</Text>
          <Text style={styles.line}>你是：{me}</Text>
          <Text style={styles.line}>
            状态：{room.status}（第 {room.round || 1} 轮）
          </Text>
          <Text style={styles.line}>
            本轮位数：{digits} / 先手：{starter} / 当前回合：{room.turn || "-"}
          </Text>

          <View style={styles.hr} />

          {/* 只显示自己的密数 */}
          <Text style={styles.h}>你的密数（明文，仅你可见）</Text>
          <Text style={styles.line}>
            {room?.players?.[me]?.secret ? room.players[me].secret : "(未设置)"}
          </Text>

          <TextInput
            style={styles.input}
            placeholder={`设置 ${digits} 位密数`}
            value={secret}
            onChangeText={setSecret}
            keyboardType="number-pad"
            maxLength={digits}
          />
          <Btn title="确认密数" onPress={confirmSecret} disabled={!secret} />

          {/* 房主配置 */}
          {canHostConfigure && (
            <>
              <View style={styles.hr} />
              <Text style={styles.h}>本轮设置（房主）</Text>

              <View style={styles.row}>
                <Btn
                  small
                  kind="ghost"
                  title={`位数：${digits}（点我改）`}
                  onPress={() => setDigitsModal(true)}
                />
                <Btn
                  small
                  kind="ghost"
                  title={`先手：${starter}（点我改）`}
                  onPress={() => setStarterModal(true)}
                />
              </View>

              <Btn
                title="开始本轮"
                onPress={startRound}
                disabled={room.status !== "configuring"}
              />

              {room.status === "over" && (
                <Btn title="重新开始新一轮" onPress={restartNewRound} />
              )}
            </>
          )}

          {/* playing：回合输入 */}
          {room.status === "playing" && (
            <>
              <View style={styles.hr} />
              <Text style={styles.h}>猜测</Text>
              <Text style={styles.tip}>{myTurn ? "✅ 轮到你" : "⏳ 等待对方"}</Text>

              <TextInput
                style={styles.input}
                placeholder={`输入你的猜测（${digits}位）`}
                value={guess}
                onChangeText={setGuess}
                keyboardType="number-pad"
                maxLength={digits}
              />
              <Btn
                title="提交猜测"
                onPress={submitGuess}
                disabled={!myTurn || !guess}
              />
            </>
          )}

          {/* 历史 */}
          <View style={styles.hr} />
          <Text style={styles.h}>猜测历史</Text>
          {guesses.length === 0 ? (
            <Text style={styles.tip}>(暂无)</Text>
          ) : (
            guesses.map((g: any, i: number) => (
              <Text key={i} style={styles.history}>
                #{i + 1}（第{g.round || 1}轮） 玩家 {g.by} 猜 {g.guess} → 命中 {g.hits}
              </Text>
            ))
          )}

          {/* 结束 */}
          {room.status === "over" && (
            <>
              <View style={styles.hr} />
              <Text style={styles.win}>🏆 胜者：{room.winner}</Text>
              {!canHostConfigure && (
                <Btn title="重新开始新一轮" onPress={restartNewRound} />
              )}
            </>
          )}

          <View style={styles.hr} />
          <Btn title="退房间" kind="danger" onPress={leaveRoom} />
          <Text style={styles.tip}>
            B 未加入时默认 left=true；加入房间使用原子占位，房间满会加入失败；断线会自动 left=true；
            当 A 和 B 都离开时会自动删除房间。
          </Text>
        </View>
      )}

      {/* 位数弹框 */}
      <Modal
        transparent
        visible={digitsModal}
        animationType="fade"
        onRequestClose={() => setDigitsModal(false)}
      >
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>选择本轮位数</Text>
            <View style={styles.choiceGrid}>
              {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                <ChoiceBtn
                  key={n}
                  title={`${n} 位`}
                  active={digits === n}
                  onPress={() => applyDigits(n)}
                />
              ))}
            </View>
            <Btn title="取消" kind="ghost" onPress={() => setDigitsModal(false)} />
          </View>
        </View>
      </Modal>

      {/* 规则弹框 */}
      <Modal
        transparent
        visible={helpVisible}
        animationType="fade"
        onRequestClose={() => setHelpVisible(false)}
      >
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>游戏规则</Text>
            <Text style={styles.helpText}>{HELP_TEXT}</Text>
            <Btn title="关闭" kind="ghost" onPress={() => setHelpVisible(false)} />
          </View>
        </View>
      </Modal>

      {/* 先手弹框 */}
      <Modal
        transparent
        visible={starterModal}
        animationType="fade"
        onRequestClose={() => setStarterModal(false)}
      >
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>选择本轮先手</Text>
            <View style={styles.choiceRow}>
              <ChoiceBtn
                title="A 先"
                active={starter === "A"}
                onPress={() => applyStarter("A")}
              />
              <ChoiceBtn
                title="B 先"
                active={starter === "B"}
                onPress={() => applyStarter("B")}
              />
            </View>
            <Btn title="取消" kind="ghost" onPress={() => setStarterModal(false)} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

/** ================= Styles ================= */

const styles = StyleSheet.create({
  root: { backgroundColor: "#111", padding: 16, flex: 1 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: "#fff", fontSize: 20, fontWeight: "800" },
  helpBtn: { backgroundColor: "#2a2a2a", borderWidth: 1, borderColor: "#3a3a3a", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  helpBtnText: { color: "#ddd", fontWeight: "700", fontSize: 12 },
  card: { backgroundColor: "#1b1b1b", padding: 14, borderRadius: 12, gap: 10 },
  input: {
    backgroundColor: "#2a2a2a",
    color: "#fff",
    padding: 10,
    borderRadius: 8,
  },
  btn: { backgroundColor: "#2563eb", padding: 12, borderRadius: 10 },
  btnSmall: { paddingVertical: 10, paddingHorizontal: 12, flex: 1 },
  btnDanger: { backgroundColor: "#dc2626" },
  btnGhost: { backgroundColor: "#2a2a2a", borderWidth: 1, borderColor: "#3a3a3a" },
  btnDis: { opacity: 0.4 },
  btnText: { color: "#fff", fontWeight: "700", textAlign: "center" },
  btnTextGhost: { color: "#ddd" },

  line: { color: "#ddd" },
  h: { color: "#fff", fontWeight: "700", marginTop: 6 },
  tip: { color: "#aaa" },
  history: { color: "#ccc" },
  win: { color: "#7CFF9A", fontSize: 18, fontWeight: "800" },
  hr: { height: 1, backgroundColor: "#333", marginVertical: 8 },
  row: { flexDirection: "row", gap: 10 },

  modalMask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#1b1b1b",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#2a2a2a",
    gap: 12,
  },
  modalTitle: { color: "#fff", fontWeight: "800", fontSize: 16 },
  helpText: { color: "#ddd", lineHeight: 22 },
  choiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  choiceRow: { flexDirection: "row", gap: 10 },

  choiceBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#2a2a2a",
    borderWidth: 1,
    borderColor: "#3a3a3a",
    minWidth: 78,
    alignItems: "center",
  },
  choiceBtnActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  choiceText: { color: "#ddd", fontWeight: "700" },
  choiceTextActive: { color: "#fff" },
});



