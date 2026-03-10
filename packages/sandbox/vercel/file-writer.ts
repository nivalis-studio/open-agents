import { Readable } from "stream";
import tar, { type Pack } from "tar-stream";
import zlib from "zlib";

interface FileBuffer {
  name: string;
  content: Buffer;
}

interface FileStream {
  name: string;
  content: Readable;
  size: number;
}

export class FileWriter {
  public readable: Readable;
  private pack: Pack;

  constructor() {
    const gzip = zlib.createGzip();
    this.pack = tar.pack();
    this.readable = this.pack.pipe(gzip);
  }

  async addFile(file: FileBuffer | FileStream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry = this.pack.entry(
        "size" in file
          ? { name: file.name, size: file.size }
          : { name: file.name, size: file.content.length },
        (error: unknown) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        },
      );

      if (file.content instanceof Readable) {
        file.content.pipe(entry);
        return;
      }

      entry.end(file.content);
    });
  }

  async end(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readable.on("error", reject);
      this.readable.on("end", resolve);
      this.pack.finalize();
    });
  }
}

export async function consumeReadable(
  readable: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    readable.on("error", (error) => {
      reject(error);
    });

    readable.on("data", (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }

      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
        return;
      }

      chunks.push(Buffer.from(chunk));
    });

    readable.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });
}
