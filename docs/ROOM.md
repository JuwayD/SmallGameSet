# 房间系统（Room）接入指南

本文档描述房间系统的公共能力与接入方式。

## 模块位置

- `utils/room.ts`

## 功能概览

- 生成房间号并降低并发碰撞
- 创建房间并合并自定义数据
- 订阅房间数据变化
- 在线/离线状态维护
- 争抢/占用玩家位
- 房间活跃时间刷新
- 无人时自动清理

## API 说明

### generateRoomId(path, tries?)

生成 4 位房间号，内部使用共享计数器 `roomCounters/<path>` 递增，降低并发碰撞。生成后会检查该 id 是否已存在，存在则继续尝试。

参数：
- `path`:房间集合路径前缀，例如 `rooms`、`mineRooms`。
- `tries`（可选）:最大尝试次数，默认 200。

返回：
- `string`:成功返回 4 位房间号（如 `1234`），失败返回空字符串。

使用方式：
- `path` 会被映射为计数器键（非字母数字字符会被 `_` 替换）。

示例：
```ts
import { generateRoomId } from '@/utils/room';

const id = await generateRoomId('rooms');
if (!id) throw new Error('房间号生成失败');
```

### createRoom(path, base, extra?)

创建房间记录并合并自定义数据。内部会先调用 `generateRoomId` 生成 id，然后将 `base` 与 `extra` 合并写入。

参数：
- `path`:房间集合路径前缀。
- `base`:房间基础结构（必填）。
- `extra`（可选）:自定义扩展字段（默认 `{}`）。

返回：
- `string`:成功返回房间号，失败返回空字符串。

使用方式：
- `base` 建议包含统一字段：`status` / `createdAt` / `lastActive` / `players`。
- `extra` 用于存放游戏自定义数据（例如 `gridWidth`、`hitScore`）。

示例：
```ts
import { createRoom } from '@/utils/room';

const base = {
  status: 'setup',
  createdAt: Date.now(),
  lastActive: Date.now(),
  players: { A: { left: false }, B: { left: true } },
};

const extra = {
  mode: 'pk',
  gridWidth: 8,
  gridHeight: 8,
};

const id = await createRoom('mineRooms', base, extra);
if (!id) throw new Error('创建失败');
```

### subscribeRoom(path, roomId, cb)

订阅房间数据变化，底层使用 `onValue`，每次变更都会触发回调。

参数：
- `path`:房间集合路径前缀。
- `roomId`:房间号。
- `cb`:回调函数，参数是房间数据（可能为 `null`）。

返回：
- `() => void | null`:取消订阅函数；如果 db 不可用或参数不完整则返回 `null`。

使用方式：
- 当房间被删除时，`cb` 会收到 `null`。

示例：
```ts
import { subscribeRoom } from '@/utils/room';

const unsub = subscribeRoom('rooms', roomId, (room) => {
  if (!room) {
    setRoom(null);
    return;
  }
  setRoom(room);
});

return () => {
  unsub?.();
};
```

### setupPresence(path, roomId, playerKey, onlinePayload, offlinePayload)

处理玩家在线/离线状态，调用 `onDisconnect` 在断线时写入离线字段。

参数：
- `path`:房间集合路径前缀。
- `roomId`:房间号。
- `playerKey`:玩家位（如 `A`/`B`、`host`/`player`）。
- `onlinePayload`:在线时写入的数据。
- `offlinePayload`:断线时写入的数据。

返回：
- `OnDisconnect | null`:句柄，用于页面卸载时 `cancel()`。

使用方式：
- 通常在 `useEffect` 中注册，结束时取消。

示例：
```ts
import { setupPresence } from '@/utils/room';

const handler = setupPresence('rooms', roomId, me, { left: false }, { left: true });
return () => {
  handler?.cancel();
};
```

### claimPlayer(path, roomId, playerKey, payload)

使用事务原子占位，避免两个玩家同时进入同一位置。

参数：
- `path`:房间集合路径前缀。
- `roomId`:房间号。
- `playerKey`:玩家位（如 `A`/`B`、`host`/`player`）。
- `payload`:成功占位时写入的数据。

返回：
- `boolean`:成功占位返回 `true`，否则 `false`。

使用方式：
- 当玩家位 `left === false` 时，视为已被占用，不会覆盖。

示例：
```ts
import { claimPlayer } from '@/utils/room';

const ok = await claimPlayer('rooms', roomId, 'B', { left: false, joinedAt: Date.now() });
if (!ok) alert('玩家位已被占用');
```

### touchRoom(path, roomId)

刷新房间 `lastActive`，用于后台清理与活跃判断。

参数：
- `path`:房间集合路径前缀。
- `roomId`:房间号。

返回：
- `Promise<void>`。

使用方式：
- 可在心跳定时器里调用。

示例：
```ts
import { touchRoom } from '@/utils/room';

await touchRoom('rooms', roomId);
```

### cleanupIfAllLeft(path, roomId, playerKeys)

当指定玩家位全部 `left === true` 时删除房间。

参数：
- `path`:房间集合路径前缀。
- `roomId`:房间号。
- `playerKeys`:需要检查的玩家位数组。

返回：
- `boolean`:已删除或房间不存在返回 `true`，否则 `false`。

使用方式：
- 一般在房间监听或离开逻辑中调用。

示例：
```ts
import { cleanupIfAllLeft } from '@/utils/room';

await cleanupIfAllLeft('rooms', roomId, ['A', 'B']);
```

## 接入流程（简版）

1. 设计房间结构（基础字段 + 自定义字段）
2. createRoom 创建房间（extra 放自定义字段）
3. claimPlayer 抢占玩家位
4. subscribeRoom/onValue 订阅房间
5. setupPresence 处理在线/离线
6. cleanupIfAllLeft 无人时清理

## 参考实现

- 猜数字：`app/guess-number.tsx`
- 猜地雷：`app/mine-guess.tsx`
