import './load-env.js';
import { loadConfig } from './config/env.js';
import { BrowserProvider } from './providers/BrowserProvider.js';
import { ExotelProvider } from './providers/ExotelProvider.js';

const config = loadConfig();
const provider = config.voiceProvider === 'browser'
    ? new BrowserProvider(config)
    : config.voiceProvider === 'exotel'
        ? new ExotelProvider(config)
        : null;

if (!provider) {
    throw new Error('VOICE_PROVIDER must be either browser or exotel.');
}

await provider.start();
if (config.exotel.enabled && config.voiceProvider !== 'exotel') {
    await new ExotelProvider(config).start();
}
