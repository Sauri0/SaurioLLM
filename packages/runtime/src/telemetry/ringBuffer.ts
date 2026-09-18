// RingBuffer<T>: buffer circular en memoria para series recientes — packages/runtime/src/telemetry/ringBuffer.ts.
// Define: doc 14 §espacio de nombres ("MetricsAggregator, Diagnostics, ringBuffer.ts"). Sin tabla
// SQL asociada (metrics_minute con retención de 30 días es v0.2, doc 14 "Previsto para más
// adelante"); en el MVP el histórico vive solo en memoria del proceso, por eso un ring buffer.
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private start = 0;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingBuffer requiere capacity > 0');
  }

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
  }

  /** Del más antiguo al más reciente. */
  toArray(): T[] {
    if (this.items.length < this.capacity) return [...this.items];
    return [...this.items.slice(this.start), ...this.items.slice(0, this.start)];
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.start = 0;
  }
}
