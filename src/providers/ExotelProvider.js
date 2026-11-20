import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ExotelProvider {
    constructor(config) {
        this.config = config;
        this.server = null;
    }

    async start() {
        if (!this.config.exotel.enabled) {
            throw new Error(
                'Exotel AgentStream mode is pending configuration. Keep VOICE_PROVIDER=browser until Exotel callbacks, credentials, and account settings have been verified.',
            );
        }

        const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'exotel-server.js');
        const exotelServer = await import(pathToFileURL(modulePath).href);
        this.server = exotelServer.server;

        if (!this.server?.listening) {
            throw new Error('Exotel AgentStream provider failed to start.');
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
