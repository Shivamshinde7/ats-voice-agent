import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class BrowserProvider {
    constructor(config) {
        this.config = config;
        this.server = null;
    }

    async start() {
        const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../local-test/server.js');
        const browserServer = await import(pathToFileURL(modulePath).href);
        this.server = browserServer.server;

        if (!this.server?.listening) {
            await once(this.server, 'listening');
        }
        if (!this.server?.listening) {
            throw new Error('Browser test provider failed to start.');
        }

        return this.server;
    }

    async stop() {
        if (!this.server?.listening) {
            return;
        }
        await new Promise((resolve, reject) => {
            this.server.close((error) => error ? reject(error) : resolve());
        });
    }
}
