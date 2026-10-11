// SSE events may span arbitrary network chunks, including the middle of UTF-8
// characters or CRLF. Keep both the decoder and unfinished line across reads.
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let eventSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error('SSE line too large');
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
          if (data.length) yield data.join('\n');
          data = [];
          eventSize = 0;
        } else if (line === 'data' || line.startsWith('data:')) {
          const content =
            line === 'data' ? '' : line.slice(5).replace(/^ /, '');
          eventSize += content.length;
          if (eventSize > 1_048_576) throw new Error('SSE event too large');
          data.push(content);
        }
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
