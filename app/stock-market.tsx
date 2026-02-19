// @ts-nocheck
import { ThemedText } from "@/components/themed-text";
import { getDb } from "@/firebase";
import { createRoom as createRoomRecord, setupPresence, touchRoom } from "@/utils/room";
import { generateEvent, generateStockNames, getPriceColor } from "@/utils/stock-utils";
import { useNavigation } from "@react-navigation/native";
import { onValue, ref, runTransaction, update } from "firebase/database";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** ================= 常量 ================= */

const ROOM_TTL_MS = 1000 * 60 * 60;
const HEARTBEAT_MS = 1000 * 30;
const INTEREST_RATE = 0.03; // V10: 降低利息至 3%
const BANKRUPTCY_RATIO = 0.1; // 破产线：资产低于借贷的 10%

/** ================= UI 组件 ================= */

function Btn({ title, onPress, disabled, kind, style, small }: any) {
    return (
        <TouchableOpacity
            disabled={disabled}
            onPress={onPress}
            style={[
                styles.btn,
                kind === "danger" && styles.btnDanger,
                kind === "ghost" && styles.btnGhost,
                small && styles.btnSmall,
                disabled && styles.btnDis,
                style,
            ]}
        >
            <Text style={[styles.btnText, kind === "ghost" && styles.btnTextGhost]}>
                {title}
            </Text>
        </TouchableOpacity>
    );
}

/** ================= 游戏主组件 ================= */

