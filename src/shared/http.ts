import type http from "node:http";

/** Rejection from `readBody` when a request body is over its limit; answer it with 413. */
export class BodyTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body larger than ${maxBytes} bytes`);
  }
}

/**
 * Buffer a request body of at most `maxBytes`. Past the limit it stops buffering
 * but keeps reading (and discarding) the rest, instead of destroying the socket,
 * so the caller can still send the client a 413 it will actually receive.
 */
export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    req.on("error", reject);
    if (Number(req.headers["content-length"]) > maxBytes) {
      req.resume();
      reject(new BodyTooLarge(maxBytes));
      return;
    }
    let size = 0;
    let chunks: Buffer[] | null = [];
    req.on("data", (chunk: Buffer) => {
      if (!chunks) return;
      size += chunk.length;
      if (size > maxBytes) {
        chunks = null;
        reject(new BodyTooLarge(maxBytes));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (chunks) resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
