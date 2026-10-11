// Browser ES module: POST + Bearer Token + SSE. No EventSource dependency.
export async function sendMessage({
  base = '/api',
  token,
  conversationId,
  content,
  signal,
  onStart = () => {},
  onDelta = () => {},
  onDone = () => {},
}) {
  const response = await fetch(
    `${base}/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content }),
      signal,
    },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `聊天请求失败：${response.status}`);
  }
  if (
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    throw new Error('服务器没有返回 SSE 响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let data = [];
  let reply = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      while (true) {
        const position = buffer.search(/[\r\n]/);
        if (position === -1) break;
        if (
          !done &&
          buffer[position] === '\r' &&
          position === buffer.length - 1
        )
          break;
        const line = buffer.slice(0, position);
        const width = buffer.slice(position, position + 2) === '\r\n' ? 2 : 1;
        buffer = buffer.slice(position + width);
        if (line === '') {
          if (data.length) {
            const payload = JSON.parse(data.join('\n'));
            if (eventName === 'start') onStart(payload);
            if (eventName === 'delta') {
              reply += payload.text;
              onDelta(payload.text, reply);
            }
            if (eventName === 'error') throw new Error(payload.message);
            if (eventName === 'done') {
              onDone(payload, reply);
              return { ...payload, content: reply };
            }
          }
          eventName = 'message';
          data = [];
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).replace(/^ /, '');
        } else if (line === 'data' || line.startsWith('data:')) {
          data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) throw new Error('连接提前结束，请刷新历史消息确认回复状态');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
