/**
 * 🛠 AIFF Header Patcher (Big-Endian)
 * AIFF stores numbers with the "High Byte" first.
 * We must patch the chunk sizes so the browser accepts partial downloads.
 */
class AiffHeaderPatcher {
    static patch(view, totalLength) {
        // 1. Patch 'FORM' chunk size (Total File Size - 8)
        // Offset 4, Big Endian (false)
        view.setUint32(4, totalLength - 8, false);

        // 2. Scan for 'SSND' (Sound Data) chunk to patch its size
        let offset = 12; // Skip FORM + Size + AIFF type
        
        while (offset < view.byteLength - 8) {
            const chunkId = this.getAscii(view, offset, 4);
            const chunkSize = view.getUint32(offset + 4, false); // Read Big Endian

            if (chunkId === "SSND") {
                // Found sound data! Update size to match what we have downloaded so far.
                // Size = Total buffer length - (current offset + 8 bytes for header)
                const availableAudioBytes = totalLength - (offset + 8);
                view.setUint32(offset + 4, availableAudioBytes, false); 
                break;
            }

            // Move to next chunk
            offset += 8 + chunkSize;
        }
    }

    static getAscii(view, offset, len) {
        let str = "";
        for (let i = 0; i < len; i++) str += String.fromCharCode(view.getUint8(offset + i));
        return str;
    }
}

/**
 * 🛠 WAV Header Patcher (Little-Endian)
 */
class WavHeaderPatcher {
    static patch(view, totalLength) {
        // RIFF Size (Offset 4, Little Endian)
        view.setUint32(4, totalLength - 8, true);

        // Scan for 'data' chunk
        let offset = 12;
        while (offset < view.byteLength - 8) {
            const chunkId = this.getAscii(view, offset, 4);
            if (chunkId === "data") {
                const availableBytes = totalLength - (offset + 8);
                view.setUint32(offset + 4, availableBytes, true);
                break;
            }
            const chunkSize = view.getUint32(offset + 4, true);
            offset += 8 + chunkSize;
        }
    }
    static getAscii(view, offset, len) {
        let str = "";
        for (let i = 0; i < len; i++) str += String.fromCharCode(view.getUint8(offset + i));
        return str;
    }
}

/**
 * 🎨 Visualizer (UI)
 */
class Visualizer {
    constructor(canvasId, onSeek) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext("2d");
        this.onSeek = onSeek;
        this.analyser = null;
        this.dataArray = null;
        this.animationId = null;
        this.duration = 0;
        
        this.resize();
        window.addEventListener("resize", () => this.resize());
        this.canvas.addEventListener("click", (e) => this.handleClick(e));
    }

    resize() {
        if (!this.canvas) return;
        this.canvas.width = this.canvas.clientWidth * window.devicePixelRatio;
        this.canvas.height = this.canvas.clientHeight * window.devicePixelRatio;
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }

    handleClick(e) {
        if (this.duration <= 0) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, x / rect.width));
        this.onSeek(pct * this.duration);
    }

    connect(analyser) {
        this.analyser = analyser;
        this.analyser.fftSize = 128;
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.startLoop();
    }

    updateTime(cur, total) {
        this.duration = total;
        const fmt = t => Math.floor(t/60) + ":" + Math.floor(t%60).toString().padStart(2,'0');
        document.getElementById("current-time").textContent = fmt(cur);
        document.getElementById("total-time").textContent = fmt(total);
        
        if (this.ctx && total > 0) {
            this.drawBars(); 
            const w = this.canvas.width / window.devicePixelRatio;
            const h = this.canvas.height / window.devicePixelRatio;
            const x = (cur / total) * w;
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, h);
            this.ctx.strokeStyle = '#f43f5e';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
        }
    }

    startLoop() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        const loop = () => {
            this.drawBars();
            this.animationId = requestAnimationFrame(loop);
        };
        loop();
    }

    drawBars() {
        if (!this.ctx || !this.analyser) return;
        const w = this.canvas.width / window.devicePixelRatio;
        const h = this.canvas.height / window.devicePixelRatio;
        this.analyser.getByteFrequencyData(this.dataArray);
        this.ctx.clearRect(0, 0, w, h);
        const barW = (w / this.dataArray.length) * 2.5;
        let x = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
            const barH = (this.dataArray[i] / 255) * h;
            this.ctx.fillStyle = `rgb(20, ${50 + (barH * 1.5)}, 180)`;
            this.ctx.fillRect(x, h - barH, barW, barH);
            x += barW + 1;
        }
    }
    
    stop() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
}

