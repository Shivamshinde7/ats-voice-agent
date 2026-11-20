import { buildSttKeyterms, connectSarvamStt, sendSarvamAudio } from './sarvam-stt.service.js';

export class SarvamSTTService {
    constructor(config) {
        this.config = config;
    }

    connect(context) {
        const keyterms = this.config.sttModel === 'saaras:v4'
            ? buildSttKeyterms(context)
            : [];
        return connectSarvamStt(this.config, keyterms);
    }

    sendAudio(socket, base64Audio) {
        sendSarvamAudio(socket, base64Audio);
    }

    keepAlive(socket) {
        if (socket.readyState === 1 && typeof socket.ping === 'function') {
            socket.ping();
        }
    }

    end(socket) {
        if (socket.readyState === 1) {
            socket.send(JSON.stringify({ event: 'end' }));
        }
    }

    close(socket) {
        socket?.close();
    }
}
