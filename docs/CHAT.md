# 聊天系统（Chat）接入指南

本文档描述聊天系统的公共能力与接入方式。

## 模块位置

- `utils/chat.ts`

## 功能概览

- 发送文本消息
- 订阅最新消息列表
- 清空房间消息

## 数据结构

- `messages/<messageId>`
  - `userId`: 发送者标识
  - `text`: 文本内容
  - `createdAt`: 时间戳（毫秒）
  - `name`（可选）: 昵称

## API 说明

### sendChatMessage(path, roomId, message)

发送一条文本消息，并更新房间 `lastActive`。

参数：
- `path`: 聊天集合路径前缀（建议 `roomChats` 或 `chatRooms`）。
- `roomId`: 房间号。
- `message`: 消息对象（必须包含 `userId`、`text`，可选 `name`、`createdAt`）。

返回：
- `string`: 成功返回消息 id，失败返回空字符串。

使用方式：
- `createdAt` 为空时会自动填充为当前时间。

示例：
```ts
import { sendChatMessage } from '@/utils/chat';

await sendChatMessage('roomChats', roomId, {
  userId: me,
  name: myName,
  text: inputText,
});
```

### subscribeChatMessages(path, roomId, limit, cb)

订阅房间最新消息列表（按时间升序）。

参数：
- `path`: 聊天集合路径前缀。
- `roomId`: 房间号。
- `limit`: 最大消息数量。
- `cb`: 回调函数，收到消息数组。

返回：
- `() => void | null`: 取消订阅函数，失败返回 `null`。

使用方式：
- 回调会收到已排序的消息数组（按 `createdAt`）。

示例：
```ts
import { subscribeChatMessages } from '@/utils/chat';

const unsub = subscribeChatMessages('roomChats', roomId, 100, (msgs) => {
  setMessages(msgs);
});

return () => {
  unsub?.();
};
```

### clearChatMessages(path, roomId)

清空房间全部聊天消息。

参数：
- `path`: 聊天集合路径前缀。
- `roomId`: 房间号。

返回：
- `Promise<void>`。

示例：
```ts
import { clearChatMessages } from '@/utils/chat';

await clearChatMessages('roomChats', roomId);
```

## 接入流程（简版）

1. 选定聊天集合路径（例如 `roomChats`）
2. 在房间页初始化消息订阅
3. 输入框提交时调用 sendChatMessage
4. 需要清空时调用 clearChatMessages