/**
 * 🔈 Base Player (Shared Logic)
 */
class BasePlayer {
    constructor() {
        this.audioCtx = null;
        this.analyser = null;
        this.activeSource = null;
        this.abortController = null;
        this.fullAudioBuffer = null;
        this.visualizer = null;
        this.isStopped = true;
        this.startTime = 0;
        this.playedOffset = 0;
    }

    init(visualizer) {
        this.visualizer = visualizer;
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.connect(this.audioCtx.destination);
            visualizer.connect(this.analyser);
        }
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    }

    stop() {
        this.isStopped = true;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        if (this.activeSource) {
            try { this.activeSource.stop(); } catch(e){}
            this.activeSource = null;
        }
        this.fullAudioBuffer = null;
        this.playedOffset = 0;
        if (this.audioCtx) this.audioCtx.close().catch(()=>{});
        this.audioCtx = null;
    }

    playSourceFrom(time) {
        if (this.isStopped || !this.fullAudioBuffer || !this.audioCtx) return;
        if (this.activeSource) {
            this.activeSource.onended = null;
            try { this.activeSource.stop(); } catch(e){}
        }

        const source = this.audioCtx.createBufferSource();
        source.buffer = this.fullAudioBuffer;
        source.connect(this.analyser);
        this.activeSource = source;
        this.startTime = this.audioCtx.currentTime;
        this.playedOffset = time;

        source.start(0, time);
        
        this.startVisualizerSync();

        source.onended = () => {
            if (this.isStopped) return;
            const playedDuration = this.audioCtx.currentTime - this.startTime;
            const currentPos = this.playedOffset + playedDuration;
            this.activeSource = null;
            this.playedOffset = currentPos;
        };
    }

    seek(time) {
        if (this.isStopped || !this.fullAudioBuffer) return;
        time = Math.max(0, Math.min(time, this.fullAudioBuffer.duration - 0.1));
        this.playSourceFrom(time);
    }

    startVisualizerSync() {
        const loop = () => {
            if (this.isStopped) return;
            if (this.activeSource && this.fullAudioBuffer && this.audioCtx) {
                const now = this.audioCtx.currentTime;
                let cur = this.playedOffset + (now - this.startTime);
                if (cur > this.fullAudioBuffer.duration) cur = this.fullAudioBuffer.duration;
                this.visualizer.updateTime(cur, this.fullAudioBuffer.duration);
            }
            requestAnimationFrame(loop);
        };
        loop();
    }
}

/**
 * 🌊 Dedicated AIFF Player
 */
class AiffPlayer extends BasePlayer {
    async play(url, onProgress) {
        this.isStopped = false;
        this.init(visualizer); // Use global visualizer ref or pass in
        this.abortController = new AbortController();

        try {
            const response = await fetch(url, { signal: this.abortController.signal });
            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length');
            
            let chunks = [];
            let bytesLoaded = 0;
            let lastUpdate = 0;

            onProgress(0, "0 MB", "Starting AIFF...");

            while (true) {
                const { done, value } = await reader.read();
                if (this.isStopped) return;
                if (done) break;

                chunks.push(value);
                bytesLoaded += value.length;

                onProgress((bytesLoaded/contentLength)*100, (bytesLoaded/1024/1024).toFixed(2) + " MB", "Buffering...");

                // Throttle updates
                if (Date.now() - lastUpdate > 800) { 
                    await this.processChunks(chunks, bytesLoaded, false);
                    lastUpdate = Date.now();
                }
            }
            await this.processChunks(chunks, bytesLoaded, true);
            onProgress(100, "Done", "Playing");
        } catch (e) {
            if (e.name !== "AbortError") console.error(e);
        }
    }

