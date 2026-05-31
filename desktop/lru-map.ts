export class LruMap<K, V> {
  private map = new Map<K, V>();
  readonly maxSize: number;

  constructor(maxSize: number) {
    if (maxSize < 1) throw new Error("maxSize must be at least 1");
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to most recently used by deleting and re-inserting
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const lruEntry = this.map.keys().next();
      if (!lruEntry.done) {
        this.map.delete(lruEntry.value);
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