export default function StockMarket() {
    const [roomId, setRoomId] = useState("");
    const [timeLeft, setTimeLeft] = useState(30);
    const [chatVisible, setChatVisible] = useState(false);
    const [messages, setMessages] = useState<any[]>([]);
    const [chatInput, setChatInput] = useState("");
    const [emojiVisible, setEmojiVisible] = useState(false); // V8: 表情面板
    const [emojiTarget, setEmojiTarget] = useState<string>(""); // V8: 表情目标
    const [incomingEmoji, setIncomingEmoji] = useState<{ from: string, emoji: string } | null>(null); // V8: 收到表情内容
    const [joinId, setJoinId] = useState("");
    const [me, setMe] = useState<string>("");
    const [room, setRoom] = useState<any>(null);
    const [maxPlayers, setMaxPlayers] = useState(4); // 默认 4 人
    const [tagSpent, setTagSpent] = useState(""); // V9: 自定义商战金额
    const [whisperInput, setWhisperInput] = useState(""); // V9: 私聊输入
    const [loanRange, setLoanRange] = useState<[number, number]>([50000, 500000]); // V9: 贷款区间
    const [notifications, setNotifications] = useState<any[]>([]); // V9: 个人提示
    const [buyAmount, setBuyAmount] = useState("");
    const [sellAmount, setSellAmount] = useState("");
    const [loanInput, setLoanInput] = useState("");
    const [selectedStock, setSelectedStock] = useState(0);
    const [helpVisible, setHelpVisible] = useState(false);

    const insets = useSafeAreaInsets();
    const navigation = useNavigation();
    const leavingRef = useRef(false);
    const disconnectRef = useRef<any>(null);

    const isHost = me === "P1";
    const myData = room?.players?.[me] || {};
    const status = room?.status || "waiting";
    const round = room?.round || 1;
    const stocks = room?.stocks || [];
    const events = room?.events || [];
    const maxRounds = room?.maxRounds || 20;
    const buyLimitRound = room?.buyLimitRound || 15;
    const roundStartTime = room?.roundStartTime || 0;
    const sectorPerformance = room?.sectorPerformance || {}; // V7: 行业表现记录

    const isBankrupt = myData.isBankrupt || false;
    const currentStock = stocks[selectedStock] || {};
    const individualLimit = currentStock.buyLimitRound || 0;

    const activeTempBans = events.filter((e: any) => {
        if (e.targetType !== "tempBan") return false;
        if (e.targetValue?.type === "index") return e.targetValue.value === selectedStock;
        if (e.targetValue?.type === "sector") return e.targetValue.value === currentStock.sector;
        return false;
    });
    const isTempBanned = activeTempBans.length > 0;

    const canBuy = round <= individualLimit && status === "playing" && !isBankrupt && !isTempBanned;
    const amReady = myData.ready;

    const allReady = useMemo(() => {
        if (!room?.players) return false;
        const active = Object.values(room.players).filter((p: any) => !p.left);
        if (active.length === 0) return false;
        return active.every((p: any) => p.isBankrupt || p.ready);
    }, [room?.players]);

    /** -------- 生命周期与 Firebase -------- */

    useEffect(() => {
        if (!roomId) return;
        const db = getDb();
        if (!db) return;
        return onValue(ref(db, `stock_rooms/${roomId}`), (snap) => {
            const v = snap.val();
            if (!v) { setRoom(null); return; }

            // 鲁棒清理: 检查幽灵房间（全员 left）
            const playerEntries = Object.entries(v.players || {});
            if (playerEntries.length > 0 && playerEntries.every(([_, p]: any) => p.left)) {
                console.log("Detect ghost room, cleaning up...");
                const { remove } = require("firebase/database");
                remove(ref(db, `stock_rooms/${roomId}`));
                setRoom(null);
                setRoomId("");
                return;
            }
            setRoom(v);
        });
    }, [roomId]);

    useEffect(() => {
        if (!roomId || !me) return;
        const handler = setupPresence("stock_rooms", roomId, me, { left: false }, { left: true });
        disconnectRef.current = handler;
        return () => handler?.cancel();
    }, [roomId, me]);

    useEffect(() => {
        if (!roomId || !me) return;
        const tick = () => touchRoom("stock_rooms", roomId);
        tick();
        const timer = setInterval(tick, HEARTBEAT_MS);
        return () => clearInterval(timer);
    }, [roomId, me]);

    // V7: 倒计时逻辑
    useEffect(() => {
        if (status !== "playing" || !roundStartTime) return;
        const timer = setInterval(() => {
            const now = Date.now();
            const elapsed = Math.floor((now - roundStartTime) / 1000);
            const remaining = Math.max(0, 30 - elapsed);
            setTimeLeft(remaining);
            if (remaining === 0 && !myData.ready && !isBankrupt && room?.maxPlayers > 1) {
                commitTurn(); // 超时自动提交
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [status, roundStartTime, myData.ready, isBankrupt, room?.maxPlayers]);

    // V8: 表情反馈监听
    useEffect(() => {
        if (!roomId || !me) return;
        const db = getDb();
        const emojiRef = ref(db, `stock_rooms/${roomId}/players/${me}/emoji`);
        const whisperRef = ref(db, `stock_rooms/${roomId}/players/${me}/whisper`);
        const noteRef = ref(db, `stock_rooms/${roomId}/privateNotes/${me}`);

        const unsubEmoji = onValue(emojiRef, (snap) => {
            const v = snap.val();
            if (v && v.time > Date.now() - 5000) {
                setIncomingEmoji(v);
                setTimeout(() => setIncomingEmoji(null), 3000);
            }
        });

        const unsubWhisper = onValue(whisperRef, (snap) => {
            const v = snap.val();
            if (v && v.time > Date.now() - 5000) {
                setNotifications(prev => [...prev, { type: 'whisper', from: v.from, text: v.text }]);
                setTimeout(() => setNotifications(prev => prev.slice(1)), 5000);
            }
        });

        const unsubNotes = onValue(noteRef, (snap) => {
            const v = snap.val();
            if (Array.isArray(v)) {
                setNotifications(prev => [...prev, ...v.map(msg => ({ type: 'system', text: msg }))]);
                setTimeout(() => setNotifications(prev => prev.slice(v.length)), 7000);
                update(ref(db, `stock_rooms/${roomId}/privateNotes`), { [me]: null }); // 阅读后清空
            }
        });

        return () => { unsubEmoji(); unsubWhisper(); unsubNotes(); };
    }, [roomId, me]);

    useEffect(() => {
        if (!roomId) return;
        const { subscribeChatMessages } = require("@/utils/chat");
        const unsub = subscribeChatMessages("stock_chats", roomId, 50, (msgs) => {
            setMessages(msgs);
        });
        return () => unsub?.();
    }, [roomId]);

    /** -------- 核心动作 -------- */

    const createRoom = async () => {
        const db = getDb();
        if (!db) return;
        const stockData = generateStockNames(10);
        const totalRounds = 20 + Math.floor(Math.random() * 11);
        const initialStocks = stockData.map(data => {
            const price = 20 + Math.random() * 30;
            return {
                name: data.name,
                sector: data.sector,
                shares: data.shares, // V9: 股本
                price: price,
                history: [price],
                buyLimitRound: Math.floor(totalRounds * 0.75),
            };
        });
        const firstEvent = generateEvent(initialStocks);
        const playersObj: any = {
            "P1": { cash: 0, pendingCash: 0, loan: 0, holdings: new Array(10).fill(0), ready: false, left: false, isBankrupt: false }
        };
        const base = {
            status: "waiting",
            round: 1,
            maxRounds: totalRounds,
            stocks: initialStocks,
            events: firstEvent ? [firstEvent] : [],
            maxPlayers: maxPlayers,
            config: { loanRange }, // V9: 贷款区间配置
            players: playersObj,
            createdAt: Date.now(),
            lastActive: Date.now(),
            roundStartTime: Date.now(),
            sectorPerformance: {},
        };
        if (loanRange[1] <= loanRange[0]) return alert("贷款上限必须严格大于下限");
        const id = await createRoomRecord("stock_rooms", base);
        if (id) { setRoomId(id); setMe("P1"); }
    };

    async function joinRoom() {
        const id = joinId.trim();
        if (!/^\d{4}$/.test(id)) return alert("请输入4位房号");
        const db = getDb();
        let joinedKey = "";
        await runTransaction(ref(db, `stock_rooms/${id}`), (cur) => {
            if (!cur) return cur;
            if (cur.status !== "waiting") return undefined;
            const currentCount = Object.values(cur.players).filter(p => !p.left).length;
            if (currentCount >= cur.maxPlayers) return undefined;
            for (let i = 1; i <= cur.maxPlayers; i++) {
                const pk = `P${i}`;
                if (!cur.players[pk] || cur.players[pk].left) {
                    cur.players[pk] = {
                        cash: 0, pendingCash: 0, loan: 0, holdings: new Array(cur.stocks.length).fill(0),
                        ready: false, left: false, isBankrupt: false
                    };
                    joinedKey = pk;
                    break;
                }
            }
            return cur;
        });
        if (joinedKey) { setRoomId(id); setMe(joinedKey); }
        else alert("无法加入（满员或已开始）");
    }

    async function startGame() {
        if (!isHost) return;
        const currentCount = Object.values(room.players).filter(p => !p.left).length;
        if (currentCount < room.maxPlayers && room.maxPlayers > 1) return alert("等待所有玩家加入...");
        const db = getDb();
        await update(ref(db, `stock_rooms/${roomId}`), { status: "borrowing" });
    }

    async function takeLoan() {
        const amount = parseInt(loanInput);
        const [min, max] = room?.config?.loanRange || [50000, 500000];
        if (isNaN(amount) || amount < min || amount > max) return alert(`请输入 [¥${min.toLocaleString()}, ¥${max.toLocaleString()}] 之间的借贷金额`);
        const db = getDb();
        await update(ref(db, `stock_rooms/${roomId}/players/${me}`), { cash: amount, loan: amount, ready: true });
        await runTransaction(ref(db, `stock_rooms/${roomId}`), (cur) => {
            if (!cur) return cur;
            const active = Object.values(cur.players).filter(p => !p.left);
            if (active.every(p => p.ready)) {
                cur.status = "playing";
                cur.roundStartTime = Date.now();
                Object.keys(cur.players).forEach(k => { if (cur.players[k]) cur.players[k].ready = false; });
            }
            return cur;
        });
    }

    async function commitTurn() {
        if (amReady) return;
        const db = getDb();
        await update(ref(db, `stock_rooms/${roomId}/players/${me}`), { ready: true });
        await runTransaction(ref(db, `stock_rooms/${roomId}`), (cur) => {
            if (!cur) return cur;
            const activeEntries = Object.entries(cur.players).filter(([_, p]) => !p.left);
            if (activeEntries.every(([_, p]) => p.ready || p.isBankrupt)) {
                // 1. 计算全场总资产 (V9 基准)
                const totalWealth = activeEntries.reduce((acc, [_, p]) => {
                    const sV = (p.holdings || []).reduce((sum, q, i) => sum + q * (cur.stocks[i]?.price || 0), 0);
                    return acc + (p.cash || 0) + (p.pendingCash || 0) + sV - (p.loan || 0) * (1 + INTEREST_RATE);
                }, 0);

                // 2. T+1 及利率
                activeEntries.forEach(([_, p]) => {
                    p.cash += (p.pendingCash || 0);
                    p.pendingCash = 0;
                    if (p.isBankrupt) return;
                    const stockVal = p.holdings.reduce((acc, q, i) => acc + q * cur.stocks[i].price, 0);
                    if (p.cash <= 0 && stockVal < p.loan * BANKRUPTCY_RATIO) p.isBankrupt = true;
                });

                const { simulatePrice, generateEvent } = require("@/utils/stock-utils");
                const prevPerformance = cur.sectorPerformance || {};
                const currentPerformance: Record<string, number> = {};
                const sectorCounts: Record<string, number> = {};
                if (!cur.privateNotes) cur.privateNotes = {};

                // 3. 核心股价及股本演化
                cur.stocks = cur.stocks.map((s, idx) => {
                    const multipliers: number[] = [];
                    const cap = (s.shares || 500000) * s.price;

                    // A. 事件/标签/坐庄逻辑
                    (cur.events || []).forEach(e => {
                        if (e.targetType === "all") multipliers.push(e.impact || 1);
                        if (e.targetType === "index" && e.targetValue === idx) multipliers.push(e.impact || 1);
                        if (e.targetType === "sector" && (e.targetValue === s.sector || e.targetValue?.value === s.sector)) multipliers.push(e.impact || 1);
                    });

                    // V9: 标签干预效果计算 (模糊博弈)
                    const tagImpact = cur.activeTags?.[idx] || 0; // 这里的 tagImpact 现在是概率修正值
                    if (tagImpact !== 0) multipliers.push(1 + tagImpact);

                    const turnBuyVol = cur.turnBuys?.[idx] || 0;
                    const threshold = cap > (totalWealth / activeEntries.length) * 1.5 ? 0.35 : 0.27; // 大市值更高阈值
                    if (totalWealth > 0 && turnBuyVol / totalWealth >= threshold) {
                        const existingPump = (cur.events || []).find(e => e.type === 'pump' && e.targetValue === idx);
                        if (existingPump) {
                            existingPump.duration += 2; // 续费
                        } else {
                            if (!cur.events) cur.events = [];
                            cur.events.push({
                                id: `pump_${idx}_${cur.round}`,
                                message: `【游资进场】${s.name} 触发做多阈值，进入拉升期！`,
                                duration: 3, impact: 1.25, type: 'pump', targetType: 'index', targetValue: idx
                            });
                        }
                    }

                    const oldPrice = s.price;
                    const nextPrice = simulatePrice(oldPrice, multipliers, 0.15, cap);

                    // V9: 拆股 / 缩股处理
                    let finalPrice = nextPrice;
                    let finalShares = s.shares || 500000;

                    if (finalPrice > 200) {
                        // 1 拆 2
                        finalPrice /= 2;
                        finalShares *= 2;
                        activeEntries.forEach(([uid, p]) => {
                            if (p.holdings[idx] > 0) {
                                const oldH = p.holdings[idx];
                                p.holdings[idx] *= 2;
                                if (!cur.privateNotes[uid]) cur.privateNotes[uid] = [];
                                cur.privateNotes[uid].push(`【拆股】${s.name} 1 拆 2，持仓从 ${oldH} 变为 ${p.holdings[idx]}，成本对半减。`);
                            }
                        });
                    } else if (finalPrice < 5) {
                        // 10 缩 1
                        finalPrice *= 10;
                        finalShares /= 10;
                        activeEntries.forEach(([uid, p]) => {
                            if (p.holdings[idx] > 0) {
                                const oldH = p.holdings[idx];
                                const nextH = Math.floor(oldH / 10);
                                const fractional = oldH % 10;
                                p.cash += fractional * s.price; // 散股退现金
                                p.holdings[idx] = nextH;
                                if (!cur.privateNotes[uid]) cur.privateNotes[uid] = [];
                                cur.privateNotes[uid].push(`【缩股】${s.name} 10 缩 1，持仓从 ${oldH} 变为 ${nextH}，余股已折现 ¥${(fractional * s.price).toFixed(0)}。`);
                            }
                        });
                    }

                    const perf = (finalPrice - oldPrice) / oldPrice;
                    currentPerformance[s.sector] = (currentPerformance[s.sector] || 0) + perf;
                    sectorCounts[s.sector] = (sectorCounts[s.sector] || 0) + 1;

                    return { ...s, price: finalPrice, shares: finalShares, history: [...(s.history || []).slice(-19), finalPrice] };
                });

                cur.sectorPerformance = currentPerformance;
                const nextEvents = (cur.events || []).filter(e => { e.duration -= 1; return e.duration > 0; });
                const roll = generateEvent(cur.stocks);
                if (roll) nextEvents.push(roll);
                cur.events = nextEvents;
                cur.activeTags = {};
                cur.turnBuys = {};
                cur.round += 1;
                cur.roundStartTime = Date.now();
                activeEntries.forEach(([_, p]) => { p.ready = false; });
                if (cur.round > cur.maxRounds) cur.status = "over";
            }
            return cur;
        });
    }

    async function handleAddTag(isPositive: boolean) {
        if (isBankrupt) return;
        const amount = parseInt(tagSpent);
        const s = stocks[selectedStock];
        const cap = (s.shares || 500000) * s.price;
        const minCost = Math.floor(cap * 0.0005);
        if (isNaN(amount) || amount < minCost) return alert(`投入不足以撼动市场 (该股市值需至少投入 ¥${minCost.toLocaleString()})`);

        // V10: 统一资金校验与计算
        if (myData.cash < amount) return alert(`现金不足 (当前仅剩 ¥${myData.cash.toLocaleString()})`);

        const ratio = amount / cap;
        let impact = 0;
        if (ratio < 0.001) impact = 0.03 * (isPositive ? 1 : -1);
        else if (ratio < 0.005) impact = 0.08 * (isPositive ? 1 : -1);
        else if (ratio < 0.02) impact = 0.18 * (isPositive ? 1 : -1);
        else impact = 0.35 * (isPositive ? 1 : -1);

        const db = getDb();
        await runTransaction(ref(db, `stock_rooms/${roomId}`), (cur) => {
            if (!cur) return cur;
            if (!cur.activeTags) cur.activeTags = {};
            cur.activeTags[selectedStock] = (cur.activeTags[selectedStock] || 0) + impact;
            // 发送消息
            const msg = `[${me}] 狂掷 ¥${amount.toLocaleString()} ${isPositive ? '为' : '砸盘'} [${s.name}]，市场情绪大变！`;
            if (!cur.events) cur.events = [];
            cur.events.push({ id: Date.now().toString(), message: msg, duration: 1, type: 'tag' });
            return cur;
        });
        setTagSpent("");
        setEmojiVisible(false);
    }

    async function handleWhisper() {
        if (!whisperInput.trim() || !emojiTarget) return;
        const db = getDb();
        await update(ref(db, `stock_rooms/${roomId}/players/${emojiTarget}/whisper`), {
            from: me,
            text: whisperInput.trim(),
            time: Date.now()
        });
        setWhisperInput("");
        setEmojiVisible(false);
    }

    async function handleBuy() {
        if (isBankrupt) return;
        const amount = parseInt(buyAmount);
        const cost = amount * stocks[selectedStock].price;
        if (cost > myData.cash) return alert(`现金不足 (所需 ¥${cost.toLocaleString()}，当前 ¥${myData.cash.toLocaleString()})`);
        const db = getDb();
        // 记录购买流水用于 V8 坐庄检测
        await runTransaction(ref(db, `stock_rooms/${roomId}/turnBuys/${selectedStock}`), (v) => (v || 0) + cost);
        await runTransaction(ref(db, `stock_rooms/${roomId}/players/${me}`), (p) => {
            if (!p) return p;
            p.cash -= cost;
            const h = [...p.holdings];
            h[selectedStock] += amount;
            p.holdings = h;
            return p;
        });
        setBuyAmount("");
    }

    async function handleSell() {
        if (isBankrupt) return;
        const amount = parseInt(sellAmount);
        if (amount > (myData.holdings?.[selectedStock] || 0)) return alert("仓位不足");
        const gain = amount * stocks[selectedStock].price;
        const db = getDb();
        await runTransaction(ref(db, `stock_rooms/${roomId}/players/${me}`), (p) => {
            if (!p) return p;
            p.pendingCash = (p.pendingCash || 0) + gain;
            const h = [...p.holdings];
            h[selectedStock] -= amount;
            p.holdings = h;
            return p;
        });
        setSellAmount("");
    }

    const handleSendMessage = async () => {
        if (!chatInput.trim()) return;
        const { sendChatMessage } = require("@/utils/chat");
        await sendChatMessage("stock_chats", roomId, { name: me, text: chatInput.trim() });
        setChatInput("");
    };

    async function restartGame() {
        if (!isHost) return;
        const db = getDb();
        const stockData = generateStockNames(10);
        const totalRounds = 20 + Math.floor(Math.random() * 11);
        const initialStocks = stockData.map(data => {
            const price = 20 + Math.random() * 30;
            return {
                name: data.name,
                sector: data.sector,
                shares: data.shares,
                price: price,
                history: [price],
                buyLimitRound: Math.floor(totalRounds * 0.75),
            };
        });

        await runTransaction(ref(db, `stock_rooms/${roomId}`), (cur) => {
            if (!cur) return cur;
            cur.status = "borrowing";
            cur.round = 1;
            cur.maxRounds = totalRounds;
            cur.stocks = initialStocks;
            cur.events = [];
            cur.roundStartTime = Date.now();
            cur.sectorPerformance = {};
            cur.turnBuys = {};
            cur.activeTags = {};
            // 重置玩家状态，保留 cash/loan 设置逻辑在 borrowing 阶段执行
            Object.keys(cur.players).forEach(pk => {
                cur.players[pk] = {
                    ...cur.players[pk],
                    cash: 0, pendingCash: 0, loan: 0, holdings: new Array(10).fill(0),
                    ready: false, isBankrupt: false
                };
            });
            return cur;
        });
    }

    async function leaveRoom() {
        if (leavingRef.current) return;
        leavingRef.current = true;
        const db = getDb();
        if (db && roomId && me) {
            const pk = me;
            await update(ref(db, `stock_rooms/${roomId}/players/${pk}`), { left: true });

            // 实时检查物理删除
            const snap = await require("firebase/database").get(ref(db, `stock_rooms/${roomId}`));
            const data = snap.val();
            if (data) {
                const activeCount = Object.values(data.players || {}).filter((p: any) => !p.left).length;
                if (activeCount === 0) {
                    await require("firebase/database").remove(ref(db, `stock_rooms/${roomId}`));
                }
            }
        }
        setRoomId("");
        setMe("");
        setRoom(null);
        navigation.goBack();
    }

    /** -------- 计算属性 -------- */

    const currentStockValue = useMemo(() => {
        return (myData.holdings || []).reduce((acc, q, i) => acc + q * (stocks[i]?.price || 0), 0);
    }, [myData, stocks]);

    const netWorth = useMemo(() => {
        if (!myData) return 0;
        return (myData.cash || 0) + (myData.pendingCash || 0) + currentStockValue - (myData.loan || 0) * (1 + INTEREST_RATE);
    }, [myData, currentStockValue]);

    const leaderboard = useMemo(() => {
        if (!room?.players) return [];
        return Object.entries(room.players).filter(([_, p]) => !p.left).map(([id, p]) => {
            const sV = (p.holdings || []).reduce((acc, q, i) => acc + q * (stocks[i]?.price || 0), 0);
            const nw = (p.cash || 0) + (p.pendingCash || 0) + sV - (p.loan || 0) * (1 + INTEREST_RATE);
            return { id, name: id === me ? "我" : id, val: nw, bankrupt: p.isBankrupt };
        }).sort((a, b) => b.val - a.val);
    }, [room?.players, stocks, me]);

    /** -------- 渲染 -------- */

    const renderLobby = () => (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={styles.lobbyInner} bounces={false}>
                <ThemedText type="title" style={styles.title}>资本博弈 V11</ThemedText>
                <ThemedText style={styles.subtitle}>12大行业联动，全设备适配优化</ThemedText>
                {!roomId ? (
                    <View style={styles.card}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={styles.line}>对局人数 (1-8)</Text>
                            <TextInput
                                style={{ backgroundColor: '#09090b', color: '#fbbf24', padding: 8, borderRadius: 8, width: 60, textAlign: 'center', fontWeight: 'bold' }}
                                value={maxPlayers.toString()}
                                onChangeText={(v) => {
                                    // 允许暂时的空输入，方便删除
                                    if (v === "") return setMaxPlayers("");
                                    setMaxPlayers(v);
                                }}
                                onBlur={() => {
                                    // 失去焦点时进行保护
                                    const val = parseInt(maxPlayers);
                                    setMaxPlayers(Math.min(8, Math.max(1, val || 4)));
                                }}
                                keyboardType="number-pad"
                            />
                        </View>

                        <View style={styles.hr} />
                        <Text style={styles.tip}>[房主配置] 起始贷款区间 (¥):</Text>
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <TextInput
                                style={[styles.input, { flex: 1, fontSize: 14 }]}
                                placeholder="Min"
                                value={loanRange[0] === 0 ? "" : loanRange[0].toString()}
                                onChangeText={(v) => {
                                    if (v === "") return setLoanRange(["", loanRange[1]]);
                                    setLoanRange([parseInt(v) || 0, loanRange[1]]);
                                }}
                                onBlur={() => {
                                    if (loanRange[0] === "") setLoanRange([50000, loanRange[1]]);
                                }}
                                keyboardType="number-pad"
                            />
                            <TextInput
                                style={[styles.input, { flex: 1, fontSize: 14 }]}
                                placeholder="Max"
                                value={loanRange[1] === 0 ? "" : loanRange[1].toString()}
                                onChangeText={(v) => {
                                    if (v === "") return setLoanRange([loanRange[0], ""]);
                                    setLoanRange([loanRange[0], parseInt(v) || 0]);
                                }}
                                onBlur={() => {
                                    if (loanRange[1] === "") setLoanRange([loanRange[0], 500000]);
                                }}
                                keyboardType="number-pad"
                            />
                        </View>

                        <Btn title="立即启动大厅" onPress={createRoom} />
                        <View style={styles.hr} />
                        <TextInput style={styles.input} placeholder="通过 6 位房号加入..." placeholderTextColor="#666" value={joinId} onChangeText={setJoinId} keyboardType="number-pad" />
                        <Btn title="精准切入战场" onPress={joinRoom} kind="ghost" disabled={!joinId} />
                    </View>
                ) : (
                    <View style={styles.card}>
                        <Text style={styles.line}>房号：{roomId}</Text>
                        <Text style={styles.tip}>当前人数: {Object.values(room?.players || {}).filter(p => !p.left).length} / {maxPlayers}</Text>
                        <View style={styles.hr} />
                        {isHost && (
                            <Btn title="开启战斗" onPress={startGame} disabled={Object.values(room?.players || {}).filter(p => !p.left).length < maxPlayers && maxPlayers > 1} />
                        )}
                        <Btn title="离开" onPress={() => navigation.goBack()} kind="danger" style={{ marginTop: 10 }} />
                    </View>
                )}
            </ScrollView>
        </KeyboardAvoidingView>
    );

    const renderBorrowing = () => (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={styles.lobbyInner} bounces={false}>
                <ThemedText type="title" style={styles.title}>杠杆申请</ThemedText>
                <ThemedText style={styles.subtitle}>当前账户余额 0，请选择本局的起始贷款金额。</ThemedText>
                <View style={styles.card}>
                    <Text style={styles.line}>贷款金额 (¥)</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="例如 200000"
                        placeholderTextColor="#666"
                        value={loanInput}
                        onChangeText={setLoanInput}
                        keyboardType="number-pad"
                    />
                    <Text style={styles.tip}>* 提示：若资产跌破贷款额 10% 将判定破产。</Text>
                    <Btn title={amReady ? "等待对手决策..." : "确认贷款"} onPress={takeLoan} disabled={amReady || !loanInput} />
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );

    const renderGame = () => (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
            <View style={styles.gameInner}>
                {isBankrupt && (
                    <View style={styles.bankruptBanner}>
                        <Text style={styles.bankruptText}>🚫 您已破产，无法进行后续交易操作</Text>
                    </View>
                )}

                <View style={styles.gameHeader}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.headerLabel}>R {round}/{maxRounds} | {timeLeft}s</Text>
                        <Text style={styles.balanceText}>¥{Math.round(netWorth).toLocaleString()}</Text>
                        <Text style={{ fontSize: 10, color: '#52525b', marginBottom: 4 }}>(现金+在途+持仓-贷款本息)</Text>
                        <View style={styles.cashRow}>
                            <View style={styles.mainCashChip}><Text style={styles.mainCashText}>现金: ¥{Math.round(myData.cash).toLocaleString()}</Text></View>
                            {myData.pendingCash > 0 && <Text style={styles.pendingText}>| 在途 ¥{Math.round(myData.pendingCash).toLocaleString()}</Text>}
                        </View>
                    </View>
                    <TouchableOpacity onPress={() => setChatVisible(true)} style={styles.chatEntry}>
                        <Text style={{ fontSize: 20 }}>💬</Text>
                    </TouchableOpacity>
                </View>

                {/* V8: 房号常设显示 */}
                <View style={{ marginBottom: 10, alignSelf: 'flex-start', backgroundColor: '#18181b', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20, borderWidth: 1, borderColor: '#27272a' }}>
                    <Text style={{ color: '#71717a', fontSize: 10, fontWeight: '800' }}>房间: {roomId} | {room?.maxPlayers}人场</Text>
                </View>

                {/* V11: 公告栏支持折叠/压缩以留出更多空间 */}
                <View style={[styles.eventCard, { maxHeight: 80, borderLeftWidth: 4, borderLeftColor: '#fbbf24' }]}>
                    <ScrollView nestedScrollEnabled bounces={false}>
                        {(room?.events || []).slice().reverse().map((e: any) => (
                            <Text key={e.id} style={[styles.eventMsg, { color: e.type === 'tag' ? '#a78bfa' : e.type === 'pump' ? '#f87171' : '#e4e4e7' }]}>
                                • {e.message}
                            </Text>
                        ))}
                    </ScrollView>
                </View>

                <ScrollView style={styles.stockScroll} showsVerticalScrollIndicator={false} bounces={false}>
                    {stocks.map((s, idx) => {
                        const isSelected = selectedStock === idx;
                        const diff = s.history.length > 1 ? s.price - s.history[s.history.length - 2] : 0;
                        return (
                            <TouchableOpacity key={idx} style={[styles.stockItem, isSelected && styles.stockItemSelected]} onPress={() => setSelectedStock(idx)}>
                                <View style={{ flex: 1 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <Text style={styles.stockName}>{s.name}</Text>
                                        <View style={styles.sectorTag}><Text style={styles.sectorTagText}>{s.sector}</Text></View>
                                    </View>
                                    <Text style={styles.stockHoldings}>持仓: {myData.holdings?.[idx] || 0}</Text>
                                </View>
                                <Text style={[styles.stockPrice, { color: getPriceColor(diff) }]}>¥{s.price.toFixed(2)}</Text>
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>

                <View style={styles.tradePanel}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={styles.tradeTitle}>{stocks[selectedStock]?.name}</Text>
                        <Text style={{ color: '#666', fontSize: 11 }}>市值: ¥{((stocks[selectedStock]?.shares || 500000) * stocks[selectedStock]?.price / 10000).toFixed(0)}万</Text>
                    </View>
                    <View style={styles.tradeRow}>
                        <TextInput
                            style={styles.tradeInput}
                            placeholder="买入股数"
                            value={buyAmount}
                            onChangeText={(v) => { if (v === "") return setBuyAmount(""); setBuyAmount(v); }}
                            keyboardType="number-pad"
                        />
                        <Btn title="买入" onPress={handleBuy} disabled={!canBuy} style={{ flex: 0.4 }} />
                    </View>
                    <View style={styles.tradeRow}>
                        <TextInput
                            style={styles.tradeInput}
                            placeholder="卖出股数"
                            value={sellAmount}
                            onChangeText={(v) => { if (v === "") return setSellAmount(""); setSellAmount(v); }}
                            keyboardType="number-pad"
                        />
                        <Btn title="套现" onPress={handleSell} kind="ghost" style={{ flex: 0.4, borderColor: '#22c55e' }} />
                    </View>

                    <View style={styles.hr} />
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                        <TextInput
                            style={[styles.tradeInput, { flex: 1 }]}
                            placeholder="商战金额 (¥)"
                            value={tagSpent}
                            onChangeText={(v) => { if (v === "") return setTagSpent(""); setTagSpent(v); }}
                            keyboardType="number-pad"
                        />
                        <View style={{ flex: 1 }}>
                            <Text style={{ color: '#fbbf24', fontSize: 10, fontWeight: 'bold' }}>
                                预估效果: {(() => {
                                    const val = parseInt(tagSpent);
                                    const cap = (stocks[selectedStock]?.shares || 500000) * stocks[selectedStock]?.price;
                                    if (isNaN(val) || val < cap * 0.0005) return "【声微言轻】";
                                    const r = val / cap;
                                    if (r < 0.001) return "【初露锋芒】";
                                    if (r < 0.005) return "【不容小觑】";
                                    if (r < 0.02) return "【翻云覆雨】";
                                    return "【只手遮天】";
                                })()}
                            </Text>
                        </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                        <Btn title="👍 捧场" onPress={() => handleAddTag(true)} kind="ghost" small style={{ flex: 1, borderColor: '#fbbf24' }} />
                        <Btn title="👎 砸盘" onPress={() => handleAddTag(false)} kind="ghost" small style={{ flex: 1, borderColor: '#ef4444' }} />
                    </View>
                </View>

                <View style={styles.footer}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
                        {Object.entries(room?.players || {}).filter(([_, p]) => !p.left).map(([id, p]: any) => (
                            <TouchableOpacity key={id} style={{ alignItems: 'center' }} onPress={() => {
                                if (id !== me) {
                                    setEmojiTarget(id);
                                    setEmojiVisible(true);
                                }
                            }}>
                                <View style={{
                                    width: 32, height: 32, borderRadius: 16,
                                    backgroundColor: p.ready ? '#fbbf24' : '#18181b',
                                    borderWidth: 2,
                                    borderColor: id === me ? '#fbbf24' : p.ready ? '#fbbf24' : '#333',
                                    justifyContent: 'center', alignItems: 'center',
                                }}>
                                    <Text style={{ fontSize: 11, color: p.ready ? '#000' : '#fff', fontWeight: '900' }}>{id}</Text>
                                </View>
                            </TouchableOpacity>
                        ))}
                    </View>

                    {/* V9: 私密系统通知 (气泡) */}
                    <View style={{ position: 'absolute', bottom: 100, left: 10, right: 10, zIndex: 100 }}>
                        {notifications.map((n, i) => (
                            <View key={i} style={{
                                backgroundColor: n.type === 'whisper' ? '#a78bfa' : '#3b82f6',
                                padding: 10, borderRadius: 12, marginBottom: 5, borderLeftWidth: 4,
                                borderLeftColor: n.type === 'whisper' ? '#7c3aed' : '#2563eb'
                            }}>
                                <Text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>
                                    {n.type === 'whisper' ? `来自 ${n.from}: ` : '系统: '}
                                    {n.text}
                                </Text>
                            </View>
                        ))}
                    </View>

                    <Btn title={amReady ? "等待结果..." : "提交决策"} onPress={commitTurn} disabled={amReady} />
                </View>
                {/* V8: 收到表情显示 */}
                {incomingEmoji && (
                    <View style={styles.emojiToast}>
                        <Text style={styles.emojiToastText}>{incomingEmoji.from} 向你发出了 {incomingEmoji.emoji}</Text>
                    </View>
                )}
                {/* V8: 表情与私聊选择 Modal */}
                <Modal visible={emojiVisible} transparent animationType="fade">
                    <View style={styles.modalMask}>
                        <View style={styles.card}>
                            <Text style={styles.line}>对 {emojiTarget} 进行社交行为</Text>

                            {/* 耳语私聊 */}
                            <View style={{ backgroundColor: '#09090b', padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#a78bfa' }}>
                                <TextInput
                                    style={{ color: '#fff' }}
                                    placeholder="输入耳语私聊..."
                                    placeholderTextColor="#666"
                                    value={whisperInput}
                                    onChangeText={setWhisperInput}
                                />
                                <TouchableOpacity style={{ marginTop: 8, alignSelf: 'flex-end', backgroundColor: '#a78bfa', paddingHorizontal: 15, paddingVertical: 6, borderRadius: 8 }} onPress={handleWhisper}>
                                    <Text style={{ color: '#000', fontWeight: 'bold', fontSize: 12 }}>🚀 秘密发送</Text>
                                </TouchableOpacity>
                            </View>

                            <Text style={[styles.tip, { marginTop: 10 }]}>快速投递表情:</Text>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
                                {['🚀', '💸', '📉', '🤡', '💎', '🔥', '🍺', '😭'].map(e => (
                                    <TouchableOpacity key={e} style={styles.emojiBtn} onPress={async () => {
                                        const db = getDb();
                                        await update(ref(db, `stock_rooms/${roomId}/players/${emojiTarget}/emoji`), { from: me, emoji: e, time: Date.now() });
                                        setEmojiVisible(false);
                                    }}>
                                        <Text style={{ fontSize: 24 }}>{e}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                            <Btn title="返回对局" onPress={() => setEmojiVisible(false)} kind="ghost" />
                        </View>
                    </View>
                </Modal>

                <Modal visible={chatVisible} animationType="slide" transparent>
                    <View style={styles.chatMask}>
                        <View style={styles.chatCard}>
                            <View style={styles.chatHeader}>
                                <Text style={styles.chatTitle}>对局聊天</Text>
                                <TouchableOpacity onPress={() => setChatVisible(false)}><Text style={{ color: '#fff' }}>关闭</Text></TouchableOpacity>
                            </View>
                            <ScrollView style={{ flex: 1 }}>
                                {messages.map((m, i) => (
                                    <Text key={i} style={{ color: m.name === me ? '#fbbf24' : '#fff', marginVertical: 4 }}>
                                        [{m.name}]: {m.text}
                                    </Text>
                                ))}
                            </ScrollView>
                            <View style={styles.chatInputRow}>
                                <TextInput style={styles.chatInput} value={chatInput} onChangeText={setChatInput} placeholder="输入消息..." />
                                <Btn title="发送" onPress={handleSendMessage} small />
                            </View>
                        </View>
                    </View>
                </Modal>
            </View>
        </KeyboardAvoidingView>
    );

    const renderGameOver = () => {
        return (
            <View style={styles.overInner}>
                <ThemedText type="title" style={styles.title}>赛季清算</ThemedText>
                <View style={styles.resultsCard}>
                    <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 400 }}>
                        {leaderboard.map((p, i) => (
                            <View key={p.id} style={styles.resultRow}>
                                <Text style={styles.resultRank}>{i + 1}</Text>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.resultName}>{p.name}{p.bankrupt ? " (已破产)" : ""}</Text>
                                </View>
                                <Text style={[styles.resultVal, { color: p.val >= 0 ? '#fbbf24' : '#ef4444' }]}>¥{Math.round(p.val).toLocaleString()}</Text>
                            </View>
                        ))}
                    </ScrollView>
                </View>
                <Btn title="退出对局" onPress={leaveRoom} kind="danger" />
                {isHost && <Btn title="再来一局" onPress={restartGame} style={{ marginTop: 15 }} />}
            </View>
        );
    };

    return (
        <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            {status === "waiting" && renderLobby()}
            {status === "borrowing" && renderBorrowing()}
            {status === "playing" && renderGame()}
            {status === "over" && renderGameOver()}

            <Modal transparent visible={helpVisible} animationType="fade">
                <View style={[styles.chatMask, { justifyContent: 'center', padding: 30 }]}>
                    <View style={styles.card}>
                        <Text style={styles.line}>炒股规则 (V7经济模型)</Text>
                        <ScrollView style={{ maxHeight: 300 }}>
                            <Text style={styles.tip}>
                                1. **行业联动**：12大行业存在阶梯影响（如：房地产涨 → 建筑涨 → 工业涨）。{"\n"}
                                2. **30s 熔断**：多人对局每回合限时30秒，超时将自动准备。{"\n"}
                                3. **T+1 结算**：套现资金下回合锁定后到账。{"\n"}
                                4. **破产逻辑**：净资产跌破借贷本息的 10% 强制出局。{"\n"}
                                5. **满员开赛**：多人模式需房间满员方可开启。
                            </Text>
                        </ScrollView>
                        <Btn title="已读" onPress={() => setHelpVisible(false)} kind="ghost" />
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: "#09090b" },
    bankruptBanner: { backgroundColor: '#ef4444', padding: 8, alignItems: 'center' },
    bankruptText: { color: '#fff', fontWeight: 'bold', fontSize: 12 },
    lobbyInner: { padding: 30, paddingBottom: 60 },
    gameInner: { flex: 1, paddingHorizontal: 20 },
    overInner: { flex: 1, padding: 30, justifyContent: 'center', alignItems: 'center' },

    title: { textAlign: 'center', marginBottom: 10, fontSize: 32, fontWeight: '900', color: '#fbbf24' },
    subtitle: { color: '#71717a', textAlign: 'center', marginBottom: 40, fontSize: 16 },

    card: { backgroundColor: "#18181b", padding: 25, borderRadius: 24, borderWidth: 1, borderColor: "#27272a", gap: 15 },
    line: { color: '#e4e4e7', fontSize: 18, fontWeight: '700' },
    hr: { height: 1, backgroundColor: '#27272a' },
    input: { backgroundColor: "#09090b", color: "#fff", padding: 15, borderRadius: 16, fontSize: 18, borderWidth: 1, borderColor: '#27272a' },
    playerTab: { flex: 1, padding: 12, borderRadius: 16, backgroundColor: '#27272a', alignItems: 'center' },
    playerTabActive: { backgroundColor: '#fbbf24' },
    playerTabText: { color: '#a1a1aa', fontWeight: '700' },
    playerTabTextActive: { color: '#09090b' },
    tip: { color: '#71717a', fontSize: 14, lineHeight: 22 },

    btn: { backgroundColor: "#fbbf24", padding: 18, borderRadius: 18, alignItems: 'center', minHeight: 56, justifyContent: 'center' },
    btnSmall: { padding: 12, paddingHorizontal: 20, minHeight: 44 },
    btnDanger: { backgroundColor: "#ef4444" },
    btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#27272a" },
    btnDis: { opacity: 0.3 },
    btnText: { color: "#09090b", fontWeight: "900", fontSize: 16 },
    btnTextGhost: { color: "#e4e4e7" },

    gameHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
    headerLabel: { color: '#fbbf24', fontSize: 12, fontWeight: '900' },
    balanceText: { color: '#fff', fontSize: 36, fontWeight: '900', marginVertical: 4 },
    cashRow: { flexDirection: 'row', alignItems: 'center' },
    mainCashChip: { backgroundColor: '#18181b', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#fbbf24' },
    mainCashText: { color: '#fbbf24', fontSize: 14, fontWeight: '800' },
    pendingText: { color: '#71717a', fontSize: 12, marginLeft: 10 },
    chatEntry: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#18181b', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#27272a' },

    eventCard: { backgroundColor: '#18181b', borderLeftWidth: 4, borderLeftColor: '#fbbf24', padding: 12, borderRadius: 12, marginBottom: 15 },
    eventTitle: { color: '#fbbf24', fontWeight: '800', fontSize: 12, marginBottom: 4 },
    eventMsg: { color: '#e4e4e7', fontSize: 13, lineHeight: 20 },

    stockScroll: { flex: 1, marginBottom: 15 },
    stockItem: { flexDirection: 'row', backgroundColor: '#18181b', padding: 16, borderRadius: 20, marginBottom: 10, borderWidth: 1, borderColor: '#27272a' },
    stockItemSelected: { borderColor: '#fbbf24', backgroundColor: '#27272a' },
    stockName: { color: '#fff', fontSize: 20, fontWeight: '800' },
    sectorTag: { backgroundColor: '#09090b', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    sectorTagText: { color: '#71717a', fontSize: 10, fontWeight: '800' },
    stockHoldings: { color: '#71717a', fontSize: 12, marginTop: 4 },
    stockPrice: { fontSize: 20, fontWeight: '900', textAlign: 'right' },

    tradePanel: { backgroundColor: '#18181b', padding: 20, borderRadius: 24, marginBottom: 15, gap: 12 },
    tradeTitle: { color: '#fff', fontWeight: '800', fontSize: 16, marginBottom: 5 },
    tradeRow: { flexDirection: 'row', gap: 10 },
    tradeInput: { flex: 1, backgroundColor: '#09090b', color: '#fff', padding: 12, borderRadius: 12, fontSize: 16, borderWidth: 1, borderColor: '#27272a' },

    footer: { gap: 10 },
    chatMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
    chatCard: { height: '50%', backgroundColor: '#18181b', borderTopLeftRadius: 30, borderTopRightRadius: 30, padding: 20, gap: 15 },
    chatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    chatTitle: { color: '#fbbf24', fontWeight: '900', fontSize: 18 },
    chatInputRow: { flexDirection: 'row', gap: 10 },
    chatInput: { flex: 1, backgroundColor: '#09090b', color: '#fff', padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#27272a' },

    resultsCard: { width: '100%', backgroundColor: '#18181b', borderRadius: 24, padding: 20, marginBottom: 30, borderWidth: 1, borderColor: '#27272a' },
    resultRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
    resultRank: { width: 35, color: '#fbbf24', fontSize: 24, fontWeight: '900' },
    resultName: { color: '#fff', fontSize: 18, fontWeight: '700' },
    resultVal: { fontSize: 18, fontWeight: '800' },

    // V8 Styles
    emojiToast: { position: 'absolute', top: 120, left: 20, right: 20, backgroundColor: 'rgba(251,191,36,0.9)', padding: 15, borderRadius: 12, alignItems: 'center', zIndex: 999 },
    emojiToastText: { color: '#000', fontWeight: '900', fontSize: 16 },
    emojiBtn: { width: 60, height: 60, backgroundColor: '#27272a', borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
    modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 16 },
});