    async processChunks(chunks, size, isFinal) {
        if (this.isStopped) return;
        const fileData = new Uint8Array(size);
        let offset = 0;
        for (let c of chunks) { fileData.set(c, offset); offset += c.length; }

        // --- THE AIFF PATCH ---
        if (!isFinal) {
            const view = new DataView(fileData.buffer);
            // Patch using Big Endian logic
            AiffHeaderPatcher.patch(view, size);
        }

        try {
            const decoded = await this.audioCtx.decodeAudioData(fileData.buffer.slice(0));
            if (this.isStopped) return;
            this.fullAudioBuffer = decoded;
            if (!this.activeSource) this.playSourceFrom(this.playedOffset);
        } catch (e) {}
    }
}

/**
 * 🌊 Dedicated WAV Player
 */
class WavPlayer extends BasePlayer {
    async play(url, onProgress) {
        this.isStopped = false;
        this.init(visualizer);
        this.abortController = new AbortController();

        try {
            const response = await fetch(url, { signal: this.abortController.signal });
            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length');
            let chunks = [];
            let bytesLoaded = 0;
            let lastUpdate = 0;

            onProgress(0, "0 MB", "Starting WAV...");

            while (true) {
                const { done, value } = await reader.read();
                if (this.isStopped) return;
                if (done) break;

                chunks.push(value);
                bytesLoaded += value.length;
                onProgress((bytesLoaded/contentLength)*100, (bytesLoaded/1024/1024).toFixed(2) + " MB", "Buffering...");

                if (Date.now() - lastUpdate > 800) { 
                    await this.processChunks(chunks, bytesLoaded, false);
                    lastUpdate = Date.now();
                }
            }
            await this.processChunks(chunks, bytesLoaded, true);
            onProgress(100, "Done", "Playing");
        } catch (e) {
            if (e.name !== "AbortError") console.error(e);
        }
    }

    async processChunks(chunks, size, isFinal) {
        if (this.isStopped) return;
        const fileData = new Uint8Array(size);
        let offset = 0;
        for (let c of chunks) { fileData.set(c, offset); offset += c.length; }

        // --- THE WAV PATCH ---
        if (!isFinal) {
            const view = new DataView(fileData.buffer);
            WavHeaderPatcher.patch(view, size);
        }

        try {
            const decoded = await this.audioCtx.decodeAudioData(fileData.buffer.slice(0));
            if (this.isStopped) return;
            this.fullAudioBuffer = decoded;
            if (!this.activeSource) this.playSourceFrom(this.playedOffset);
        } catch (e) {}
    }
}

/**
 * 🎵 Generic Player (MP3/FLAC)
 */
class GenericPlayer extends BasePlayer {
    async play(url, onProgress) {
        this.isStopped = false;
        this.init(visualizer);
        this.abortController = new AbortController();

        try {
            const response = await fetch(url, { signal: this.abortController.signal });
            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length');
            let chunks = [];
            let bytesLoaded = 0;
            let lastUpdate = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (this.isStopped) return;
                if (done) break;

                chunks.push(value);
                bytesLoaded += value.length;
                onProgress((bytesLoaded/contentLength)*100, (bytesLoaded/1024/1024).toFixed(2) + " MB", "Buffering...");

                if (Date.now() - lastUpdate > 500) { 
                    await this.processChunks(chunks, bytesLoaded);
                    lastUpdate = Date.now();
                }
            }
            await this.processChunks(chunks, bytesLoaded);
            onProgress(100, "Done", "Playing");
        } catch (e) {
            if (e.name !== "AbortError") console.error(e);
        }
    }

    async processChunks(chunks, size) {
        if (this.isStopped) return;
        const fileData = new Uint8Array(size);
        let offset = 0;
        for (let c of chunks) { fileData.set(c, offset); offset += c.length; }

        try {
            const decoded = await this.audioCtx.decodeAudioData(fileData.buffer.slice(0));
            if (this.isStopped) return;
            this.fullAudioBuffer = decoded;
            if (!this.activeSource) this.playSourceFrom(this.playedOffset);
        } catch (e) {}
    }
}

