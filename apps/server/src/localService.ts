import type { ChildProcess } from 'node:child_process';

export interface LocalServiceOptions {
    /** Short name for log lines. */
    name: string;
    /** True when the service answers on its port. */
    up: () => Promise<boolean>;
    /** Starts the service process. */
    spawn: () => ChildProcess;
    /** How many half-second waits a freshly started service gets to come up. */
    attempts: number;
    /** Logged when the service does not come up. */
    failed: string;
    wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A local HTTP helper (voice, speech recognition) kept warm beside the server. A service already answering on the
 * port is used as it is: a restarted dev server can find the previous one still running, and a second one could
 * not take the port.
 */
export class LocalService {
    private child: ChildProcess | null = null;
    private ready: Promise<boolean>;

    constructor(private options: LocalServiceOptions) {
        this.ready = this.bring();
    }

    /** Runs a request against the service; null when it is unavailable. A service that went away is started again once. */
    async call<T>(request: () => Promise<T>): Promise<T | null> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const ready = this.ready;
            if (!(await ready)) {
                return null;
            }
            try {
                return await request();
            } catch (e) {
                if (attempt > 0 || (await this.options.up())) {
                    console.error(`[${this.options.name}] request failed`, e);
                    return null;
                }
                // Another call may have started it again already.
                if (this.ready === ready) {
                    this.ready = this.bring();
                }
            }
        }
        return null;
    }

    /** Stops the process this server started; one it found running is left alone. */
    close(): void {
        this.child?.kill();
    }

    private async bring(): Promise<boolean> {
        const { up, spawn, attempts, failed, wait = sleep } = this.options;
        if (await up()) {
            return true;
        }
        const child = spawn();
        this.child = child;
        let running = true;
        const gone = () => {
            running = false;
            if (this.child === child) {
                this.child = null;
            }
        };
        child.on('exit', gone);
        child.on('error', gone);
        for (let attempt = 0; attempt < attempts && running; attempt++) {
            await wait(500);
            if (await up()) {
                return true;
            }
        }
        console.warn(`[${this.options.name}] ${failed}`);
        return false;
    }
}
