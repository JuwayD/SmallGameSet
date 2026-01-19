import { useNavigation } from '@react-navigation/native';
import {
  get,
  onValue,
  ref,
  runTransaction,
  set,
  update,
} from 'firebase/database';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { getDb } from '@/firebase';
import { claimPlayer, cleanupIfAllLeft, createRoom as createRoomRecord, setupPresence, touchRoom } from '@/utils/room';

const HELP_TEXT = `庄家模式：
- 一名玩家坐庄，设置场地（大方块/圆盘）并放置任意数量旗子。
- 庄家指定若干旗子下有地雷。
- 猜方依次选择安全旗，猜对得分，踩雷结束本轮。
- 入场积分与猜对积分由庄家设定。

双人PK：
- 双方各自布置旗子与地雷，确认后开始轮流猜对方旗子。
- 一人猜一手交替，猜对得分，踩雷结束本轮。
- 双方互付入场积分，累计积分决胜。`;

const MAX_FLAGS = 100;
const MIN_GRID = 4;
const MAX_GRID = 12;

const merge = (...styles: any[]) => StyleSheet.flatten(styles);

function clampNumber(value: string, min: number, max: number, fallback: number) {
  const n = Number(value.replace(/\D/g, ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export default function MineGuessScreen() {
  const navigation = useNavigation();
  const [helpVisible, setHelpVisible] = useState(false);
  const [gridModalVisible, setGridModalVisible] = useState(false);
  const [gridWidthDraft, setGridWidthDraft] = useState('');
  const [gridHeightDraft, setGridHeightDraft] = useState('');
  const [roomMode, setRoomMode] = useState<'house' | 'pk'>('house');

  const [roomId, setRoomId] = useState('');
  const [joinId, setJoinId] = useState('');
  const [me, setMe] = useState<'host' | 'player' | 'A' | 'B' | ''>('');
  const [room, setRoom] = useState<any>(null);

  const [editMode, setEditMode] = useState<'place' | 'mine' | 'delete'>('place');

  const disconnectRef = useRef<ReturnType<typeof setupPresence> | null>(null);
  const leavingRef = useRef(false);

  const currentMode = room?.mode ?? roomMode;
  const isPk = currentMode === 'pk';
  const isHouse = !isPk;

  const gridWidth = room?.gridWidth ?? 8;
  const gridHeight = room?.gridHeight ?? 8;
  const flags = room?.flags ?? [];
  const guessed = room?.guessed ?? [];
  const status = room?.status ?? 'setup';
  const round = room?.round ?? 1;
  const entryFee = room?.entryFee ?? 2;
  const hitScore = room?.hitScore ?? 1;
  const scores = room?.scores ?? (isPk ? { A: 0, B: 0 } : { host: 0, player: 0 });

  const pkSide = isPk && (me === 'A' || me === 'B') ? me : '';
  const pkOpp = pkSide === 'A' ? 'B' : pkSide === 'B' ? 'A' : '';
  const pkFields = room?.fields ?? {};
  const pkMyField = pkSide
    ? pkFields[pkSide] ?? { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false }
    : { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false };
  const pkOppField = pkOpp
    ? pkFields[pkOpp] ?? { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false }
    : { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false };
  const pkGuessed = room?.guessed?.[pkSide] ?? [];
  const pkTurn = room?.turn ?? 'A';

  const isHost = isHouse && me === 'host';

  const displayField = isPk
    ? status === 'setup'
      ? pkMyField
      : pkOppField
    : { gridWidth, gridHeight, flags };
  const displayGridWidth = displayField.gridWidth ?? gridWidth;
  const displayGridHeight = displayField.gridHeight ?? gridHeight;
  const displayFlags = Array.isArray(displayField.flags) ? displayField.flags : [];
  const displayGuessed = isPk ? (status === 'setup' ? [] : pkGuessed) : guessed;

  const displaySafeTotal = useMemo(() => {
    const mineCount = displayFlags.filter((f: any) => f.mine).length;
    return Math.max(0, displayFlags.length - mineCount);
  }, [displayFlags]);

  const displaySafeLeft = useMemo(() => {
    const safeGuessed = displayGuessed.filter((id: string) => {
      const f = displayFlags.find((ff: any) => ff.id === id);
      return f && !f.mine;
    }).length;
    return Math.max(0, displaySafeTotal - safeGuessed);
  }, [displayFlags, displayGuessed, displaySafeTotal]);

  const statusText = useMemo(() => {
    if (!roomId) return '请创建或加入房间。';
    if (isPk) {
      if (status === 'setup') {
        if (!pkSide) return '请选择你的对战位置。';
        return pkMyField.confirmed ? '等待对方确认布雷。' : '请布置你的场地并确认。';
      }
      if (status === 'playing') {
        return pkTurn === pkSide ? '轮到你猜对方旗子。' : '等待对方出手。';
      }
      return room?.result || '本轮结束。';
    }
    if (status === 'setup') return '庄家摆旗中，准备开始。';
    if (status === 'playing') return me === 'player' ? '轮到你猜旗。' : '等待猜手选择旗子。';
    return room?.result || '本轮结束。';
  }, [roomId, status, me, room, isPk, pkSide, pkTurn, pkMyField]);

  const openGridModal = () => {
    setGridWidthDraft(String(displayGridWidth));
    setGridHeightDraft(String(displayGridHeight));
    setGridModalVisible(true);
  };

  const confirmGridModal = () => {
    handleGridWidth(gridWidthDraft);
    handleGridHeight(gridHeightDraft);
    setGridModalVisible(false);
  };

  function resetLocal() {
    setRoomId('');
    setJoinId('');
    setMe('');
    setRoom(null);
    setEditMode('place');
  }

  useEffect(() => {
    if (!roomId) return;
    const db = getDb();
    if (!db) return;

    const r = ref(db, `mineRooms/${roomId}`);
    return onValue(r, (snap) => {
      const v = snap.val();
      if (!v) {
        setRoom(null);
        return;
      }
      if (v?.mode === 'pk') {
        if (!v.fields) {
          v.fields = {
            A: { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false },
            B: { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false },
          };
        }
        if (!Array.isArray(v.fields?.A?.flags)) v.fields.A.flags = [];
        if (!Array.isArray(v.fields?.B?.flags)) v.fields.B.flags = [];
        if (!v.guessed) v.guessed = { A: [], B: [] };
        if (!Array.isArray(v.guessed?.A)) v.guessed.A = [];
        if (!Array.isArray(v.guessed?.B)) v.guessed.B = [];
        if (v?.players?.A && v.players.A.left == null) v.players.A.left = false;
        if (v?.players?.B && v.players.B.left == null) v.players.B.left = true;
      } else {
        if (!Array.isArray(v.flags)) v.flags = [];
        if (!Array.isArray(v.guessed)) v.guessed = [];
        if (v?.players?.host && v.players.host.left == null) v.players.host.left = false;
        if (v?.players?.player && v.players.player.left == null) v.players.player.left = true;
      }
      setRoom(v);
      if (v?.mode) setRoomMode(v.mode === 'pk' ? 'pk' : 'house');
    });
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !me) return;
    const db = getDb();
    if (!db) return;

    const handler = setupPresence('mineRooms', roomId, me, { left: false }, { left: true });
    if (handler) disconnectRef.current = handler;

    return () => {
      handler?.cancel();
      if (disconnectRef.current === handler) {
        disconnectRef.current = null;
      }
    };
  }, [roomId, me]);

  useEffect(() => {
    if (!roomId || !room) return;
    const keys = room?.mode === 'pk' ? ['A', 'B'] : ['host', 'player'];
    const leftA = !!room?.players?.[keys[0]]?.left;
    const leftB = !!room?.players?.[keys[1]]?.left;
    if (leftA && leftB) {
      const db = getDb();
      if (db) {
        disconnectRef.current?.cancel();
        disconnectRef.current = null;
        cleanupIfAllLeft('mineRooms', roomId, keys).catch(() => {});
      }
      resetLocal();
    }
  }, [roomId, room]);

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

  useEffect(() => {
    if (!roomId || !room || room?.mode !== 'pk') return;
    if (room.status !== 'setup') return;
    if (!room.fields?.A?.confirmed || !room.fields?.B?.confirmed) return;
    if (me !== 'A') return;
    updateRoom({ status: 'playing', guessed: { A: [], B: [] }, result: '', turn: 'A' });
  }, [roomId, room, me]);

  async function createRoom() {
    if (!me) {
      alert('请先选择身份');
      return;
    }

    const base = {
      status: 'setup',
      entryFee: 2,
      hitScore: 1,
      round: 1,
      createdAt: Date.now(),
      lastActive: Date.now(),
      result: '',
    };

    const payload =
      roomMode === 'pk'
        ? {
            ...base,
            mode: 'pk',
            turn: 'A',
            players: {
              A: { left: me !== 'A' },
              B: { left: me !== 'B' },
            },
            fields: {
              A: { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false },
              B: { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false },
            },
            guessed: { A: [], B: [] },
            scores: { A: 0, B: 0 },
          }
        : {
            ...base,
            mode: 'house',
            gridWidth: 8,
            gridHeight: 8,
            players: {
              host: { left: me !== 'host' },
              player: { left: me !== 'player' },
            },
            flags: [],
            guessed: [],
            scores: { host: 0, player: 0 },
          };

    const id = await createRoomRecord('mineRooms', payload);
    if (!id) {
      alert('房间号生成失败');
      return;
    }

    setRoomId(id);
    setMe(me);
  }

  async function joinRoom() {
    const db = getDb();
    if (!db) return;
    if (!me) {
      alert('请先选择身份');
      return;
    }

    const id = joinId.trim();
    if (!/^[0-9]{4}$/.test(id)) {
      alert('房间号必须是4位数字');
      return;
    }

    const roomSnap = await get(ref(db, `mineRooms/${id}`));
    if (!roomSnap.exists()) {
      alert('房间不存在');
      return;
    }

    const remote = roomSnap.val();
    const remoteMode = remote?.mode === 'pk' ? 'pk' : 'house';
    if (remoteMode === 'pk' && !(me === 'A' || me === 'B')) {
      alert('该房间为双人PK，请选择 A 或 B');
      return;
    }
    if (remoteMode === 'house' && !(me === 'host' || me === 'player')) {
      alert('该房间为庄家模式，请选择庄家或猜手');
      return;
    }

    const ok = await claimPlayer('mineRooms', id, me, {
      left: false,
      joinedAt: Date.now(),
    });

    if (!ok) {
      alert(`${me === 'host' ? '庄家' : me === 'player' ? '猜手' : me}已被占用`);
      return;
    }

    await touchRoom('mineRooms', id);
    setRoomMode(remoteMode);
    setRoomId(id);
    setMe(me);
  }

  async function leaveRoom() {
    const db = getDb();
    if (!db || !roomId || !me) {
      resetLocal();
      return;
    }

    await update(ref(db, `mineRooms/${roomId}/players/${me}`), { left: true });

    disconnectRef.current?.cancel();
    disconnectRef.current = null;

    await cleanupIfAllLeft('mineRooms', roomId, room?.mode === 'pk' ? ['A', 'B'] : ['host', 'player']).catch(() => {});

    resetLocal();
  }

  async function updateRoom(patch: any) {
    const db = getDb();
    if (!db || !roomId) return;
    await update(ref(db, `mineRooms/${roomId}`), { ...patch, lastActive: Date.now() });
  }

  const canConfigureHouse = isHost && status === 'setup';
  const canConfigurePk = isPk && status === 'setup' && pkSide && !pkMyField.confirmed;
  const canConfigure = isHouse ? canConfigureHouse : canConfigurePk;

  const updatePkField = (patch: any) => {
    if (!pkSide) return;
    updateRoom({ fields: { ...pkFields, [pkSide]: { ...pkMyField, ...patch } } });
  };

  const handleGridWidth = (value: string) => {
    if (isHouse) {
      if (!canConfigureHouse) return;
      const next = clampNumber(value, MIN_GRID, MAX_GRID, gridWidth);
      updateRoom({ gridWidth: next, flags: [], guessed: [], result: '', status: 'setup' });
      return;
    }
    if (!canConfigurePk) return;
    const next = clampNumber(value, MIN_GRID, MAX_GRID, pkMyField.gridWidth || 8);
    updatePkField({ gridWidth: next, flags: [], confirmed: false });
  };

  const handleGridHeight = (value: string) => {
    if (isHouse) {
      if (!canConfigureHouse) return;
      const next = clampNumber(value, MIN_GRID, MAX_GRID, gridHeight);
      updateRoom({ gridHeight: next, flags: [], guessed: [], result: '', status: 'setup' });
      return;
    }
    if (!canConfigurePk) return;
    const next = clampNumber(value, MIN_GRID, MAX_GRID, pkMyField.gridHeight || 8);
    updatePkField({ gridHeight: next, flags: [], confirmed: false });
  };

  const handleEntryFee = (value: string) => {
    if (isHouse && !canConfigureHouse) return;
    if (isPk && (!pkSide || status !== 'setup')) return;
    updateRoom({ entryFee: clampNumber(value, 0, 999, entryFee) });
  };

  const handleHitScore = (value: string) => {
    if (isHouse && !canConfigureHouse) return;
    if (isPk && (!pkSide || status !== 'setup')) return;
    updateRoom({ hitScore: clampNumber(value, 0, 999, hitScore) });
  };

  const handleHouseCellPress = (x: number, y: number) => {
    if (!roomId) return;
    const key = `${x}-${y}`;
    const existing = flags.find((f: any) => f.id === key);

    if (isHost) {
      if (!canConfigureHouse) return;
      if (editMode === 'place') {
        if (existing) return;
        if (flags.length >= Math.min(MAX_FLAGS, gridWidth * gridHeight)) return;
        updateRoom({ flags: [...flags, { id: key, x, y, mine: false }] });
        return;
      }
      if (!existing) return;
      if (editMode === 'mine') {
        const next = flags.map((f: any) => (f.id === key ? { ...f, mine: !f.mine } : f));
        updateRoom({ flags: next });
        return;
      }
      if (editMode === 'delete') {
        const next = flags.filter((f: any) => f.id !== key);
        updateRoom({ flags: next });
        return;
      }
      return;
    }

    if (me !== 'player' || status !== 'playing') return;
    if (!existing) return;
    if (guessed.includes(existing.id)) return;

    const db = getDb();
    if (!db) return;

    runTransaction(ref(db, `mineRooms/${roomId}`), (cur) => {
      if (!cur || cur.status !== 'playing') return cur;
      const curFlags = Array.isArray(cur.flags) ? cur.flags : [];
      const curGuessed = Array.isArray(cur.guessed) ? cur.guessed : [];
      if (curGuessed.includes(existing.id)) return cur;

      const flag = curFlags.find((f: any) => f.id === existing.id);
      if (!flag) return cur;

      const nextGuessed = [...curGuessed, flag.id];
      const nextScores = { ...(cur.scores || { host: 0, player: 0 }) };

      if (flag.mine) {
        cur.status = 'over';
        cur.result = '踩雷！本轮结束。';
      } else {
        nextScores.player = (nextScores.player || 0) + (cur.hitScore || 0);
        nextScores.host = (nextScores.host || 0) - (cur.hitScore || 0);
        const mineCountLocal = curFlags.filter((f: any) => f.mine).length;
        const safeTotalLocal = Math.max(0, curFlags.length - mineCountLocal);
        const safeLeft = safeTotalLocal - nextGuessed.filter((id: string) => {
          const f = curFlags.find((ff: any) => ff.id === id);
          return f && !f.mine;
        }).length;
        if (safeLeft <= 0) {
          cur.status = 'over';
          cur.result = '安全旗全部猜中，本轮结束。';
        }
      }

      cur.guessed = nextGuessed;
      cur.scores = nextScores;
      cur.lastActive = Date.now();
      return cur;
    });
  };

  const handlePkCellPress = (x: number, y: number) => {
    if (!roomId || !pkSide) return;
    const key = `${x}-${y}`;

    if (status === 'setup') {
      if (!canConfigurePk) return;
      const existing = pkMyField.flags.find((f: any) => f.id === key);

      if (editMode === 'place') {
        if (existing) return;
        if (pkMyField.flags.length >= Math.min(MAX_FLAGS, pkMyField.gridWidth * pkMyField.gridHeight)) return;
        updatePkField({ flags: [...pkMyField.flags, { id: key, x, y, mine: false }] });
        return;
      }
      if (!existing) return;
      if (editMode === 'mine') {
        const next = pkMyField.flags.map((f: any) => (f.id === key ? { ...f, mine: !f.mine } : f));
        updatePkField({ flags: next });
        return;
      }
      if (editMode === 'delete') {
        const next = pkMyField.flags.filter((f: any) => f.id !== key);
        updatePkField({ flags: next });
        return;
      }
      return;
    }

    if (status !== 'playing') return;
    if (pkTurn !== pkSide) return;

    const existing = pkOppField.flags.find((f: any) => f.id === key);
    if (!existing) return;
    if (pkGuessed.includes(existing.id)) return;

    const db = getDb();
    if (!db) return;

    const side = pkSide;
    const opp = pkOpp;

    runTransaction(ref(db, `mineRooms/${roomId}`), (cur) => {
      if (!cur || cur.status !== 'playing' || cur.mode !== 'pk') return cur;
      if (cur.turn !== side) return cur;
      const curFields = cur.fields || {};
      const oppField = curFields[opp] || { flags: [] };
      const curFlags = Array.isArray(oppField.flags) ? oppField.flags : [];
      const curGuessed = Array.isArray(cur.guessed?.[side]) ? cur.guessed[side] : [];
      if (curGuessed.includes(existing.id)) return cur;

      const flag = curFlags.find((f: any) => f.id === existing.id);
      if (!flag) return cur;

      const nextGuessed = [...curGuessed, flag.id];
      const nextScores = { ...(cur.scores || { A: 0, B: 0 }) };

      if (flag.mine) {
        cur.status = 'over';
        cur.result = `${side}踩雷，${opp}获胜。`;
      } else {
        nextScores[side] = (nextScores[side] || 0) + (cur.hitScore || 0);
        nextScores[opp] = (nextScores[opp] || 0) - (cur.hitScore || 0);
        const mineCountLocal = curFlags.filter((f: any) => f.mine).length;
        const safeTotalLocal = Math.max(0, curFlags.length - mineCountLocal);
        const safeGuessed = nextGuessed.filter((id: string) => {
          const f = curFlags.find((ff: any) => ff.id === id);
          return f && !f.mine;
        }).length;
        if (safeGuessed >= safeTotalLocal) {
          cur.status = 'over';
          cur.result = '安全旗全部猜中，本轮结束。';
        } else {
          cur.turn = opp;
        }
      }

      cur.guessed = { ...(cur.guessed || {}), [side]: nextGuessed };
      cur.scores = nextScores;
      cur.lastActive = Date.now();
      return cur;
    });
  };

  const handleCellPress = (x: number, y: number) => {
    if (isPk) {
      handlePkCellPress(x, y);
      return;
    }
    handleHouseCellPress(x, y);
  };

  const startRound = () => {
    if (!canConfigureHouse) return;
    const mineCount = flags.filter((f: any) => f.mine).length;
    if (flags.length === 0) {
      alert('请先插旗子。');
      return;
    }
    if (mineCount === 0) {
      alert('请至少设置一个地雷。');
      return;
    }
    const nextScores = {
      host: (scores.host || 0) + entryFee,
      player: (scores.player || 0) - entryFee,
    };
    updateRoom({ status: 'playing', guessed: [], scores: nextScores, result: '' });
  };

  const resetRound = () => {
    if (!isHost) return;
    updateRoom({
      status: 'setup',
      flags: [],
      guessed: [],
      round: round + 1,
      result: '',
    });
  };

  const confirmPkField = () => {
    if (!canConfigurePk) return;
    const mineCount = pkMyField.flags.filter((f: any) => f.mine).length;
    if (pkMyField.flags.length === 0) {
      alert('请先插旗子。');
      return;
    }
    if (mineCount === 0) {
      alert('请至少设置一个地雷。');
      return;
    }
    updatePkField({ confirmed: true });
  };

  const resetPkField = () => {
    if (!pkSide || status !== 'setup') return;
    updatePkField({ flags: [], confirmed: false });
  };

  const resetPkRound = () => {
    if (!pkSide) return;
    updateRoom({
      status: 'setup',
      round: round + 1,
      result: '',
      turn: 'A',
      guessed: { A: [], B: [] },
      fields: {
        ...pkFields,
        A: { ...(pkFields?.A || { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false }), confirmed: false },
        B: { ...(pkFields?.B || { gridWidth: 8, gridHeight: 8, flags: [], confirmed: false }), confirmed: false },
      },
    });
  };

  const renderCell = (x: number, y: number) => {
    const key = `${x}-${y}`;
    const flag = displayFlags.find((f: any) => f.id === key);
    const isMine = flag?.mine;
    const isGuessed = displayGuessed.includes(key);
    const showMine = isHouse ? isHost || status === 'over' : status !== 'playing';

    let label = '';
    if (flag) {
      if (isGuessed) {
        label = isMine ? '雷' : '安';
      } else {
        label = '旗';
      }
    }

    return (
      <TouchableOpacity
        key={key}
        style={merge(
          styles.cell,
          flag && styles.cellFlag,
          showMine && isMine && styles.cellMine,
          isGuessed && styles.cellGuessed
        )}
        onPress={() => handleCellPress(x, y)}
      >
        <Text style={styles.cellText}>{label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>猜地雷</Text>
        <TouchableOpacity style={styles.helpBtn} onPress={() => setHelpVisible(true)}>
          <Text style={styles.helpBtnText}>帮助</Text>
        </TouchableOpacity>
      </View>

      {!roomId && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>选择模式</Text>
          <View style={styles.roleRow}>
            <TouchableOpacity
              style={merge(styles.roleBtn, roomMode === 'house' && styles.roleBtnActive)}
              onPress={() => {
                setRoomMode('house');
                setMe('');
              }}
            >
              <Text style={merge(styles.roleText, roomMode === 'house' && styles.roleTextActive)}>庄家模式</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={merge(styles.roleBtn, roomMode === 'pk' && styles.roleBtnActive)}
              onPress={() => {
                setRoomMode('pk');
                setMe('');
              }}
            >
              <Text style={merge(styles.roleText, roomMode === 'pk' && styles.roleTextActive)}>双人PK</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionTitle}>选择身份</Text>
          {roomMode === 'house' ? (
            <View style={styles.roleRow}>
              <TouchableOpacity
                style={merge(styles.roleBtn, me === 'host' && styles.roleBtnActive)}
                onPress={() => setMe('host')}
              >
                <Text style={merge(styles.roleText, me === 'host' && styles.roleTextActive)}>我是庄家</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={merge(styles.roleBtn, me === 'player' && styles.roleBtnActive)}
                onPress={() => setMe('player')}
              >
                <Text style={merge(styles.roleText, me === 'player' && styles.roleTextActive)}>我是猜手</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.roleRow}>
              <TouchableOpacity
                style={merge(styles.roleBtn, me === 'A' && styles.roleBtnActive)}
                onPress={() => setMe('A')}
              >
                <Text style={merge(styles.roleText, me === 'A' && styles.roleTextActive)}>对战位 A</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={merge(styles.roleBtn, me === 'B' && styles.roleBtnActive)}
                onPress={() => setMe('B')}
              >
                <Text style={merge(styles.roleText, me === 'B' && styles.roleTextActive)}>对战位 B</Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionBtn} onPress={createRoom}>
              <Text style={styles.actionText}>创建房间（4位数字）</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            placeholder="输入4位房间号加入"
            value={joinId}
            onChangeText={setJoinId}
            keyboardType="number-pad"
            maxLength={4}
          />
          <TouchableOpacity style={styles.actionBtnGhost} onPress={joinRoom}>
            <Text style={styles.actionGhostText}>加入房间</Text>
          </TouchableOpacity>
        </View>
      )}

      {roomId && room && (
        <>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>房间信息</Text>
            <Text style={styles.line}>房间号：{roomId}</Text>
            <Text style={styles.line}>模式：{isPk ? '双人PK' : '庄家模式'}</Text>
            <Text style={styles.line}>
              身份：{isPk ? (pkSide ? `对战位 ${pkSide}` : '未选择') : isHost ? '庄家' : '猜手'}
            </Text>
            {!isPk && <Text style={styles.line}>轮次：{round}</Text>}
            {isPk && status !== 'setup' && <Text style={styles.line}>轮流：{pkTurn}</Text>}
            <Text style={styles.status}>{statusText}</Text>
            <View style={styles.statsRow}>
              {isPk ? (
                <>
                  <Text style={styles.statText}>A积分：{scores.A ?? 0}</Text>
                  <Text style={styles.statText}>B积分：{scores.B ?? 0}</Text>
                </>
              ) : (
                <>
                  <Text style={styles.statText}>庄家积分：{scores.host ?? 0}</Text>
                  <Text style={styles.statText}>猜手积分：{scores.player ?? 0}</Text>
                </>
              )}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>场地设置</Text>
            <View style={styles.inputRow}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>网格大小</Text>
                <View style={styles.inlineRow}>
                  <Text style={styles.inlineValue}>{displayGridWidth} x {displayGridHeight}</Text>
                  <TouchableOpacity
                    style={merge(styles.inlineBtn, !canConfigure && styles.actionBtnDisabled)}
                    onPress={openGridModal}
                    disabled={!canConfigure}
                  >
                    <Text style={styles.inlineBtnText}>设置</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>入场积分</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={String(entryFee)}
                  editable={isHouse ? canConfigureHouse : !!pkSide && status === 'setup'}
                  onChangeText={handleEntryFee}
                />
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>猜对积分</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={String(hitScore)}
                  editable={isHouse ? canConfigureHouse : !!pkSide && status === 'setup'}
                  onChangeText={handleHitScore}
                />
              </View>
            </View>

            {((isHouse && isHost) || (isPk && status === 'setup' && pkSide)) && (
              <View style={styles.modeRow}>
                <TouchableOpacity
                  style={merge(styles.modeBtn, editMode === 'place' && styles.modeBtnActive)}
                  onPress={() => setEditMode('place')}
                  disabled={!canConfigure}
                >
                  <Text style={merge(styles.modeText, editMode === 'place' && styles.modeTextActive)}>插旗</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={merge(styles.modeBtn, editMode === 'mine' && styles.modeBtnActive)}
                  onPress={() => setEditMode('mine')}
                  disabled={!canConfigure}
                >
                  <Text style={merge(styles.modeText, editMode === 'mine' && styles.modeTextActive)}>埋雷</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={merge(styles.modeBtn, editMode === 'delete' && styles.modeBtnActive)}
                  onPress={() => setEditMode('delete')}
                  disabled={!canConfigure}
                >
                  <Text style={merge(styles.modeText, editMode === 'delete' && styles.modeTextActive)}>删除</Text>
                </TouchableOpacity>
              </View>
            )}

            {isHouse ? (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={merge(styles.actionBtn, !canConfigureHouse && styles.actionBtnDisabled)}
                  onPress={startRound}
                  disabled={!canConfigureHouse}
                >
                  <Text style={styles.actionText}>开始本轮</Text>
                </TouchableOpacity>
                {isHost && (
                  <TouchableOpacity style={styles.actionBtnGhost} onPress={resetRound}>
                    <Text style={styles.actionGhostText}>重新摆旗</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : status === 'over' ? (
              <View style={styles.actionRow}>
                <TouchableOpacity style={styles.actionBtn} onPress={resetPkRound}>
                  <Text style={styles.actionText}>开始下一轮</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={merge(styles.actionBtn, !canConfigurePk && styles.actionBtnDisabled)}
                  onPress={confirmPkField}
                  disabled={!canConfigurePk}
                >
                  <Text style={styles.actionText}>确认布雷</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={merge(styles.actionBtnGhost, (!pkSide || status !== 'setup') && styles.actionBtnDisabled)}
                  onPress={resetPkField}
                  disabled={!pkSide || status !== 'setup'}
                >
                  <Text style={styles.actionGhostText}>重新摆旗</Text>
                </TouchableOpacity>
              </View>
            )}
            <Text style={styles.tipText}>
              旗子 {displayFlags.length}/{Math.min(MAX_FLAGS, displayGridWidth * displayGridHeight)}，
              地雷 {displayFlags.filter((f: any) => f.mine).length}，
              安全剩余 {displaySafeLeft}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>场地</Text>
            <View style={styles.grid}>
              {Array.from({ length: displayGridHeight }).map((_, y) => (
                <View key={y} style={styles.gridRow}>
                  {Array.from({ length: displayGridWidth }).map((_, x) => renderCell(x, y))}
                </View>
              ))}
            </View>
          </View>
        </>
      )}

      <Modal transparent visible={gridModalVisible} animationType="fade" onRequestClose={() => setGridModalVisible(false)}>
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>设置网格大小</Text>
            <View style={styles.inputRow}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>宽度</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={gridWidthDraft}
                  onChangeText={setGridWidthDraft}
                />
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>高度</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={gridHeightDraft}
                  onChangeText={setGridHeightDraft}
                />
              </View>
            </View>
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.actionBtnGhost} onPress={() => setGridModalVisible(false)}>
                <Text style={styles.actionGhostText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={confirmGridModal}>
                <Text style={styles.actionText}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={helpVisible} animationType="fade" onRequestClose={() => setHelpVisible(false)}>
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>游戏规则</Text>
            <Text style={styles.helpText}>{HELP_TEXT}</Text>
            <TouchableOpacity style={styles.helpBtn} onPress={() => setHelpVisible(false)}>
              <Text style={styles.helpBtnText}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#111', flex: 1 },
  content: { padding: 16, gap: 14, paddingBottom: 32 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#fff', fontSize: 20, fontWeight: '800' },
  helpBtn: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#3a3a3a',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  helpBtnText: { color: '#ddd', fontWeight: '700', fontSize: 12 },
  card: { backgroundColor: '#1b1b1b', padding: 14, borderRadius: 12, gap: 10 },
  sectionTitle: { color: '#fff', fontWeight: '700', fontSize: 16 },
  status: { color: '#a3a3a3' },
  line: { color: '#aaa', lineHeight: 20 },
  roleRow: { flexDirection: 'row', gap: 10 },
  roleBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a3a',
    paddingVertical: 8,
    alignItems: 'center',
  },
  roleBtnActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  roleText: { color: '#ccc', fontWeight: '700' },
  roleTextActive: { color: '#fff' },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statText: { color: '#d1d5db', fontSize: 12 },
  inputRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  inputGroup: { flexGrow: 1, minWidth: 110, gap: 6 },
  inputLabel: { color: '#aaa', fontSize: 12 },
  input: {
    backgroundColor: '#2a2a2a',
    color: '#fff',
    padding: 8,
    borderRadius: 8,
  },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inlineValue: { color: '#d1d5db', fontSize: 12 },
  inlineBtn: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#3a3a3a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  inlineBtnText: { color: '#ddd', fontWeight: '700', fontSize: 12 },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionBtn: {
    flex: 1,
    backgroundColor: '#2563eb',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  actionBtnDisabled: { opacity: 0.4 },
  actionText: { color: '#fff', fontWeight: '700' },
  actionBtnGhost: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#3a3a3a',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  actionGhostText: { color: '#ddd', fontWeight: '700' },
  tipText: { color: '#9ca3af', fontSize: 12 },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  modeBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a3a',
    paddingVertical: 8,
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: '#f59e0b', borderColor: '#f59e0b' },
  modeText: { color: '#cbd5f5', fontWeight: '700' },
  modeTextActive: { color: '#111' },
  grid: { gap: 6 },
  gridRow: { flexDirection: 'row', gap: 6 },
  cell: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: '#202020',
    borderWidth: 1,
    borderColor: '#3a3a3a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellFlag: { backgroundColor: '#0f172a', borderColor: '#1d4ed8' },
  cellMine: { backgroundColor: '#7f1d1d', borderColor: '#dc2626' },
  cellGuessed: { backgroundColor: '#1f2937', borderColor: '#475569' },
  cellText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: '#1b1b1b',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    gap: 12,
  },
  modalTitle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  helpText: { color: '#ddd', lineHeight: 22 },
});