/**
 * 🏭 Factory
 */
class PlayerFactory {
    static getPlayer(type) {
        switch (type) {
            case "AIFF": return new AiffPlayer();
            case "WAV": return new WavPlayer();
            default: return new GenericPlayer();
        }
    }
}

// --- SETUP & UI ---

// Redacted Data
const PLAYLIST = [
    { type: "AIFF", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.aiff?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0LmFpZmYiLCJpYXQiOjE3NjQ0MjY4OTUsImV4cCI6MTc2NDUxMzI5NX0.umFufQ8e-jgCtLXJbA4qDpVDeBZd6zNGU4OBXKsZ8J0" },
    { type: "FLAC", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample3.flac?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGUzLmZsYWMiLCJpYXQiOjE3NjQ0MjcwOTUsImV4cCI6MTc2NDUxMzQ5NX0.c6qaIX5TpLJIGQJ3HfLIH7e3brnC39lEUVpjYPbXqME" },
    { type: "WAV", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.wav?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0LndhdiIsImlhdCI6MTc2NDQyNzEwMywiZXhwIjoxNzY0NTEzNTAzfQ.T1lPytBbjr4owP8QBupX6dE-fJu5ae7KrHQ_PBDOP14" },
    { type: "MP3", url: "https://pdkkheetcdvnrsikdses.supabase.co/storage/v1/object/sign/user-files/ea12cfd6-0a51-42f4-9ad6-ba33fff1846f/sample4.mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84MTRmNzI0Yi1lYzI2LTQ4ZmUtYjk4ZS04Mjk1ZmYxYzBmMGMiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ1c2VyLWZpbGVzL2VhMTJjZmQ2LTBhNTEtNDJmNC05YWQ2LWJhMzNmZmYxODQ2Zi9zYW1wbGU0Lm1wMyIsImlhdCI6MTc2NDQyNzExMywiZXhwIjoxNzY0NTEzNTEzfQ.-GKeKpR6rky-mcH3fH72nzYl9sqMheb79di_4nKGT6o" }
];

const listEle = document.getElementById("music-list");
const stopBtn = document.getElementById("stop-btn");
const statusTxt = document.getElementById("status-text");
const bytesTxt = document.getElementById("bytes-loaded");

let currentPlayer = null;

const visualizer = new Visualizer("visualizer-canvas", (time) => {
    if (currentPlayer) currentPlayer.seek(time);
});

function stopAll() {
    if (currentPlayer) currentPlayer.stop();
    currentPlayer = null;
    visualizer.stop();
    visualizer.updateTime(0, 0);
    stopBtn.disabled = true;
    statusTxt.textContent = "Stopped";
}

stopBtn.onclick = stopAll;

PLAYLIST.forEach((track, i) => {
    const btn = document.createElement("button");
    btn.className = "text-left w-full p-3 bg-slate-700 hover:bg-slate-600 rounded flex justify-between items-center group transition-all mb-2 border border-slate-600";
    btn.innerHTML = `
        <span class="text-teal-400 font-bold group-hover:text-white">Track ${i+1}</span>
        <span class="text-xs bg-slate-800 px-2 py-1 rounded text-slate-400">${track.type}</span>
    `;
    
    btn.onclick = () => {
        stopAll();
        stopBtn.disabled = false;
        
        currentPlayer = PlayerFactory.getPlayer(track.type);
        currentPlayer.play(track.url, (pct, size, status) => {
             statusTxt.textContent = status;
             bytesTxt.textContent = size;
        });
    };
    listEle.appendChild(btn);
});