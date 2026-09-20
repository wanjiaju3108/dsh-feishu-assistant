/**
 * dsh-feishu-assistant — 串行任务队列。
 *
 * 先进先出，一次只跑一个任务：前一个任务 settle 之后才取下一个。用来把外部请求
 * （例如飞书消息）排成一条线，串行喂给同一条会话，避免多条消息同时往里塞。
 *
 * 某个任务抛错不会打断队列：错误照常抛给它自己的 Promise，后续任务继续跑。
 */

/**
 * 建一个串行队列。
 *
 * @returns 队列句柄：push 入队，size / busy 观察状态
 */
export function createQueue() {
  /** 等待执行的任务，FIFO。 */
  const pending = [];

  /** 是否有任务正在跑；保证同一时刻只有一条 drain 循环在取任务。 */
  let running = false;

  /** 逐个取出任务执行；每个任务 settle 之后才取下一个。 */
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length > 0) {
        const job = pending.shift();
        try {
          job.resolve(await job.task());
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    /**
     * 把任务排到队尾。
     *
     * @param task 无参任务，通常是 async 函数
     * @returns 该任务 settle 时 settle 的 Promise；调用方应自行 catch
     */
    push(task) {
      return new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        void drain();
      });
    },

    /** 还在排队、尚未开始的任务数，不含正在跑的那个。 */
    get size() {
      return pending.length;
    },

    /** 是否有任务正在跑。 */
    get busy() {
      return running;
    },
  };
}
