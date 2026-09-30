/**
 * Keeps the last `limit` bytes of a subprocess's output (never fewer than the
 * newest chunk), so a failure message can quote the end of the run without
 * holding a whole test log in memory.
 */
export class OutputTail {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private readonly limit: number;

  constructor(limit = 8 * 1024) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.chunks.length > 1 && this.bytes > this.limit) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
