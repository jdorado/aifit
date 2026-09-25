type Write = {
  run: () => Promise<void>
  rollback: () => void
  onError: (error: unknown) => void
}

type PendingWrite = Write & { resolve: (saved: boolean) => void }

// Each workout has one revision. Paint locally first, then persist edits in
// tap order. A failed write cancels its dependants and unwinds their previews
// in reverse order (important for log -> undo -> log on the same set).
export class WorkoutWriteQueue {
  private queues = new Map<string, PendingWrite[]>()

  enqueue(key: string, write: Write): Promise<boolean> {
    return new Promise((resolve) => {
      const pending = { ...write, resolve }
      const queue = this.queues.get(key)
      if (queue) {
        queue.push(pending)
      } else {
        const jobs = [pending]
        this.queues.set(key, jobs)
        void this.drain(key, jobs)
      }
    })
  }

  private async drain(key: string, jobs: PendingWrite[]) {
    while (jobs.length) {
      const job = jobs[0]
      try {
        await job.run()
      } catch (error) {
        this.queues.delete(key)
        for (const pending of [...jobs].reverse()) pending.rollback()
        job.onError(error)
        for (const pending of jobs) pending.resolve(false)
        return
      }
      jobs.shift()
      if (!jobs.length) this.queues.delete(key)
      job.resolve(true)
    }
  }
}
