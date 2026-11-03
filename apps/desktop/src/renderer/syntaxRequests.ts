import type { SyntaxDocument, SyntaxResponse, SyntaxResults } from "./syntaxTypes";

type Job = { id: number; key: string; documents: SyntaxDocument[]; listeners: Set<(result: SyntaxResults | null) => void> };

/** One worker and a bounded cache for every code surface in the window. */
export class SyntaxRequests {
  private worker?: Worker;
  private jobs = new Map<string, Job>();
  private cache = new Map<string, SyntaxResults>();
  private cacheCharacters = 0;
  private active?: Job;
  private nextId = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(private createWorker: () => Worker) {}

  request(documents: SyntaxDocument[]) {
    const key = JSON.stringify(documents);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key); this.cache.set(key, cached);
      return { promise: Promise.resolve(cached), cancel() {} };
    }
    if (!documents.length || key.length > 600_000) return { promise: Promise.resolve(null), cancel() {} };
    let job = this.jobs.get(key);
    if (!job) { job = { id: ++this.nextId, key, documents, listeners: new Set() }; this.jobs.set(key, job); }
    let resolve!: (result: SyntaxResults | null) => void;
    const promise = new Promise<SyntaxResults | null>(done => { resolve = done; });
    job.listeners.add(resolve);
    const subscription = job;
    this.pump();
    return { promise, cancel: () => {
      subscription.listeners.delete(resolve); resolve(null);
      if (!subscription.listeners.size && subscription !== this.active && this.jobs.get(key) === subscription) this.jobs.delete(key);
    } };
  }

  private pump() {
    if (this.active || !this.jobs.size) return;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = (event: MessageEvent<SyntaxResponse>) => {
          if (!this.active || event.data.id !== this.active.id) return;
          clearTimeout(this.timeout);
          const job = this.active;
          if (job.listeners.size && event.data.results.some(Boolean)) {
            this.cache.set(job.key, event.data.results); this.cacheCharacters += job.key.length;
            while (this.cache.size > 16 || this.cacheCharacters > 600_000) {
              const oldest = this.cache.keys().next().value!;
              this.cacheCharacters -= oldest.length; this.cache.delete(oldest);
            }
          }
          this.jobs.delete(job.key); this.active = undefined;
          job.listeners.forEach(resolve => resolve(event.data.results));
          this.pump();
        };
        this.worker.onerror = () => this.fail();
        this.worker.onmessageerror = () => this.fail();
      }
      this.active = this.jobs.values().next().value;
      this.timeout = setTimeout(() => this.fail(), 20_000);
      this.worker.postMessage({ id: this.active!.id, documents: this.active!.documents });
    } catch { this.fail(); }
  }

  private fail() {
    clearTimeout(this.timeout); this.worker?.terminate(); this.worker = undefined; this.active = undefined;
    this.jobs.forEach(job => job.listeners.forEach(resolve => resolve(null))); this.jobs.clear();
  }
}
